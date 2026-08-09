import {
  containsNullByte,
  escapeLike,
  PAGE_SIZE,
  pageOffset,
  paginate,
  postgresDateSchema,
} from "../orders.ts";
import { auditActions } from "./audit.server.ts";
import { getPool } from "./client.server.ts";
import { isDatabaseId } from "./order-commands.server.ts";

interface SourceCustomer {
  kind?: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  email?: string;
  billingAddress?: Record<string, string | undefined>;
  taxIdentifiers?: Array<{ type?: string; value?: string; sourceField?: string }>;
}

interface OrderDetailRow {
  id: string;
  provider: string;
  display_number: string;
  local_order_date: string;
  gross_amount: number;
  payment_status: string;
  fulfillment_status: string;
  trigger_status: string;
  billing_case_id: string | null;
  case_number: string | null;
  customer_name: string;
  customer_kind: string;
  customer_email: string | null;
  billing_address_json: Record<string, string | undefined>;
  source_confidence: string;
  review_required: boolean;
  raw_snapshot_json: { customer?: SourceCustomer };
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
    paid_at: string | null;
    recorded_manually: boolean;
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
            OR orders.trigger_status = $3)
       AND ($4::date IS NULL OR orders.local_order_date = $4)
       AND ($5::text IS NULL OR orders.payment_status = $5)
     ORDER BY orders.local_order_date DESC, orders.id DESC
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
  const result = await getPool().query<{
    orders: string;
    ready_cases: string;
    review_cases: string;
    waiting_orders: string;
    pending_payments: string;
  }>(
    `SELECT
       (SELECT count(*) FROM orders)::text AS orders,
       (SELECT count(*) FROM billing_cases WHERE status = 'READY')::text AS ready_cases,
       (SELECT count(*) FROM billing_cases WHERE status = 'NEEDS_REVIEW')::text AS review_cases,
       (SELECT count(*) FROM orders WHERE trigger_status = 'WAITING_FOR_TRIGGER')::text AS waiting_orders,
       (SELECT count(*) FROM orders
        WHERE trigger_status NOT IN ('CANCELLED_NO_DOCUMENT', 'REFUNDED_BEFORE_ISSUE')
          AND (payment_status = 'PENDING'
            OR EXISTS (SELECT 1 FROM payments WHERE payments.order_id = orders.id
                        AND payments.status = 'PENDING')))::text AS pending_payments`,
  );
  return result.rows[0]!;
}

/** Vista `Da gestire` di 13.7: cosa richiede un intervento e dove si interviene. */
export async function listOpenActivities(page?: unknown) {
  const result = await getPool().query<{
    kind: string;
    id: string;
    label: string;
    detail: string;
    href: string;
    created_at: string;
  }>(
    `SELECT * FROM (
       SELECT 'BILLING_CASE' AS kind, billing_cases.id::text AS id,
              'Preparazione fattura ' || billing_cases.public_number AS label,
              coalesce(billing_cases.customer_snapshot_json ->> 'displayName',
                       'Cliente da verificare') AS detail,
              '/ordini/preparazione/' || billing_cases.id AS href,
              billing_cases.updated_at AS created_at
       FROM billing_cases
       WHERE billing_cases.status = 'NEEDS_REVIEW'
       UNION ALL
       SELECT 'ORDER', orders.id::text,
              'Ordine ' || orders.display_number,
              coalesce(orders.normalized_snapshot_json #>> '{customerSnapshot,displayName}',
                       'Cliente da verificare'),
              '/ordini/' || orders.id,
              orders.last_synced_at
       FROM orders
       WHERE orders.trigger_status = 'NEEDS_REVIEW' AND orders.billing_case_id IS NULL
     ) AS activities
     ORDER BY created_at DESC, id DESC
     LIMIT ${PAGE_SIZE + 1} OFFSET $1`,
    [pageOffset(page)],
  );
  return paginate(result.rows);
}

/** Vista `Cronologia` di 13.7: registro ricercabile e non modificabile. */
export async function listAuditHistory(filters: {
  query?: string;
  action?: string;
  page?: unknown;
}) {
  const empty = { rows: [] as never[], hasNext: false };
  if (containsNullByte(filters)) return empty;
  // L'allowlist copre ogni voce offerta dal filtro: un'azione ignota non deve valere "tutte".
  const action = auditActions.find((candidate) => candidate === filters.action) ?? null;
  if (filters.action && !action) return empty;
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
    reason: string | null;
    request_id: string;
    created_at: string;
  }>(
    `SELECT audit_events.id, audit_events.action, audit_events.actor_id,
            audit_events.actor_type, users.username AS actor_username,
            audit_events.entity_type, audit_events.entity_id, audit_events.reason,
            event_orders.provider AS order_provider,
            event_orders.display_number AS order_number,
            event_cases.public_number AS case_number,
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
     WHERE ($1::text IS NULL OR audit_events.action = $1)
       AND ($2::text IS NULL OR audit_events.entity_id ILIKE $2
            OR event_orders.display_number ILIKE $2 OR event_cases.public_number ILIKE $2
            OR audit_events.request_id ILIKE $2 OR audit_events.reason ILIKE $2)
     ORDER BY audit_events.created_at DESC, audit_events.id DESC
     LIMIT ${PAGE_SIZE + 1} OFFSET $3`,
    [action, filters.query ? `%${escapeLike(filters.query)}%` : null, pageOffset(filters.page)],
  );
  return paginate(result.rows);
}
