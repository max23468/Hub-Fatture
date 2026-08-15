import type pg from "pg";

import {
  canonicalCustomerProfile,
  containsNullByte,
  customerDisplayName,
  customerIdentity,
  customerSchema,
  presentationCustomer,
  PAGE_SIZE,
  pageOffset,
  paginate,
  POSTGRES_INTEGER_MAX,
  type CustomerContext,
} from "../orders.ts";
import { AppError } from "../errors.ts";
import { writeAudit } from "./audit.server.ts";
import {
  customerProfileMismatchSql,
  hasCaseOrdersSql,
  hasIncompatibleCaseOrdersSql,
  hasOtherOpenCaseSql,
  OPEN_BILLING_CASE_STATUSES,
  orderBillableSql,
  pendingPaymentSql,
  reactivationBlockerSql,
} from "./billing-case-sql.server.ts";
import { getPool, withTransaction } from "./client.server.ts";
import { isDatabaseId } from "./database-id.ts";
import {
  groupOrder,
  reconcileInvoiceDraft,
  recomputeBillingCaseStatus,
  type Actor,
} from "./order-import.server.ts";
import { serializeOrderMutations } from "./order-mutation-lock.server.ts";

export interface EditableCustomer {
  kind?: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  email?: string;
  certifiedEmail?: string;
  recipientCode?: string;
  phone?: string;
  billingAddress?: Record<string, string | undefined>;
  taxIdentifiers?: Array<{ type?: string; value?: string; countryCode?: string }>;
}

interface CaseOrder {
  id: string;
  provider: string;
  display_number: string;
  gross_amount: number;
  shopify_payments_fee_amount: number;
  deducted_shopify_payments_fee_amount: number;
  billable_amount: number;
  payment_status: string;
  trigger_status: string;
  cancelled_at: string | null;
  deferred_review_required: boolean;
  totals_reconciled: boolean;
  has_unsettled_payment: boolean;
  customer_profile_mismatch: boolean;
}

type BillingCaseAnomaly =
  | "PENDING_PAYMENT"
  | "TOTALS_MISMATCH"
  | "CUSTOMER_INCOMPLETE"
  | "CUSTOMER_MISMATCH"
  | "SOURCE_CONFLICT"
  | "ORDER_NOT_BILLABLE";

/**
 * 13.5 chiede le anomalie, non un avviso unico: la preparazione deve dire quale fatto
 * osservato la trattiene e quale azione lo risolve.
 */
function billingCaseAnomalies(
  orders: CaseOrder[],
  customerReviewRequired: boolean,
): BillingCaseAnomaly[] {
  const anomalies = new Set<BillingCaseAnomaly>();
  if (customerReviewRequired) anomalies.add("CUSTOMER_INCOMPLETE");
  for (const order of orders) {
    if (order.has_unsettled_payment) {
      anomalies.add("PENDING_PAYMENT");
    }
    if (!order.totals_reconciled) anomalies.add("TOTALS_MISMATCH");
    if (order.customer_profile_mismatch) anomalies.add("CUSTOMER_MISMATCH");
    if (order.trigger_status === "NEEDS_REVIEW" || order.deferred_review_required) {
      anomalies.add("SOURCE_CONFLICT");
    }
    if (order.cancelled_at || order.payment_status === "REFUNDED") {
      anomalies.add("ORDER_NOT_BILLABLE");
    }
  }
  return [...anomalies];
}

interface BillingCaseDetailRow {
  id: string;
  public_number: string;
  local_order_date: string;
  status: string;
  currency: string;
  customer_name: string;
  do_not_transmit_reason: string | null;
  revision: number;
  customer_corrected_at: string | null;
  review_required: boolean;
  customer_snapshot_json: EditableCustomer;
  reactivation_blocker: "EMPTY" | "INCOMPATIBLE_ORDERS" | "OTHER_OPEN_CASE" | null;
  orders: CaseOrder[];
  addableOrders: Array<{
    id: string;
    provider: string;
    display_number: string;
    gross_amount: number;
    deducted_shopify_payments_fee_amount: number;
    billable_amount: number;
  }>;
  audit: Array<{
    id: string;
    action: string;
    reason: string | null;
    request_id: string;
    created_at: string;
  }>;
  revisions: Array<{
    id: string;
    display_number: string;
    created_at: string;
    previous_normalized_snapshot_json: Record<string, unknown>;
    current_normalized_snapshot_json: Record<string, unknown>;
  }>;
}

/**
 * Legge la preparazione dentro il lock che ne autorizza la mutazione e verifica la revisione
 * ottimistica: due schede che partono dalla stessa versione non si sovrascrivono in silenzio.
 */
async function lockBillingCase(client: pg.PoolClient, id: string, expectedRevision: number) {
  // I frammenti interpolati sono costanti di modulo di billing-case-sql.server.ts:
  // nessun valore della richiesta entra nel testo SQL, i dati restano in $1, $2, ...
  // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk
  const result = await client.query<{
    status: string;
    revision: number;
    has_orders: boolean;
    has_incompatible_orders: boolean;
    has_other_open_case: boolean;
  }>(
    // I frammenti interpolati sono costanti di modulo in billing-case-sql.server.ts:
    `SELECT billing_cases.status, billing_cases.revision,
            ${hasCaseOrdersSql} AS has_orders,
            ${hasIncompatibleCaseOrdersSql} AS has_incompatible_orders,
            ${hasOtherOpenCaseSql} AS has_other_open_case
     FROM billing_cases
     WHERE billing_cases.id = $1
     FOR UPDATE OF billing_cases`,
    [id],
  );
  const current = result.rows[0];
  if (!current) return null;
  if (current.revision !== expectedRevision) throw new AppError("CONFLICT_REVISION", 409);
  return current;
}

function assertRevision(value: unknown) {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 0 || revision > POSTGRES_INTEGER_MAX) {
    throw new AppError("CONFLICT_REVISION", 409);
  }
  return revision;
}

const editableStatuses: readonly string[] = OPEN_BILLING_CASE_STATUSES;

export async function updateBillingCaseTransmission(
  id: string,
  reason: string | null,
  expectedRevision: unknown,
  actor: Actor,
) {
  if (!isDatabaseId(id)) return null;
  const revision = assertRevision(expectedRevision);
  const normalizedReason = reason?.trim() || null;
  if (
    reason !== null &&
    (!normalizedReason || normalizedReason.length > 500 || containsNullByte(normalizedReason))
  ) {
    throw new AppError("ORDER_INVALID_INPUT", 422);
  }
  return withTransaction(async (client) => {
    await serializeOrderMutations(client);
    const current = await lockBillingCase(client, id, revision);
    if (!current) return null;
    if (normalizedReason) {
      if (!editableStatuses.includes(current.status)) {
        throw new AppError("CONFLICT_REVISION", 409);
      }
      await client.query(
        `UPDATE billing_cases
         SET status = 'DO_NOT_TRANSMIT', do_not_transmit_reason = $2,
             revision = revision + 1, updated_at = now()
         WHERE id = $1`,
        [id, normalizedReason],
      );
      await writeAudit(client, {
        actorType: "ADMIN",
        actorId: String(actor.id),
        action: "BILLING_CASE_DO_NOT_TRANSMIT",
        eventClass: "CRITICAL",
        entityType: "BILLING_CASE",
        entityId: id,
        metadata: { billingCaseId: id, reason: normalizedReason },
        reason: normalizedReason,
        requestId: actor.requestId,
      });
      return "DO_NOT_TRANSMIT";
    }
    if (current.status !== "DO_NOT_TRANSMIT") throw new AppError("CONFLICT_REVISION", 409);
    if (!current.has_orders) throw new AppError("BILLING_CASE_EMPTY", 409);
    if (current.has_incompatible_orders) throw new AppError("ORDER_NOT_PREPARABLE", 409);
    if (current.has_other_open_case) throw new AppError("CONFLICT_REVISION", 409);
    await client.query(
      `UPDATE billing_cases
       SET status = 'NEEDS_REVIEW', do_not_transmit_reason = NULL, updated_at = now()
       WHERE id = $1`,
      [id],
    );
    const status = await recomputeBillingCaseStatus(client, id);
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "BILLING_CASE_REACTIVATED",
      eventClass: "CRITICAL",
      entityType: "BILLING_CASE",
      entityId: id,
      metadata: { billingCaseId: id },
      requestId: actor.requestId,
    });
    return status;
  });
}

/**
 * Chiude il solo gate introdotto da un aggiornamento del canale mentre la preparazione era
 * già aperta. Le anomalie proprie dell'ordine restano nello snapshot e vengono ricalcolate:
 * questa conferma non può quindi nascondere dati cliente, importi o pagamenti ancora incerti.
 */
export async function reviewBillingCaseSourceChanges(
  id: string,
  expectedRevision: unknown,
  confirmed: boolean,
  actor: Actor,
) {
  if (!isDatabaseId(id)) return null;
  if (!confirmed) throw new AppError("ORDER_INVALID_INPUT", 422);
  const revision = assertRevision(expectedRevision);
  return withTransaction(async (client) => {
    await serializeOrderMutations(client);
    const current = await lockBillingCase(client, id, revision);
    if (!current) return null;
    if (current.status !== "NEEDS_REVIEW") throw new AppError("CONFLICT_REVISION", 409);
    const pending = await client.query<{
      id: string;
      trigger_status: string;
      deferred_review_required: boolean;
      revision_id: string | null;
    }>(
      `SELECT orders.id, orders.trigger_status,
              coalesce(
                (orders.normalized_snapshot_json ->> 'deferredReviewRequired')::boolean,
                false
              ) AS deferred_review_required,
              (
                SELECT order_source_revisions.id::text
                FROM order_source_revisions
                WHERE order_source_revisions.order_id = orders.id
                ORDER BY order_source_revisions.created_at DESC, order_source_revisions.id DESC
                LIMIT 1
              ) AS revision_id
       FROM orders
       WHERE orders.billing_case_id = $1
         AND (
           orders.trigger_status = 'NEEDS_REVIEW'
           OR coalesce(
             (orders.normalized_snapshot_json ->> 'deferredReviewRequired')::boolean,
             false
           )
         )
       FOR UPDATE OF orders`,
      [id],
    );
    if (!pending.rowCount) throw new AppError("CONFLICT_REVISION", 409);
    await client.query(
      `UPDATE orders
       SET trigger_status = CASE
             WHEN trigger_status = 'NEEDS_REVIEW' THEN 'GROUPED'
             ELSE trigger_status
           END,
           normalized_snapshot_json = jsonb_set(
             normalized_snapshot_json,
             '{deferredReviewRequired}',
             'false'::jsonb
           )
       WHERE id = ANY($1::bigint[])`,
      [pending.rows.map((order) => order.id)],
    );
    const reconciliation = await reconcileInvoiceDraft(
      client,
      id,
      "Importi personalizzati prima della verifica dell’aggiornamento ordine",
    );
    for (const order of pending.rows) {
      // Un solo submit può chiudere più aggiornamenti della stessa preparazione; ogni ordine
      // conserva una ricevuta atomica riferita alla revisione sorgente più recente osservata.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      await writeAudit(client, {
        actorType: "ADMIN",
        actorId: String(actor.id),
        action: "ORDER_SOURCE_REVIEWED",
        eventClass: "CRITICAL",
        entityType: "ORDER",
        entityId: order.id,
        metadata: {
          billingCaseId: id,
          ...(order.revision_id ? { revisionId: order.revision_id } : {}),
        },
        before: {
          triggerStatus: order.trigger_status,
          deferredReviewRequired: order.deferred_review_required,
          ...(reconciliation ? { invoiceDraft: reconciliation.before } : {}),
        },
        after: {
          triggerStatus: order.trigger_status === "NEEDS_REVIEW" ? "GROUPED" : order.trigger_status,
          deferredReviewRequired: false,
          ...(reconciliation ? { invoiceDraft: reconciliation.after } : {}),
        },
        requestId: actor.requestId,
      });
    }
    return recomputeBillingCaseStatus(client, id);
  });
}

/**
 * Correzione anagrafica prima dell'approvazione (7.5). Lo snapshot della preparazione diventa
 * la fonte del destinatario: gli ordini conservano il valore importato, che resta confrontabile.
 */
export async function correctBillingCaseCustomer(
  id: string,
  input: unknown,
  expectedRevision: unknown,
  reason: string | null,
  actor: Actor,
) {
  if (!isDatabaseId(id)) return null;
  const revision = assertRevision(expectedRevision);
  const parsed = customerSchema.safeParse(input);
  const normalizedReason = reason?.trim() || null;
  if (
    !parsed.success ||
    containsNullByte(parsed.data) ||
    (normalizedReason && (normalizedReason.length > 500 || containsNullByte(normalizedReason)))
  ) {
    throw new AppError("ORDER_INVALID_INPUT", 422);
  }
  return withTransaction(async (client) => {
    await serializeOrderMutations(client);
    const current = await lockBillingCase(client, id, revision);
    if (!current) return null;
    if (!editableStatuses.includes(current.status)) {
      throw new AppError("BILLING_CASE_NOT_EDITABLE", 409);
    }
    const previous = await client.query<{ snapshot: Record<string, unknown> }>(
      "SELECT customer_snapshot_json AS snapshot FROM billing_cases WHERE id = $1",
      [id],
    );
    const context: CustomerContext = {
      provider: "SHOPIFY",
      externalAccountId: "billing-case",
      externalOrderId: id,
      customer: parsed.data,
    };
    const identity = customerIdentity(context);
    const canonicalProfile = canonicalCustomerProfile(context);
    const presentation = presentationCustomer(parsed.data);
    const snapshot = {
      ...presentation,
      displayName: customerDisplayName(presentation) || "Cliente senza nome",
      taxIdentifiers: canonicalProfile.taxIdentifiers,
      canonicalProfile,
      sourceConfidence: identity.confidence,
      reviewRequired: identity.reviewRequired,
    };
    await client.query(
      `UPDATE billing_cases
       SET customer_snapshot_json = $2, customer_corrected_at = now()
       WHERE id = $1`,
      [id, JSON.stringify(snapshot)],
    );
    await client.query(
      `UPDATE documents
       SET projection_sha256 = repeat('0', 64), updated_at = now()
       WHERE billing_case_id = $1 AND kind = 'INVOICE' AND status = 'DRAFT'`,
      [id],
    );
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "CUSTOMER_CORRECTED",
      eventClass: "CRITICAL",
      entityType: "BILLING_CASE",
      entityId: id,
      metadata: { billingCaseId: id },
      before: previous.rows[0]!.snapshot,
      after: snapshot,
      reason: normalizedReason,
      requestId: actor.requestId,
    });
    return recomputeBillingCaseStatus(client, id);
  });
}

/**
 * Separazione di un ordine (13.5). L'ordine torna idoneo e senza preparazione: l'indice univoco
 * parziale vieta due raggruppamenti aperti per la stessa chiave, quindi la separazione non
 * inventa una seconda preparazione dello stesso giorno ma restituisce l'ordine alla coda.
 */
export async function separateOrderFromBillingCase(
  caseId: string,
  orderId: string,
  expectedRevision: unknown,
  actor: Actor,
) {
  if (!isDatabaseId(caseId) || !isDatabaseId(orderId)) return null;
  const revision = assertRevision(expectedRevision);
  return withTransaction(async (client) => {
    await serializeOrderMutations(client);
    const current = await lockBillingCase(client, caseId, revision);
    if (!current) return null;
    if (!editableStatuses.includes(current.status)) {
      throw new AppError("BILLING_CASE_NOT_EDITABLE", 409);
    }
    const remaining = await client.query<{ count: string }>(
      "SELECT count(*)::text FROM orders WHERE billing_case_id = $1",
      [caseId],
    );
    if (Number(remaining.rows[0]!.count) < 2) throw new AppError("BILLING_CASE_EMPTY", 409);
    const separated = await client.query(
      `UPDATE orders SET billing_case_id = NULL, trigger_status = 'ELIGIBLE'
       WHERE id = $1 AND billing_case_id = $2`,
      [orderId, caseId],
    );
    if (!separated.rowCount) throw new AppError("CONFLICT_REVISION", 409);
    const reconciliation = await reconcileInvoiceDraft(client, caseId);
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "ORDER_SEPARATED",
      eventClass: "CRITICAL",
      entityType: "ORDER",
      entityId: orderId,
      metadata: { billingCaseId: caseId },
      before: reconciliation?.before,
      after: reconciliation?.after,
      requestId: actor.requestId,
    });
    return recomputeBillingCaseStatus(client, caseId);
  });
}

/** Aggiunta di un ordine compatibile (13.5): stessa chiave giornaliera, nessuna preparazione. */
export async function addOrderToBillingCase(
  caseId: string,
  orderId: string,
  expectedRevision: unknown,
  actor: Actor,
) {
  if (!isDatabaseId(caseId) || !isDatabaseId(orderId)) return null;
  const revision = assertRevision(expectedRevision);
  return withTransaction(async (client) => {
    await serializeOrderMutations(client);
    const current = await lockBillingCase(client, caseId, revision);
    if (!current) return null;
    if (!editableStatuses.includes(current.status)) {
      throw new AppError("BILLING_CASE_NOT_EDITABLE", 409);
    }
    // I frammenti interpolati sono costanti di modulo di billing-case-sql.server.ts:
    // nessun valore della richiesta entra nel testo SQL, i dati restano in $1, $2, ...
    // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk
    const candidate = await client.query<{
      id: string;
      customer_id: string;
      customer_snapshot: Record<string, unknown>;
      local_order_date: string;
      currency: string;
    }>(
      // I frammenti interpolati sono costanti di modulo in billing-case-sql.server.ts:
      `SELECT orders.id, orders.customer_id, orders.local_order_date::text, orders.currency,
              orders.normalized_snapshot_json -> 'customerSnapshot' AS customer_snapshot
       FROM orders
       JOIN billing_cases ON billing_cases.id = $2
       WHERE orders.id = $1
         AND orders.billing_case_id IS NULL
         AND ${orderBillableSql()}
         AND orders.customer_id = billing_cases.customer_id
         AND orders.local_order_date = billing_cases.local_order_date
         AND orders.currency = billing_cases.currency
       FOR UPDATE OF orders`,
      [orderId, caseId],
    );
    const order = candidate.rows[0];
    if (!order) throw new AppError("ORDER_NOT_PREPARABLE", 409);
    return groupOrder(
      client,
      {
        id: order.id,
        customerId: order.customer_id,
        customerSnapshot: order.customer_snapshot,
        localOrderDate: order.local_order_date,
        currency: order.currency,
      },
      actor,
      true,
    );
  });
}

type SortDirection = "asc" | "desc";

export type BillingCaseListSortKey =
  | "preparazione"
  | "cliente"
  | "data"
  | "ordini"
  | "totale"
  | "stato";

const billingCaseListSortSql: Record<BillingCaseListSortKey, string> = {
  preparazione: "billing_cases.public_number",
  cliente: "billing_cases.customer_snapshot_json ->> 'displayName'",
  data: "billing_cases.local_order_date",
  ordini: "count(orders.id)",
  totale: "coalesce(sum(orders.billable_amount), 0)",
  stato: "billing_cases.status",
};

export async function listBillingCases(
  filters: {
    statuses?: string[];
    page?: unknown;
    sort?: { key: BillingCaseListSortKey; direction: SortDirection };
  } = {},
) {
  const sort = filters.sort ?? { key: "data", direction: "desc" };
  const orderBy = billingCaseListSortSql[sort.key];
  const direction = sort.direction === "asc" ? "ASC" : "DESC";
  // Colonna e direzione provengono esclusivamente dalle allowlist di modulo;
  // i valori della richiesta restano nei parametri $1-$2.
  // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk
  const result = await getPool().query<{
    id: string;
    public_number: string;
    local_order_date: string;
    status: string;
    customer_name: string;
    order_count: string;
    total_amount: string;
  }>(
    `SELECT billing_cases.id, billing_cases.public_number, billing_cases.local_order_date::text,
            billing_cases.status,
            billing_cases.customer_snapshot_json ->> 'displayName' AS customer_name,
            count(orders.id)::text AS order_count, coalesce(sum(orders.billable_amount), 0)::text AS total_amount
     FROM billing_cases
     LEFT JOIN orders ON orders.billing_case_id = billing_cases.id
     WHERE $1::text[] IS NULL OR billing_cases.status = ANY($1)
     GROUP BY billing_cases.id
     ORDER BY ${orderBy} ${direction} NULLS LAST,
              billing_cases.local_order_date DESC, billing_cases.id DESC
     LIMIT ${PAGE_SIZE + 1} OFFSET $2`,
    [filters.statuses?.length ? filters.statuses : null, pageOffset(filters.page)],
  );
  return paginate(result.rows);
}

export async function getBillingCase(id: string) {
  if (!isDatabaseId(id)) return null;
  // I frammenti interpolati sono costanti di modulo di billing-case-sql.server.ts:
  // nessun valore della richiesta entra nel testo SQL, i dati restano in $1, $2, ...
  // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk
  const billingCase = await getPool().query<BillingCaseDetailRow>(
    // I frammenti interpolati sono costanti di modulo in billing-case-sql.server.ts:
    `SELECT billing_cases.*, billing_cases.local_order_date::text,
            billing_cases.customer_snapshot_json ->> 'displayName' AS customer_name,
            billing_cases.customer_snapshot_json ->> 'email' AS customer_email,
            (billing_cases.customer_snapshot_json ->> 'reviewRequired')::boolean AS review_required,
            billing_cases.customer_snapshot_json -> 'billingAddress' AS billing_address_json,
            ${reactivationBlockerSql} AS reactivation_blocker,
            coalesce((
              SELECT jsonb_agg(to_jsonb(case_orders) ORDER BY case_orders.id)
              FROM (
                SELECT orders.id, orders.provider, orders.display_number, orders.gross_amount,
                       orders.shopify_payments_fee_amount,
                       orders.deducted_shopify_payments_fee_amount, orders.billable_amount,
                       orders.payment_status, orders.fulfillment_status, orders.trigger_status,
                       orders.cancelled_at,
                       coalesce(
                         (orders.normalized_snapshot_json ->> 'orderReviewRequired')::boolean,
                         true) AS order_review_required,
                       coalesce(
                         (orders.normalized_snapshot_json ->> 'deferredReviewRequired')::boolean,
                         false) AS deferred_review_required,
                       coalesce(
                         (orders.normalized_snapshot_json ->> 'totalsReconciled')::boolean,
                         false) AS totals_reconciled,
                       ${pendingPaymentSql()} AS has_unsettled_payment,
                       ${customerProfileMismatchSql} AS customer_profile_mismatch
                FROM orders WHERE orders.billing_case_id = billing_cases.id
              ) AS case_orders
            ), '[]'::jsonb) AS orders,
            coalesce((
              SELECT jsonb_agg(to_jsonb(addable) ORDER BY addable.id)
              FROM (
                SELECT orders.id, orders.provider, orders.display_number, orders.gross_amount,
                       orders.deducted_shopify_payments_fee_amount, orders.billable_amount
                FROM orders
                WHERE orders.billing_case_id IS NULL
                  AND ${orderBillableSql()}
                  AND orders.customer_id = billing_cases.customer_id
                  AND orders.local_order_date = billing_cases.local_order_date
                  AND orders.currency = billing_cases.currency
                LIMIT 20
              ) AS addable
            ), '[]'::jsonb) AS "addableOrders",
            coalesce((
              SELECT jsonb_agg(to_jsonb(case_audit) ORDER BY case_audit.created_at DESC)
              FROM (
                SELECT id, action, actor_id, metadata_json, reason, request_id, created_at
                FROM audit_events
                WHERE (entity_type = 'BILLING_CASE' AND entity_id = billing_cases.id::text)
                   OR (entity_type = 'ORDER'
                       AND metadata_json ->> 'billingCaseId' = billing_cases.id::text)
              ) AS case_audit
            ), '[]'::jsonb) AS audit,
            coalesce((
              SELECT jsonb_agg(to_jsonb(case_revisions) ORDER BY case_revisions.created_at DESC)
              FROM (
                SELECT order_source_revisions.*, orders.display_number
                FROM order_source_revisions
                JOIN orders ON orders.id = order_source_revisions.order_id
                WHERE order_source_revisions.billing_case_id = billing_cases.id
                   OR orders.billing_case_id = billing_cases.id
              ) AS case_revisions
            ), '[]'::jsonb) AS revisions
     FROM billing_cases
     WHERE billing_cases.id = $1`,
    [id],
  );
  const row = billingCase.rows[0];
  if (!row) return null;
  return {
    ...row,
    anomalies: billingCaseAnomalies(row.orders, row.review_required),
  };
}
