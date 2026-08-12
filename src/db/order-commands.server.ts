import { AppError } from "../errors.ts";
import { z } from "zod";
import {
  draftTriggerSchema,
  POSTGRES_INTEGER_MAX,
  triggerStatus,
  type OrderInput,
} from "../orders.ts";
import { preIssueRefund } from "../refunds.ts";
import { writeAudit } from "./audit.server.ts";
import { getPool, withTransaction } from "./client.server.ts";
import {
  groupOrder,
  reconcilePreIssueInvoiceAmount,
  serializeOrderMutations,
  type Actor,
} from "./order-import.server.ts";

const POSTGRES_BIGINT_MAX = "9223372036854775807";
const historicalReconciliationSchema = z.object({
  outcome: z.enum(["ALREADY_INVOICED", "NOT_INVOICED"]),
  reference: z.string().trim().min(10).max(500),
});

export function isDatabaseId(id: string) {
  return (
    /^[1-9]\d*$/.test(id) &&
    (id.length < POSTGRES_BIGINT_MAX.length ||
      (id.length === POSTGRES_BIGINT_MAX.length && id <= POSTGRES_BIGINT_MAX))
  );
}

export async function getDraftTrigger() {
  const result = await getPool().query<{ value_json: unknown; version: number }>(
    "SELECT value_json, version FROM settings WHERE key = 'draft_trigger'",
  );
  return {
    value: draftTriggerSchema.parse(result.rows[0]?.value_json ?? "PAID"),
    version: result.rows[0]?.version ?? 0,
  };
}

export async function setDraftTrigger(value: unknown, expectedVersion: number, actor: Actor) {
  const trigger = draftTriggerSchema.safeParse(value);
  if (
    !trigger.success ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 0 ||
    expectedVersion > POSTGRES_INTEGER_MAX
  ) {
    throw new AppError("ORDER_INVALID_INPUT", 422);
  }
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('setting:draft_trigger'))");
    await serializeOrderMutations(client);
    const setting = await client.query<{ version: number }>(
      "SELECT version FROM settings WHERE key = 'draft_trigger' FOR UPDATE",
    );
    if (setting.rows[0]?.version !== expectedVersion) {
      throw new AppError("CONFLICT_REVISION", 409);
    }
    const updated = await client.query<{ version: number }>(
      `UPDATE settings
       SET value_json = $1, version = version + 1, updated_at = now()
       WHERE key = 'draft_trigger'
       RETURNING version`,
      [JSON.stringify(trigger.data)],
    );
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "DRAFT_TRIGGER_CHANGED",
      eventClass: "CRITICAL",
      entityType: "SETTING",
      entityId: "draft_trigger",
      metadata: { value: trigger.data },
      requestId: actor.requestId,
    });
    const ungrouped = await client.query<{
      id: string;
      customer_id: string;
      customer_snapshot: Record<string, unknown>;
      local_order_date: string;
      currency: string;
      payment_status: OrderInput["paymentStatus"];
      fulfillment_status: OrderInput["fulfillmentStatus"];
      cancelled_at: string | null;
      historical: boolean;
      historical_reconciliation_outcome: "ALREADY_INVOICED" | "NOT_INVOICED" | null;
    }>(
      `SELECT orders.id, orders.customer_id,
              orders.normalized_snapshot_json -> 'customerSnapshot' AS customer_snapshot,
              orders.local_order_date::text, orders.currency, orders.payment_status,
              orders.fulfillment_status, orders.cancelled_at,
              orders.historical_reconciliation_outcome,
              coalesce((orders.normalized_snapshot_json ->> 'historical')::boolean, false)
                AS historical
       FROM orders
       WHERE orders.billing_case_id IS NULL`,
    );
    for (const order of ungrouped.rows) {
      const status =
        order.historical_reconciliation_outcome === "ALREADY_INVOICED"
          ? "INVOICED"
          : triggerStatus(
              {
                cancelledAt: order.cancelled_at,
                paymentStatus: order.payment_status,
                fulfillmentStatus: order.fulfillment_status,
                historical: order.historical && order.historical_reconciliation_outcome === null,
              },
              trigger.data,
            );
      const updatedOrder = await client.query(
        `UPDATE orders SET trigger_status = $2
         WHERE id = $1 AND billing_case_id IS NULL
         RETURNING id`,
        [order.id, status],
      );
      if (status === "ELIGIBLE" && updatedOrder.rowCount) {
        await groupOrder(
          client,
          {
            id: order.id,
            customerId: order.customer_id,
            customerSnapshot: order.customer_snapshot,
            localOrderDate: order.local_order_date,
            currency: order.currency,
          },
          actor,
        );
      }
    }
    return { value: trigger.data, version: updated.rows[0]!.version };
  });
}

export async function reconcileHistoricalOrder(
  id: string,
  raw: { outcome: unknown; reference: unknown },
  actor: Actor,
) {
  if (!isDatabaseId(id)) return null;
  const parsed = historicalReconciliationSchema.safeParse(raw);
  if (!parsed.success || actor.id === undefined) throw new AppError("ORDER_INVALID_INPUT", 422);
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('setting:draft_trigger'))");
    await serializeOrderMutations(client);
    const order = await client.query<{
      id: string;
      customer_id: string;
      customer_snapshot: Record<string, unknown>;
      local_order_date: string;
      currency: string;
      payment_status: OrderInput["paymentStatus"];
      fulfillment_status: OrderInput["fulfillmentStatus"];
      cancelled_at: string | null;
      trigger_status: string;
      historical: boolean;
      historical_reconciled_at: Date | null;
      gross_amount: number;
      refunds: Array<{ status: string; amount: number | null }>;
    }>(
      `SELECT orders.id, orders.customer_id,
              orders.normalized_snapshot_json -> 'customerSnapshot' AS customer_snapshot,
              orders.local_order_date::text, orders.currency, orders.payment_status,
              orders.fulfillment_status, orders.cancelled_at, orders.trigger_status,
              coalesce((orders.normalized_snapshot_json ->> 'historical')::boolean, false)
                AS historical,
              orders.historical_reconciled_at, orders.gross_amount,
              coalesce((
                SELECT jsonb_agg(jsonb_build_object(
                  'status', refunds.status, 'amount', refunds.amount
                )) FROM refunds WHERE refunds.order_id = orders.id
              ), '[]'::jsonb) AS refunds
       FROM orders WHERE orders.id = $1 FOR UPDATE`,
      [id],
    );
    const current = order.rows[0];
    if (!current) return null;
    if (
      !current.historical ||
      current.historical_reconciled_at ||
      current.trigger_status !== "LEGACY_BILLING_REVIEW"
    ) {
      throw new AppError("CONFLICT_REVISION", 409);
    }
    const trigger = await client.query<{ value_json: unknown }>(
      "SELECT value_json FROM settings WHERE key = 'draft_trigger' FOR SHARE",
    );
    const refundEffect = preIssueRefund(current.gross_amount, current.refunds);
    const nextStatus =
      parsed.data.outcome === "ALREADY_INVOICED"
        ? "INVOICED"
        : refundEffect.state === "TOTAL"
          ? "REFUNDED_BEFORE_ISSUE"
          : triggerStatus(
              {
                cancelledAt: current.cancelled_at,
                paymentStatus: current.payment_status,
                fulfillmentStatus: current.fulfillment_status,
                historical: false,
              },
              draftTriggerSchema.parse(trigger.rows[0]?.value_json ?? "PAID"),
            );
    await client.query(
      `UPDATE orders SET trigger_status = $2, historical_reconciliation_outcome = $3,
         historical_reconciliation_reference = $4, historical_reconciled_at = now()
       WHERE id = $1`,
      [id, nextStatus, parsed.data.outcome, parsed.data.reference],
    );
    if (parsed.data.outcome === "ALREADY_INVOICED") {
      await client.query(
        `WITH issued_refunds AS (
           UPDATE refunds SET applied_before_issue = false, updated_at = now()
           WHERE order_id = $1 AND applied_before_issue
           RETURNING id
         )
         INSERT INTO jobs (type, payload_json)
         SELECT 'process_refund', jsonb_build_object('refundId', issued_refunds.id::text)
         FROM issued_refunds ON CONFLICT DO NOTHING`,
        [id],
      );
    }
    await writeAudit(client, {
      actorType: actor.type ?? "ADMIN",
      actorId: String(actor.id),
      action: "ORDER_HISTORY_RECONCILED",
      eventClass: "CRITICAL",
      entityType: "ORDER",
      entityId: id,
      after: { outcome: parsed.data.outcome, reference: parsed.data.reference },
      requestId: actor.requestId,
    });
    const caseId =
      nextStatus === "ELIGIBLE" || nextStatus === "REFUNDED_BEFORE_ISSUE"
        ? await groupOrder(
            client,
            {
              id: current.id,
              customerId: current.customer_id,
              customerSnapshot: current.customer_snapshot,
              localOrderDate: current.local_order_date,
              currency: current.currency,
              isolated: nextStatus === "REFUNDED_BEFORE_ISSUE",
            },
            actor,
          )
        : null;
    if (caseId && nextStatus === "REFUNDED_BEFORE_ISSUE") {
      await client.query("UPDATE orders SET trigger_status = $2 WHERE id = $1", [id, nextStatus]);
    }
    if (caseId && nextStatus === "ELIGIBLE" && refundEffect.state === "PARTIAL") {
      await reconcilePreIssueInvoiceAmount(client, id, caseId, refundEffect.billableAmount);
    }
    return { caseId, outcome: parsed.data.outcome };
  });
}

export async function forcePrepareOrder(id: string, actor: Actor) {
  if (!isDatabaseId(id)) return null;
  return withTransaction(async (client) => {
    await serializeOrderMutations(client);
    const identity = await client.query<{
      provider: string;
      external_account_id: string;
      external_order_id: string;
    }>("SELECT provider, external_account_id, external_order_id FROM orders WHERE id = $1", [id]);
    if (!identity.rows[0]) return null;
    const source = identity.rows[0];
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `order:${source.provider}:${source.external_account_id}:${source.external_order_id}`,
    ]);
    const order = await client.query<{
      id: string;
      customer_id: string;
      billing_case_id: string | null;
      customer_snapshot: Record<string, unknown>;
      local_order_date: string;
      currency: string;
      cancelled_at: string | null;
      payment_status: OrderInput["paymentStatus"];
      historical: boolean;
      historical_reconciliation_outcome: "ALREADY_INVOICED" | "NOT_INVOICED" | null;
    }>(
      `SELECT orders.id, orders.customer_id, orders.billing_case_id,
              orders.normalized_snapshot_json -> 'customerSnapshot' AS customer_snapshot,
              orders.local_order_date::text,
              orders.currency, orders.cancelled_at, orders.payment_status,
              orders.historical_reconciliation_outcome,
              coalesce((orders.normalized_snapshot_json ->> 'historical')::boolean, false)
                AS historical
       FROM orders
       WHERE orders.id = $1
       FOR UPDATE OF orders`,
      [id],
    );
    const current = order.rows[0];
    if (!current) return null;
    if (current.billing_case_id) return current.billing_case_id;
    if (
      (current.historical && current.historical_reconciliation_outcome !== "NOT_INVOICED") ||
      current.cancelled_at ||
      current.payment_status === "REFUNDED"
    ) {
      throw new AppError("ORDER_NOT_PREPARABLE", 409);
    }
    return groupOrder(
      client,
      {
        id: current.id,
        customerId: current.customer_id,
        customerSnapshot: current.customer_snapshot,
        localOrderDate: current.local_order_date,
        currency: current.currency,
      },
      actor,
      true,
    );
  });
}
