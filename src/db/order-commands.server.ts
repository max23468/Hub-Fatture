import { AppError } from "../errors.ts";
import {
  draftTriggerSchema,
  POSTGRES_INTEGER_MAX,
  shopifyPaymentFeeModeSchema,
  triggerStatus,
  type OrderInput,
} from "../orders.ts";
import { writeAudit } from "./audit.server.ts";
import { getPool, withTransaction } from "./client.server.ts";
import { isDatabaseId } from "./database-id.ts";
import type { OrderActor as Actor } from "./order-actor.server.ts";
import { groupOrder } from "./order-grouping.server.ts";
import { reconcileInvoiceDraft } from "./order-draft-reconciliation.server.ts";
import { serializeOrderMutations } from "./order-mutation-lock.server.ts";
import { approvedInvoiceOrderLinkSql, pendingPaymentSql } from "./billing-case-sql.server.ts";

export async function getDraftTrigger() {
  const result = await getPool().query<{
    value_json: unknown;
    version: number;
  }>("SELECT value_json, version FROM settings WHERE key = 'draft_trigger'");
  return {
    value: draftTriggerSchema.parse(result.rows[0]?.value_json ?? "PAID"),
    version: result.rows[0]?.version ?? 0,
  };
}

export async function getShopifyPaymentFeeMode() {
  const result = await getPool().query<{
    value_json: unknown;
    version: number;
  }>("SELECT value_json, version FROM settings WHERE key = 'shopify_payment_fee_mode'");
  return {
    value: shopifyPaymentFeeModeSchema.parse(result.rows[0]?.value_json ?? "DEDUCT"),
    version: result.rows[0]?.version ?? 0,
  };
}

export async function setShopifyPaymentFeeMode(
  value: unknown,
  expectedVersion: number,
  actor: Actor,
) {
  const mode = shopifyPaymentFeeModeSchema.safeParse(value);
  if (
    !mode.success ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 0 ||
    expectedVersion > POSTGRES_INTEGER_MAX
  ) {
    throw new AppError("ORDER_INVALID_INPUT", 422);
  }
  return withTransaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('setting:shopify_payment_fee_mode'))",
    );
    await serializeOrderMutations(client);
    const setting = await client.query<{
      version: number;
      value_json: unknown;
    }>(
      "SELECT version, value_json FROM settings WHERE key = 'shopify_payment_fee_mode' FOR UPDATE",
    );
    if (setting.rows[0]?.version !== expectedVersion) {
      throw new AppError("CONFLICT_REVISION", 409);
    }
    const previousMode = shopifyPaymentFeeModeSchema.parse(setting.rows[0]?.value_json ?? "DEDUCT");
    const updated = await client.query<{ version: number }>(
      `UPDATE settings SET value_json = $1, version = version + 1, updated_at = now()
       WHERE key = 'shopify_payment_fee_mode' RETURNING version`,
      [JSON.stringify(mode.data)],
    );
    // La seconda scrittura dipende dalla versione appena fissata nella stessa transazione.
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
    const changedOrders = await client.query<{
      billing_case_id: string | null;
    }>(
      `UPDATE orders
       SET deducted_shopify_payments_fee_amount = CASE
             WHEN $1 = 'DEDUCT' THEN shopify_payments_fee_amount ELSE 0
           END,
           normalized_snapshot_json = jsonb_set(
             jsonb_set(
               normalized_snapshot_json,
               '{deductedShopifyPaymentsFeeAmount}',
               to_jsonb(CASE WHEN $1 = 'DEDUCT' THEN shopify_payments_fee_amount ELSE 0 END)
             ),
             '{billableAmount}',
             to_jsonb(gross_amount - CASE
               WHEN $1 = 'DEDUCT' THEN shopify_payments_fee_amount ELSE 0
             END)
           )
       WHERE provider = 'SHOPIFY'
         AND deducted_shopify_payments_fee_amount <> CASE
           WHEN $1 = 'DEDUCT' THEN shopify_payments_fee_amount ELSE 0
         END
         AND historical_reconciliation_outcome IS NULL
         AND NOT ${approvedInvoiceOrderLinkSql("orders")}
       RETURNING billing_case_id::text`,
      [mode.data],
    );
    const caseIds = new Set(
      changedOrders.rows.flatMap((order) =>
        order.billing_case_id === null ? [] : [order.billing_case_id],
      ),
    );
    for (const caseId of caseIds) {
      // Una sola connessione transazionale aggiorna le bozze in ordine deterministico.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      await reconcileInvoiceDraft(client, caseId);
    }
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: actor.id === undefined ? null : String(actor.id),
      action: "SHOPIFY_PAYMENT_FEE_MODE_CHANGED",
      eventClass: "CRITICAL",
      entityType: "SETTING",
      entityId: "shopify_payment_fee_mode",
      before: { mode: previousMode },
      after: { mode: mode.data, updatedOrders: changedOrders.rowCount ?? 0 },
      requestId: actor.requestId,
    });
    return { value: mode.data, version: updated.rows[0]!.version };
  });
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
    // Il frammento interpolato è una costante interna che riceve soltanto l'alias SQL fisso.
    // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk
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
      approved_invoice_linked: boolean;
      historical_reconciliation_outcome: "ALREADY_INVOICED" | "NOT_INVOICED" | null;
    }>(
      `SELECT orders.id, orders.customer_id,
              orders.normalized_snapshot_json -> 'customerSnapshot' AS customer_snapshot,
              orders.local_order_date::text, orders.currency, CASE
                WHEN ${pendingPaymentSql("orders")} THEN 'PENDING'
                WHEN orders.payment_status = 'REFUNDED' THEN 'REFUNDED'
                ELSE 'PAID'
              END AS payment_status,
              orders.fulfillment_status, orders.cancelled_at,
              orders.historical_reconciliation_outcome,
              ${approvedInvoiceOrderLinkSql("orders")} AS approved_invoice_linked,
              coalesce((orders.normalized_snapshot_json ->> 'historical')::boolean, false)
                AS historical
       FROM orders
       WHERE orders.billing_case_id IS NULL`,
    );
    for (const order of ungrouped.rows) {
      const status =
        order.approved_invoice_linked ||
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
