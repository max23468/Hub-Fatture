import {
  containsNullByte,
  escapeLike,
  PAGE_SIZE,
  pageOffset,
  paginate,
  postgresDateSchema,
} from "../orders.ts";
import { getConfig } from "../config.server.ts";
import { auditActions } from "./audit.server.ts";
import { getPool } from "./client.server.ts";
import { pendingPaymentSql } from "./billing-case-sql.server.ts";
import { isDatabaseId } from "./database-id.ts";

type SortDirection = "asc" | "desc";

export type OpenActivitySortKey =
  | "elemento"
  | "cliente"
  | "identificativo"
  | "tipo"
  | "data"
  | "aggiornamento";

export type AuditHistorySortKey = "attivita" | "elemento" | "autore" | "quando";
export type OrderListSortKey = "ordine" | "cliente" | "data" | "totale" | "stato" | "preparazione";

const openActivitySortSql: Record<OpenActivitySortKey, string> = {
  elemento: "coalesce(activities.case_number, activities.order_number, activities.id)",
  cliente: "coalesce(invoice_customer.snapshot ->> 'displayName', activities.customer_name)",
  identificativo: "customer_tax_id.value",
  tipo: "coalesce(activities.error_code, activities.provider, activities.kind)",
  data: "activities.order_date",
  aggiornamento: "activities.created_at",
};

const auditHistorySortSql: Record<AuditHistorySortKey, string> = {
  attivita: "audit_events.action",
  elemento:
    "coalesce(event_cases.public_number, event_orders.display_number, event_refund_orders.display_number, audit_events.entity_id)",
  autore: "coalesce(users.username, audit_events.actor_type)",
  quando: "audit_events.created_at",
};

const orderListSortSql: Record<OrderListSortKey, string> = {
  ordine: "orders.display_number",
  cliente: "orders.normalized_snapshot_json #>> '{customerSnapshot,displayName}'",
  data: "orders.local_order_date",
  totale: "orders.gross_amount",
  stato: "orders.trigger_status",
  preparazione: "billing_cases.public_number",
};

function sqlDirection(direction: SortDirection) {
  return direction === "asc" ? "ASC" : "DESC";
}

interface SourceCustomer {
  kind?: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  email?: string;
  certifiedEmail?: string;
  billingAddress?: Record<string, string | undefined>;
  shippingAddress?: Record<string, string | undefined>;
  taxIdentifiers?: Array<{ type?: string; value?: string; sourceField?: string }>;
}

interface OrderDetailRow {
  id: string;
  provider: string;
  display_number: string;
  local_order_date: string;
  gross_amount: number;
  shopify_payments_fee_amount: number;
  deducted_shopify_payments_fee_amount: number;
  billable_amount: number;
  payment_status: string;
  fulfillment_status: string;
  trigger_status: string;
  historical_reconciliation_outcome: "ALREADY_INVOICED" | "NOT_INVOICED" | null;
  historical_reconciliation_reference: string | null;
  historical_reconciled_at: string | null;
  historical_invoice_id: string | null;
  billing_case_id: string | null;
  case_number: string | null;
  customer_name: string;
  customer_kind: string;
  customer_email: string | null;
  billing_address_json: Record<string, string | undefined>;
  source_confidence: string;
  review_required: boolean;
  raw_snapshot_json: {
    customer?: SourceCustomer;
    localizedFields?: Array<{ key?: string; title?: string; value?: string }>;
    sourceSnapshot?: Record<string, unknown>;
  };
  lines: Array<{
    id: string;
    description: string;
    quantity: number;
    gross_amount: number;
    discount_amount: number;
  }>;
  taxIdentifiers: Array<{
    id: string;
    type: string;
    country_code: string | null;
    raw_value: string;
  }>;
  payments: Array<{
    id: string;
    method: string;
    status: string;
    amount: number;
    shopify_payments_fee_amount: number;
    paid_at: string | null;
    recorded_manually: boolean;
  }>;
  refunds: Array<{
    id: string;
    provider: string;
    external_account_id: string;
    external_order_id: string;
    external_refund_id: string;
    status: string;
    amount: number | null;
    completed_at: string | null;
  }>;
  possibleMatches: Array<{
    id: string;
    display_name: string;
    email: string | null;
    tax_id_type: string | null;
    tax_id_normalized: string | null;
  }>;
}

export async function listOrders(filters: {
  query?: string;
  provider?: string;
  status?: string;
  localDate?: string;
  paymentStatus?: string;
  page?: unknown;
  sort?: { key: OrderListSortKey; direction: SortDirection };
}) {
  const empty = { rows: [] as never[], hasNext: false };
  if (containsNullByte(filters)) return empty;
  if (filters.localDate && !postgresDateSchema.safeParse(filters.localDate).success) return empty;
  const values = [
    filters.query ? `%${escapeLike(filters.query)}%` : null,
    filters.provider || null,
    filters.status || null,
    filters.localDate || null,
    filters.paymentStatus || null,
    pageOffset(filters.page),
  ];
  const sort = filters.sort ?? { key: "data", direction: "desc" };
  const orderBy = orderListSortSql[sort.key];
  const direction = sqlDirection(sort.direction);
  // Colonna e direzione provengono esclusivamente dalle allowlist di modulo;
  // i valori della richiesta restano nei parametri $1-$6.
  // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk
  const result = await getPool().query<{
    id: string;
    provider: string;
    display_number: string;
    local_order_date: string;
    gross_amount: number;
    payment_status: string;
    fulfillment_status: string;
    trigger_status: string;
    customer_name: string;
    billing_case_id: string | null;
    case_number: string | null;
  }>(
    `SELECT orders.id, orders.provider, orders.display_number, orders.local_order_date::text,
            orders.gross_amount, orders.payment_status, orders.fulfillment_status,
            orders.trigger_status,
            orders.normalized_snapshot_json #>> '{customerSnapshot,displayName}' AS customer_name,
            billing_cases.id AS billing_case_id, billing_cases.public_number AS case_number
     FROM orders
     LEFT JOIN billing_cases ON billing_cases.id = orders.billing_case_id
     WHERE ($1::text IS NULL OR orders.display_number ILIKE $1
            OR orders.external_order_id ILIKE $1
            OR orders.normalized_snapshot_json #>> '{customerSnapshot,displayName}' ILIKE $1
            OR orders.normalized_snapshot_json #>> '{customerSnapshot,email}' ILIKE $1
            OR EXISTS (SELECT 1 FROM order_tax_identifiers
                       WHERE order_tax_identifiers.order_id = orders.id
                         AND (order_tax_identifiers.normalized_value ILIKE $1
                              OR order_tax_identifiers.raw_value ILIKE $1)))
       AND ($2::text IS NULL OR orders.provider = $2)
       AND ($3::text IS NULL
            OR ($3 = 'ACTIVE' AND orders.trigger_status NOT IN
                ('CANCELLED_NO_DOCUMENT', 'REFUNDED_BEFORE_ISSUE'))
            OR ($3 = 'NO_DOCUMENT' AND orders.trigger_status IN
                ('CANCELLED_NO_DOCUMENT', 'REFUNDED_BEFORE_ISSUE'))
            OR ($3 = 'LEGACY_BILLING_REVIEW' AND (
              orders.trigger_status = 'LEGACY_BILLING_REVIEW'
              OR (orders.historical_reconciliation_outcome = 'ALREADY_INVOICED'
                AND NOT EXISTS (
                  SELECT 1 FROM document_orders
                  JOIN documents ON documents.id = document_orders.document_id
                  WHERE document_orders.order_id = orders.id
                    AND documents.origin = 'ARUBA_HISTORY'
                ))
            ))
            OR orders.trigger_status = $3)
       AND ($4::date IS NULL OR orders.local_order_date = $4)
       AND ($5::text IS NULL
            OR ($5 = 'PENDING' AND ${pendingPaymentSql()})
            OR ($5 <> 'PENDING' AND orders.payment_status = $5))
     ORDER BY ${orderBy} ${direction} NULLS LAST,
              orders.local_order_date DESC, orders.id DESC
     LIMIT ${PAGE_SIZE + 1} OFFSET $6`,
    values,
  );
  return paginate(result.rows);
}

export async function getOrder(id: string) {
  if (!isDatabaseId(id)) return null;
  const order = await getPool().query<OrderDetailRow>(
    `SELECT orders.*, orders.local_order_date::text,
            orders.normalized_snapshot_json #>> '{customerSnapshot,displayName}' AS customer_name,
            orders.normalized_snapshot_json #>> '{customerSnapshot,kind}' AS customer_kind,
            orders.normalized_snapshot_json #>> '{customerSnapshot,email}' AS customer_email,
            orders.normalized_snapshot_json #> '{customerSnapshot,billingAddress}' AS billing_address_json,
            orders.normalized_snapshot_json #>> '{customerSnapshot,sourceConfidence}' AS source_confidence,
            (orders.normalized_snapshot_json ->> 'customerReviewRequired')::boolean AS review_required,
            billing_cases.public_number AS case_number,
            (SELECT document_orders.document_id::text
             FROM document_orders JOIN documents ON documents.id = document_orders.document_id
             WHERE document_orders.order_id = orders.id
               AND document_orders.document_kind = 'INVOICE'
               AND documents.origin = 'ARUBA_HISTORY' LIMIT 1) AS historical_invoice_id,
            coalesce((
              SELECT jsonb_agg(to_jsonb(order_lines) ORDER BY order_lines.id)
              FROM order_lines WHERE order_lines.order_id = orders.id
            ), '[]'::jsonb) AS lines,
            coalesce((
              SELECT jsonb_agg(to_jsonb(order_tax_identifiers) ORDER BY order_tax_identifiers.id)
              FROM order_tax_identifiers WHERE order_tax_identifiers.order_id = orders.id
            ), '[]'::jsonb) AS "taxIdentifiers",
            coalesce((
              SELECT jsonb_agg(to_jsonb(payments) ORDER BY payments.id)
              FROM payments WHERE payments.order_id = orders.id
            ), '[]'::jsonb) AS payments,
            coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                'id', refunds.id::text,
                'provider', refunds.provider,
                'external_account_id', refunds.external_account_id,
                'external_order_id', refunds.external_order_id,
                'external_refund_id', refunds.external_refund_id,
                'status', refunds.status,
                'amount', refunds.amount,
                'completed_at', refunds.completed_at
              ) ORDER BY refunds.id)
              FROM refunds WHERE refunds.order_id = orders.id
            ), '[]'::jsonb) AS refunds,
            -- 7.3: un'identità non certa non accorpa, ma la corrispondenza possibile va mostrata.
            CASE WHEN orders.normalized_snapshot_json #>> '{customerSnapshot,sourceConfidence}'
                      = 'TAX_ID'
              THEN '[]'::jsonb
              ELSE coalesce((
                SELECT jsonb_agg(to_jsonb(candidate) ORDER BY candidate.display_name)
                FROM (
                  SELECT DISTINCT other.id, other.display_name, other.email,
                         other.tax_id_type, other.tax_id_normalized
                  FROM customers AS other
                  WHERE other.id <> orders.customer_id
                    AND (
                      lower(other.email) = lower(
                        orders.normalized_snapshot_json #>> '{customerSnapshot,email}')
                      OR (
                        other.display_name <> 'Cliente senza nome'
                        AND lower(other.display_name) = lower(
                          orders.normalized_snapshot_json #>> '{customerSnapshot,displayName}')
                      )
                    )
                  LIMIT 5
                ) AS candidate
              ), '[]'::jsonb)
            END AS "possibleMatches"
     FROM orders
     LEFT JOIN billing_cases ON billing_cases.id = orders.billing_case_id
     WHERE orders.id = $1`,
    [id],
  );
  return order.rows[0] ?? null;
}

export async function dashboardSummary() {
  const config = getConfig();
  const shopifyEnvironment = config.APP_ENV === "production" ? "PRODUCTION" : "DEVELOPMENT";
  const ebayEnvironment = config.EBAY_ENVIRONMENT === "production" ? "PRODUCTION" : "SANDBOX";
  const result = await getPool().query<{
    orders: string;
    ready_cases: string;
    review_cases: string;
    waiting_orders: string;
    pending_payments: string;
    credit_notes_to_approve: string;
    failed_uploads: string;
    rejected_by_sdi: string;
    sync_errors: string;
    last_shopify_sync: string | null;
    last_ebay_sync: string | null;
    shopify_connection_status: "CONNECTED" | "REAUTH_REQUIRED" | "REVOKED" | "ERROR" | null;
    ebay_connection_status: "CONNECTED" | "REAUTH_REQUIRED" | "REVOKED" | "ERROR" | null;
    last_aruba_readback: string | null;
    open_aruba_batches: string;
    documents_today: string;
    documents_this_month: string;
    documents_last_seven_days: Array<{ date: string; count: number }>;
  }>(
    `SELECT
       (SELECT count(*) FROM orders)::text AS orders,
       (SELECT count(*) FROM billing_cases WHERE status = 'READY')::text AS ready_cases,
       ((SELECT count(*) FROM billing_cases WHERE status = 'NEEDS_REVIEW') +
        (SELECT count(*) FROM orders
         WHERE billing_case_id IS NULL AND (
           trigger_status = 'LEGACY_BILLING_REVIEW'
           OR (historical_reconciliation_outcome = 'ALREADY_INVOICED'
             AND NOT EXISTS (
               SELECT 1 FROM document_orders
               JOIN documents ON documents.id = document_orders.document_id
               WHERE document_orders.order_id = orders.id
                 AND documents.origin = 'ARUBA_HISTORY'
             )))))::text AS review_cases,
       (SELECT count(*) FROM orders WHERE trigger_status = 'WAITING_FOR_TRIGGER')::text AS waiting_orders,
       (SELECT count(*) FROM orders
        WHERE trigger_status NOT IN ('CANCELLED_NO_DOCUMENT', 'REFUNDED_BEFORE_ISSUE')
          AND ${pendingPaymentSql()})::text AS pending_payments,
       (SELECT count(*) FROM documents
        WHERE kind = 'CREDIT_NOTE' AND status = 'DRAFT')::text AS credit_notes_to_approve,
       (SELECT count(*) FROM aruba_batches
        WHERE status = 'VALIDATION_FAILED')::text AS failed_uploads,
       (SELECT count(*) FROM aruba_submissions
        WHERE status = 'REJECTED')::text AS rejected_by_sdi,
       ((SELECT count(*) FROM jobs WHERE status = 'FAILED') +
        (SELECT count(*) FROM webhook_events WHERE status = 'FAILED'))::text AS sync_errors,
       (SELECT last_synced_at::text FROM connections
        WHERE provider = 'SHOPIFY' AND environment = $1) AS last_shopify_sync,
       (SELECT last_synced_at::text FROM connections
        WHERE provider = 'EBAY' AND environment = $2) AS last_ebay_sync,
       (SELECT status FROM connections
        WHERE provider = 'SHOPIFY' AND environment = $1) AS shopify_connection_status,
       (SELECT status FROM connections
        WHERE provider = 'EBAY' AND environment = $2) AS ebay_connection_status,
       (SELECT max(last_readback_at)::text FROM aruba_batches) AS last_aruba_readback,
       (SELECT count(*) FROM aruba_batches
        WHERE status NOT IN ('RECONCILED', 'CANCELLED'))::text AS open_aruba_batches,
       (SELECT count(*) FROM documents
        WHERE origin = 'HUB' AND approved_at AT TIME ZONE 'Europe/Rome' >=
          date_trunc('day', now() AT TIME ZONE 'Europe/Rome'))::text AS documents_today,
       (SELECT count(*) FROM documents
        WHERE origin = 'HUB' AND approved_at AT TIME ZONE 'Europe/Rome' >=
          date_trunc('month', now() AT TIME ZONE 'Europe/Rome'))::text AS documents_this_month,
       (SELECT coalesce(
          jsonb_agg(
            jsonb_build_object('date', daily.day::date::text, 'count', daily.document_count)
            ORDER BY daily.day
          ),
          '[]'::jsonb
        )
        FROM (
          SELECT days.day, count(documents.id)::int AS document_count
          FROM generate_series(
            date_trunc('day', now() AT TIME ZONE 'Europe/Rome') - interval '6 days',
            date_trunc('day', now() AT TIME ZONE 'Europe/Rome'),
            interval '1 day'
          ) AS days(day)
          LEFT JOIN documents
            ON documents.origin = 'HUB'
           AND date_trunc('day', documents.approved_at AT TIME ZONE 'Europe/Rome') = days.day
          GROUP BY days.day
        ) AS daily) AS documents_last_seven_days`,
    [shopifyEnvironment, ebayEnvironment],
  );
  return result.rows[0]!;
}

/** Vista `Da gestire` di 13.8: cosa richiede un intervento e dove si interviene. */
export async function listOpenActivities(
  page?: unknown,
  kind?: "CREDIT_NOTE",
  sort: { key: OpenActivitySortKey; direction: SortDirection } = {
    key: "aggiornamento",
    direction: "desc",
  },
) {
  const orderBy = openActivitySortSql[sort.key];
  const direction = sqlDirection(sort.direction);
  // Colonna e direzione provengono esclusivamente dalle allowlist di modulo;
  // i valori della richiesta restano nei parametri $1-$2.
  // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk
  const result = await getPool().query<{
    kind: string;
    id: string;
    reason: string;
    case_number: string | null;
    order_number: string | null;
    provider: string | null;
    customer_name: string | null;
    customer_tax_id: string | null;
    error_code: string | null;
    order_date: string | null;
    href: string;
    created_at: string;
    total_count: number;
  }>(
    `SELECT activities.kind, activities.id, activities.reason, activities.case_number,
            activities.order_number, activities.provider,
            coalesce(invoice_customer.snapshot ->> 'displayName',
                     activities.customer_name) AS customer_name,
            customer_tax_id.value AS customer_tax_id, activities.error_code,
            activities.order_date, activities.href, activities.created_at,
            count(*) OVER()::int AS total_count
     FROM (
       SELECT 'BILLING_CASE' AS kind, billing_cases.id::text AS id,
              'BILLING_CASE_REVIEW' AS reason,
              billing_cases.public_number AS case_number,
              NULL::text AS order_number, NULL::text AS provider,
              billing_cases.customer_snapshot_json ->> 'displayName' AS customer_name,
              billing_cases.customer_snapshot_json AS customer_snapshot_json,
              NULL::bigint AS invoice_order_id,
              NULL::text AS error_code,
              billing_cases.local_order_date::text AS order_date,
              '/ordini/preparazione/' || billing_cases.id AS href,
              billing_cases.updated_at AS created_at
       FROM billing_cases
       WHERE billing_cases.status = 'NEEDS_REVIEW'
       UNION ALL
       SELECT 'ORDER', orders.id::text,
              CASE
                WHEN orders.trigger_status = 'LEGACY_BILLING_REVIEW'
                  THEN 'HISTORY_RECONCILIATION'
                WHEN orders.historical_reconciliation_outcome = 'ALREADY_INVOICED'
                  THEN 'ARUBA_INVOICE_LINK'
                ELSE 'ORDER_REVIEW'
              END,
              NULL::text, orders.display_number, orders.provider::text,
              orders.normalized_snapshot_json #>> '{customerSnapshot,displayName}',
              orders.normalized_snapshot_json -> 'customerSnapshot',
              NULL::bigint,
              NULL::text,
              orders.local_order_date::text,
              '/ordini/' || orders.id,
              orders.last_synced_at
       FROM orders
       WHERE orders.billing_case_id IS NULL AND (
         orders.trigger_status IN ('NEEDS_REVIEW', 'LEGACY_BILLING_REVIEW')
         OR (orders.historical_reconciliation_outcome = 'ALREADY_INVOICED'
           AND NOT EXISTS (
             SELECT 1 FROM document_orders
             JOIN documents ON documents.id = document_orders.document_id
             WHERE document_orders.order_id = orders.id
               AND documents.origin = 'ARUBA_HISTORY'
           )))
       UNION ALL
       SELECT 'REFUND', refunds.id::text,
              'REFUND_REVIEW', NULL::text, orders.display_number, orders.provider::text,
              orders.normalized_snapshot_json #>> '{customerSnapshot,displayName}',
              orders.normalized_snapshot_json -> 'customerSnapshot',
              orders.id,
              NULL::text,
              orders.local_order_date::text,
              '/ordini/' || orders.id,
              refunds.updated_at
       FROM refunds
       JOIN orders ON orders.id = refunds.order_id
       WHERE (refunds.status = 'AMBIGUOUS'
          OR (refunds.status = 'COMPLETED' AND refunds.amount IS NULL))
         AND orders.trigger_status NOT IN ('CANCELLED_NO_DOCUMENT', 'REFUNDED_BEFORE_ISSUE')
       UNION ALL
       SELECT 'REFUND_JOB', jobs.id::text,
              'REFUND_JOB_FAILED', NULL::text, orders.display_number, orders.provider::text,
              orders.normalized_snapshot_json #>> '{customerSnapshot,displayName}',
              orders.normalized_snapshot_json -> 'customerSnapshot',
              orders.id,
              jobs.last_error_code,
              orders.local_order_date::text,
              '/ordini/' || orders.id,
              jobs.created_at
       FROM jobs
       JOIN refunds ON refunds.id = CASE
         WHEN jobs.payload_json ->> 'refundId' ~ '^[0-9]+$'
           THEN (jobs.payload_json ->> 'refundId')::bigint END
       JOIN orders ON orders.id = refunds.order_id
       WHERE jobs.type = 'process_refund' AND jobs.status = 'FAILED'
         AND refunds.credit_document_id IS NULL
       UNION ALL
       SELECT 'CREDIT_NOTE', documents.id::text,
              'CREDIT_NOTE_APPROVAL', NULL::text, NULL::text, NULL::text,
              documents.recipient_snapshot_json ->> 'displayName',
              documents.recipient_snapshot_json, NULL::bigint, NULL::text,
              billing_cases.local_order_date::text,
              '/documenti/' || documents.id || '/nota',
              documents.created_at
       FROM documents
       JOIN billing_cases ON billing_cases.id = documents.billing_case_id
       WHERE documents.kind = 'CREDIT_NOTE' AND documents.status = 'DRAFT'
     ) AS activities
     LEFT JOIN LATERAL (
       SELECT documents.recipient_snapshot_json AS snapshot
       FROM document_orders
       JOIN documents ON documents.id = document_orders.document_id
       WHERE document_orders.order_id = activities.invoice_order_id
         AND document_orders.document_kind = 'INVOICE'
         AND documents.kind = 'INVOICE'
         AND documents.status = 'APPROVED'
       ORDER BY documents.approved_at DESC NULLS LAST, documents.id DESC
       LIMIT 1
     ) AS invoice_customer ON true
     LEFT JOIN LATERAL (
       SELECT nullif(btrim(coalesce(identifier ->> 'value',
                                     identifier ->> 'normalizedValue')), '') AS value
       FROM jsonb_array_elements(
         CASE
           WHEN jsonb_typeof(
             coalesce(invoice_customer.snapshot,
                      activities.customer_snapshot_json) -> 'taxIdentifiers') = 'array'
             THEN coalesce(invoice_customer.snapshot,
                           activities.customer_snapshot_json) -> 'taxIdentifiers'
           ELSE '[]'::jsonb
         END
       ) AS identifiers(identifier)
       WHERE nullif(btrim(coalesce(identifier ->> 'value',
                                  identifier ->> 'normalizedValue')), '') IS NOT NULL
       ORDER BY CASE identifier ->> 'type'
                  WHEN 'CODICE_FISCALE' THEN 0
                  WHEN 'PARTITA_IVA' THEN 1
                  ELSE 2
                END,
                coalesce(identifier ->> 'countryCode', ''),
                coalesce(identifier ->> 'value', identifier ->> 'normalizedValue')
       LIMIT 1
     ) AS customer_tax_id ON true
     WHERE $2::text IS NULL OR activities.kind = $2
     ORDER BY ${orderBy} ${direction} NULLS LAST, activities.created_at DESC, activities.id DESC
     LIMIT ${PAGE_SIZE + 1} OFFSET $1`,
    [pageOffset(page), kind ?? null],
  );
  const total = result.rows[0]?.total_count ?? 0;
  const pageResult = paginate(result.rows);
  return {
    rows: pageResult.rows.map(({ total_count: _, ...row }) => row),
    hasNext: pageResult.hasNext,
    total,
  };
}

/** Vista `Cronologia` di 13.8: registro ricercabile e non modificabile. */
export async function listAuditHistory(filters: {
  query?: string;
  action?: string;
  page?: unknown;
  sort?: { key: AuditHistorySortKey; direction: SortDirection };
}) {
  const empty = { rows: [] as never[], hasNext: false };
  if (containsNullByte(filters)) return empty;
  // L'allowlist copre ogni voce offerta dal filtro: un'azione ignota non deve valere "tutte".
  const action = auditActions.find((candidate) => candidate === filters.action) ?? null;
  if (filters.action && !action) return empty;
  const sort = filters.sort ?? { key: "quando", direction: "desc" };
  const orderBy = auditHistorySortSql[sort.key];
  const direction = sqlDirection(sort.direction);
  // Colonna e direzione provengono esclusivamente dalle allowlist di modulo;
  // i valori della richiesta restano nei parametri $1-$3.
  // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk
  const result = await getPool().query<{
    id: string;
    action: string;
    actor_id: string | null;
    actor_type: string;
    actor_username: string | null;
    entity_type: string;
    entity_id: string | null;
    order_provider: string | null;
    order_number: string | null;
    case_number: string | null;
    refund_order_id: string | null;
    reason: string | null;
    request_id: string;
    created_at: string;
  }>(
    `SELECT audit_events.id, audit_events.action, audit_events.actor_id,
            audit_events.actor_type, users.username AS actor_username,
            audit_events.entity_type, audit_events.entity_id, audit_events.reason,
            coalesce(event_orders.provider, event_refund_orders.provider) AS order_provider,
            coalesce(event_orders.display_number, event_refund_orders.display_number) AS order_number,
            event_cases.public_number AS case_number,
            event_refunds.order_id AS refund_order_id,
            audit_events.request_id, audit_events.created_at
     FROM audit_events
     LEFT JOIN users ON audit_events.actor_type = 'ADMIN'
       AND audit_events.actor_id ~ '^[0-9]+$'
       AND users.id = audit_events.actor_id::smallint
     LEFT JOIN orders AS event_orders ON audit_events.entity_type = 'ORDER'
       AND event_orders.id = CASE WHEN audit_events.entity_id ~ '^[0-9]+$'
             THEN audit_events.entity_id::bigint END
     LEFT JOIN billing_cases AS event_cases ON audit_events.entity_type = 'BILLING_CASE'
       AND event_cases.id = CASE WHEN audit_events.entity_id ~ '^[0-9]+$'
             THEN audit_events.entity_id::bigint END
     LEFT JOIN refunds AS event_refunds ON audit_events.entity_type = 'REFUND'
       AND event_refunds.id = CASE WHEN audit_events.entity_id ~ '^[0-9]+$'
             THEN audit_events.entity_id::bigint END
     LEFT JOIN orders AS event_refund_orders ON event_refund_orders.id = event_refunds.order_id
     WHERE ($1::text IS NULL OR audit_events.action = $1)
       AND ($2::text IS NULL OR audit_events.entity_id ILIKE $2
            OR event_orders.display_number ILIKE $2
            OR event_refund_orders.display_number ILIKE $2 OR event_cases.public_number ILIKE $2
            OR audit_events.request_id ILIKE $2 OR audit_events.reason ILIKE $2)
     ORDER BY ${orderBy} ${direction} NULLS LAST,
              audit_events.created_at DESC, audit_events.id DESC
     LIMIT ${PAGE_SIZE + 1} OFFSET $3`,
    [action, filters.query ? `%${escapeLike(filters.query)}%` : null, pageOffset(filters.page)],
  );
  return paginate(result.rows);
}
