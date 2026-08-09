import { containsNullByte } from "../orders.ts";
import { AppError } from "../errors.ts";
import { writeAudit } from "./audit.server.ts";
import { getPool, withTransaction } from "./client.server.ts";
import { isDatabaseId } from "./order-commands.server.ts";
import { serializeOrderMutations, type Actor } from "./order-import.server.ts";

interface BillingCaseDetailRow {
  id: string;
  public_number: string;
  local_order_date: string;
  status: string;
  currency: string;
  customer_name: string;
  do_not_transmit_reason: string | null;
  reactivation_blocker: "EMPTY" | "INCOMPATIBLE_ORDERS" | "OTHER_OPEN_CASE" | null;
  orders: Array<{
    id: string;
    provider: string;
    display_number: string;
    gross_amount: number;
    payment_status: string;
  }>;
  audit: Array<{
    id: string;
    action: string;
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

export async function updateBillingCaseTransmission(
  id: string,
  reason: string | null,
  actor: Actor,
) {
  if (!isDatabaseId(id)) return null;
  const normalizedReason = reason?.trim() || null;
  if (
    reason !== null &&
    (!normalizedReason || normalizedReason.length > 500 || containsNullByte(normalizedReason))
  ) {
    throw new AppError("ORDER_INVALID_INPUT", 422);
  }
  return withTransaction(async (client) => {
    await serializeOrderMutations(client);
    const result = await client.query<{
      status: string;
      has_orders: boolean;
      has_incompatible_orders: boolean;
      needs_review: boolean;
      has_other_open_case: boolean;
    }>(
      `SELECT billing_cases.status,
              EXISTS (
                SELECT 1 FROM orders WHERE orders.billing_case_id = billing_cases.id
              ) AS has_orders,
              EXISTS (
                SELECT 1 FROM orders
                WHERE orders.billing_case_id = billing_cases.id
                  AND (orders.cancelled_at IS NOT NULL OR orders.payment_status = 'REFUNDED')
              ) AS has_incompatible_orders,
              EXISTS (
                SELECT 1 FROM orders
                WHERE orders.billing_case_id = billing_cases.id
                  AND (
                    (orders.normalized_snapshot_json ->> 'preparationReviewRequired')::boolean
                    OR coalesce(
                      (orders.normalized_snapshot_json ->> 'deferredReviewRequired')::boolean,
                      false
                    )
                    OR orders.trigger_status = 'NEEDS_REVIEW'
                    OR orders.normalized_snapshot_json #> '{customerSnapshot,canonicalProfile}'
                       IS DISTINCT FROM billing_cases.customer_snapshot_json -> 'canonicalProfile'
                  )
              ) AS needs_review,
              EXISTS (
                SELECT 1 FROM billing_cases AS other
                WHERE other.id <> billing_cases.id
                  AND other.customer_id = billing_cases.customer_id
                  AND other.local_order_date = billing_cases.local_order_date
                  AND other.currency = billing_cases.currency
                  AND other.status IN ('DRAFT', 'NEEDS_REVIEW', 'READY')
              ) AS has_other_open_case
       FROM billing_cases
       WHERE billing_cases.id = $1
       FOR UPDATE OF billing_cases`,
      [id],
    );
    const current = result.rows[0];
    if (!current) return null;
    if (normalizedReason) {
      if (!["DRAFT", "READY", "NEEDS_REVIEW"].includes(current.status)) {
        throw new AppError("CONFLICT_REVISION", 409);
      }
      await client.query(
        `UPDATE billing_cases
         SET status = 'DO_NOT_TRANSMIT', do_not_transmit_reason = $2, updated_at = now()
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
        requestId: actor.requestId,
      });
      return "DO_NOT_TRANSMIT";
    }
    if (current.status !== "DO_NOT_TRANSMIT") throw new AppError("CONFLICT_REVISION", 409);
    if (!current.has_orders) throw new AppError("BILLING_CASE_EMPTY", 409);
    if (current.has_incompatible_orders) throw new AppError("ORDER_NOT_PREPARABLE", 409);
    if (current.has_other_open_case) throw new AppError("CONFLICT_REVISION", 409);
    const status = current.needs_review ? "NEEDS_REVIEW" : "READY";
    await client.query(
      `UPDATE billing_cases
       SET status = $2, do_not_transmit_reason = NULL, updated_at = now()
       WHERE id = $1`,
      [id, status],
    );
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

export async function listBillingCases() {
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
            count(orders.id)::text AS order_count, coalesce(sum(orders.gross_amount), 0)::text AS total_amount
     FROM billing_cases
     LEFT JOIN orders ON orders.billing_case_id = billing_cases.id
     GROUP BY billing_cases.id
     ORDER BY billing_cases.local_order_date DESC, billing_cases.id DESC`,
  );
  return result.rows;
}

export async function getBillingCase(id: string) {
  if (!isDatabaseId(id)) return null;
  const billingCase = await getPool().query<BillingCaseDetailRow>(
    `SELECT billing_cases.*, billing_cases.local_order_date::text,
            billing_cases.customer_snapshot_json ->> 'displayName' AS customer_name,
            billing_cases.customer_snapshot_json ->> 'email' AS customer_email,
            (billing_cases.customer_snapshot_json ->> 'reviewRequired')::boolean AS review_required,
            billing_cases.customer_snapshot_json -> 'billingAddress' AS billing_address_json,
            CASE
              WHEN NOT EXISTS (
                SELECT 1 FROM orders WHERE orders.billing_case_id = billing_cases.id
              ) THEN 'EMPTY'
              WHEN EXISTS (
                SELECT 1 FROM orders
                WHERE orders.billing_case_id = billing_cases.id
                  AND (orders.cancelled_at IS NOT NULL OR orders.payment_status = 'REFUNDED')
              ) THEN 'INCOMPATIBLE_ORDERS'
              WHEN EXISTS (
                SELECT 1 FROM billing_cases AS other
                WHERE other.id <> billing_cases.id
                  AND other.customer_id = billing_cases.customer_id
                  AND other.local_order_date = billing_cases.local_order_date
                  AND other.currency = billing_cases.currency
                  AND other.status IN ('DRAFT', 'NEEDS_REVIEW', 'READY')
              ) THEN 'OTHER_OPEN_CASE'
              ELSE NULL
            END AS reactivation_blocker,
            coalesce((
              SELECT jsonb_agg(to_jsonb(case_orders) ORDER BY case_orders.id)
              FROM (
                SELECT id, provider, display_number, gross_amount, payment_status,
                       fulfillment_status
                FROM orders WHERE billing_case_id = billing_cases.id
              ) AS case_orders
            ), '[]'::jsonb) AS orders,
            coalesce((
              SELECT jsonb_agg(to_jsonb(case_audit) ORDER BY case_audit.created_at DESC)
              FROM (
                SELECT id, action, actor_id, metadata_json, request_id, created_at
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
    revisions: row.revisions.map((revision) => ({
      ...revision,
      changedFields: Array.from(
        new Set([
          ...Object.keys(revision.previous_normalized_snapshot_json),
          ...Object.keys(revision.current_normalized_snapshot_json),
        ]),
      ).filter(
        (field) =>
          JSON.stringify(revision.previous_normalized_snapshot_json[field]) !==
          JSON.stringify(revision.current_normalized_snapshot_json[field]),
      ),
    })),
  };
}
