import type pg from "pg";

import { type OrderInput, triggerStatus } from "../orders.ts";
import { preIssueRefund } from "../refunds.ts";
import { writeAudit } from "./audit.server.ts";
import { openBillingCaseSql, orderBillableSql } from "./billing-case-sql.server.ts";
import { auditOrderActor, type OrderActor as Actor } from "./order-actor.server.ts";
import { groupOrder } from "./order-grouping.server.ts";

interface SourceConflictOrder {
  billing_case_id: string | null;
  billing_case_status: string | null;
  billing_case_do_not_transmit_automatic: boolean;
  trigger_status: string;
}

/**
 * I dati della sorgente sono cambiati sotto una preparazione già aperta. La preparazione
 * non può più essere emessa come sta: o viene archiviata (ordine annullato o rimborsato)
 * e gli altri ordini tornano in coda, oppure passa da verificare.
 * Restituisce la preparazione a cui l'ordine resta agganciato, `null` se ne è uscito.
 */
export async function applySourceConflict(
  client: pg.PoolClient,
  actor: Actor,
  context: {
    input: OrderInput;
    oldOrder: SourceConflictOrder;
    orderId: string;
    customerId: string;
    status: ReturnType<typeof triggerStatus> | "INVOICED";
    revisionId: string;
    invoiced: boolean;
    billingCaseId: string | null;
    refundEffect: ReturnType<typeof preIssueRefund>["state"];
    becameHistorical: boolean;
  },
) {
  const { input, oldOrder, orderId, customerId, status, invoiced } = context;
  const reason = context.becameHistorical
    ? ("HISTORICAL" as const)
    : input.cancelledAt
      ? ("CANCELLED" as const)
      : input.paymentStatus === "REFUNDED" || context.refundEffect === "TOTAL"
        ? ("REFUNDED" as const)
        : null;
  if (!reason && !invoiced) {
    await client.query("UPDATE orders SET trigger_status = 'NEEDS_REVIEW' WHERE id = $1", [
      orderId,
    ]);
  }
  // I frammenti interpolati sono costanti di modulo di billing-case-sql.server.ts:
  // nessun valore della richiesta entra nel testo SQL, i dati restano in $1, $2, ...
  // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk
  const transitionedCase = await client.query(
    `UPDATE billing_cases
       SET status = $2,
           do_not_transmit_reason = $3,
           revision = revision + 1,
           updated_at = now()
       WHERE id = $1 AND ${openBillingCaseSql()}`,
    [
      oldOrder!.billing_case_id,
      reason ? "DO_NOT_TRANSMIT" : "NEEDS_REVIEW",
      reason === "CANCELLED"
        ? "Ordine annullato dalla sorgente"
        : reason === "REFUNDED"
          ? "Ordine rimborsato prima dell’emissione"
          : reason === "HISTORICAL"
            ? "Ordine storico da confrontare con Aruba"
            : null,
    ],
  );
  await writeAudit(client, {
    ...auditOrderActor(actor),
    action: "ORDER_SOURCE_CONFLICT",
    eventClass: "CRITICAL",
    entityType: "ORDER",
    entityId: orderId,
    metadata: {
      billingCaseId: oldOrder.billing_case_id!,
      revisionId: context.revisionId,
    },
    requestId: actor.requestId,
  });
  if (reason && transitionedCase.rowCount) {
    await writeAudit(client, {
      actorType: "SYSTEM",
      action: "BILLING_CASE_DO_NOT_TRANSMIT",
      eventClass: "CRITICAL",
      entityType: "BILLING_CASE",
      entityId: oldOrder!.billing_case_id!,
      metadata: {
        billingCaseId: oldOrder!.billing_case_id!,
        reason,
        reviewRequired: oldOrder!.trigger_status === "NEEDS_REVIEW",
      },
      requestId: actor.requestId,
    });
    // I frammenti interpolati sono costanti di modulo di billing-case-sql.server.ts:
    // nessun valore della richiesta entra nel testo SQL, i dati restano in $1, $2, ...
    // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk
    const remainingOrders = await client.query<{
      id: string;
      customer_id: string;
      local_order_date: string;
      currency: string;
      customer_snapshot: Record<string, unknown>;
    }>(
      `UPDATE orders
         SET billing_case_id = NULL,
             trigger_status = 'ELIGIBLE',
             normalized_snapshot_json = jsonb_set(
               normalized_snapshot_json,
               '{deferredReviewRequired}',
               -- L'anomalia propria dell'ordine resta leggibile nel suo snapshot: qui va
               -- conservata soltanto la verifica che il distacco cancellerebbe.
               to_jsonb(
                 coalesce(
                   (normalized_snapshot_json ->> 'deferredReviewRequired')::boolean,
                   false
                 )
                 OR trigger_status = 'NEEDS_REVIEW'
               )
             )
         WHERE billing_case_id = $1 AND id <> $2
           AND ${orderBillableSql()}
         RETURNING id, customer_id, local_order_date::text, currency,
           normalized_snapshot_json -> 'customerSnapshot' AS customer_snapshot`,
      [oldOrder!.billing_case_id, orderId],
    );
    // Ogni assegnazione deve osservare la preparazione creata dalla precedente nella stessa transazione.
    for (const remainingOrder of remainingOrders.rows) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      await groupOrder(
        client,
        {
          id: remainingOrder.id,
          customerId: remainingOrder.customer_id,
          customerSnapshot: remainingOrder.customer_snapshot,
          localOrderDate: remainingOrder.local_order_date,
          currency: remainingOrder.currency,
        },
        actor,
      );
    }
  }
  if (reason === "HISTORICAL") {
    await client.query(
      `UPDATE orders SET billing_case_id = NULL, trigger_status = $2 WHERE id = $1`,
      [orderId, status],
    );
    return null;
  }
  if (
    !reason &&
    oldOrder.billing_case_status === "DO_NOT_TRANSMIT" &&
    oldOrder.billing_case_do_not_transmit_automatic
  ) {
    // L'ordine esce da una preparazione archiviata dal sistema perché i suoi dati sono
    // cambiati due volte: la preparazione che lo accoglie nasce da verificare.
    await client.query(
      `UPDATE orders
         SET billing_case_id = NULL, trigger_status = $3, customer_id = $2,
             normalized_snapshot_json = jsonb_set(
               normalized_snapshot_json,
               '{deferredReviewRequired}',
               to_jsonb($4::boolean)
             )
         WHERE id = $1`,
      [orderId, customerId, status, true],
    );
    return null;
  }
  return context.billingCaseId;
}
