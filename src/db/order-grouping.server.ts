import type pg from "pg";

import { AppError } from "../errors.ts";
import { preIssueRefund } from "../refunds.ts";
import { writeAudit } from "./audit.server.ts";
import { recomputeBillingCaseStatus } from "./billing-case-status.server.ts";
import { openBillingCaseSql, orderBillableSql } from "./billing-case-sql.server.ts";
import { auditOrderActor, type OrderActor } from "./order-actor.server.ts";
import {
  reconcileInvoiceDraft,
  reconcilePreIssueInvoiceAmount,
} from "./order-draft-reconciliation.server.ts";

interface GroupableOrder {
  id: string;
  customerId: string;
  customerSnapshot: Record<string, unknown>;
  localOrderDate: string;
  currency: string;
  isolated?: boolean;
}

/**
 * Unico punto che decide se una preparazione modificabile è pronta o da verificare.
 * Import, correzione anagrafica, separazione ordine e riattivazione lo riusano: la regola
 * vive in un posto solo e una correzione può davvero riportare la preparazione a `READY`.
 */
export async function groupOrder(
  client: pg.PoolClient,
  order: GroupableOrder,
  actor: OrderActor,
  forced = false,
) {
  const lockKey = `billing-case:${order.customerId}:${order.localOrderDate}:${order.currency}`;
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);
  if (!order.isolated) {
    // Il punto unico di raggruppamento rilegge l'autorità fiscale sotto lock: né una UI
    // obsoleta né un comando diretto possono reinserire un ordine già fatturato.
    // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk
    const groupable = await client.query(
      `SELECT id FROM orders
       WHERE id = $1 AND billing_case_id IS NULL AND ${orderBillableSql()}
       FOR UPDATE`,
      [order.id],
    );
    if (!groupable.rowCount) throw new AppError("ORDER_NOT_PREPARABLE", 409);
  }
  let caseId: string | undefined;
  if (!order.isolated) {
    // Il frammento interpolato è una costante di billing-case-sql.server.ts; i dati
    // della richiesta restano nei parametri $1, $2 e $3.
    // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM billing_cases
       WHERE customer_id = $1 AND local_order_date = $2 AND currency = $3
         AND ${openBillingCaseSql()}
       FOR UPDATE`,
      [order.customerId, order.localOrderDate, order.currency],
    );
    caseId = existing.rows[0]?.id;
  }
  if (!caseId) {
    const created = await client.query<{ id: string }>(
      `INSERT INTO billing_cases
        (customer_id, local_order_date, currency, status, customer_snapshot_json,
         do_not_transmit_reason)
       VALUES ($1, $2, $3, $5, $4, $6)
       RETURNING id`,
      [
        order.customerId,
        order.localOrderDate,
        order.currency,
        JSON.stringify(order.customerSnapshot),
        order.isolated ? "DO_NOT_TRANSMIT" : "NEEDS_REVIEW",
        order.isolated ? "Ordine rimborsato prima dell’emissione" : null,
      ],
    );
    caseId = created.rows[0]!.id;
    await writeAudit(client, {
      ...auditOrderActor(actor),
      action: "BILLING_CASE_CREATED",
      eventClass: "CRITICAL",
      entityType: "BILLING_CASE",
      entityId: caseId,
      requestId: actor.requestId,
    });
    if (order.isolated) {
      await writeAudit(client, {
        actorType: "SYSTEM",
        action: "BILLING_CASE_DO_NOT_TRANSMIT",
        eventClass: "CRITICAL",
        entityType: "BILLING_CASE",
        entityId: caseId,
        metadata: { billingCaseId: caseId, reason: "REFUNDED" },
        requestId: actor.requestId,
      });
    }
  }
  const assigned = await client.query(
    `UPDATE orders
     SET billing_case_id = $2, trigger_status = 'GROUPED'
     WHERE id = $1 AND billing_case_id IS NULL`,
    [order.id, caseId],
  );
  if (assigned.rowCount) {
    const reconciliation = await reconcileInvoiceDraft(client, caseId);
    const refund = await client.query<{
      gross_amount: number;
      billable_amount: number;
      refunds: Array<{ status: string; amount: number | null }>;
    }>(
      `SELECT orders.gross_amount, orders.billable_amount,
              coalesce(jsonb_agg(jsonb_build_object(
                'status', refunds.status, 'amount', refunds.amount
              )) FILTER (WHERE refunds.id IS NOT NULL), '[]'::jsonb) AS refunds
       FROM orders LEFT JOIN refunds ON refunds.order_id = orders.id
       WHERE orders.id = $1
       GROUP BY orders.id`,
      [order.id],
    );
    const refundEffect = preIssueRefund(
      refund.rows[0]!.gross_amount,
      refund.rows[0]!.refunds,
      refund.rows[0]!.billable_amount,
    );
    if (
      refundEffect.state === "PARTIAL" &&
      (await reconcilePreIssueInvoiceAmount(client, order.id, caseId, refundEffect.billableAmount))
    ) {
      await writeAudit(client, {
        ...auditOrderActor(actor),
        action: "REFUND_APPLIED_BEFORE_ISSUE",
        eventClass: "CRITICAL",
        entityType: "ORDER",
        entityId: order.id,
        metadata: { billingCaseId: caseId },
        requestId: actor.requestId,
      });
    }
    await writeAudit(client, {
      ...auditOrderActor(actor),
      action: forced ? "ORDER_GROUPING_FORCED" : "ORDER_GROUPED",
      eventClass: "CRITICAL",
      entityType: "ORDER",
      entityId: order.id,
      metadata: { billingCaseId: caseId },
      before: reconciliation?.before,
      after: reconciliation?.after,
      requestId: actor.requestId,
    });
  }
  await recomputeBillingCaseStatus(client, caseId);
  return caseId;
}
