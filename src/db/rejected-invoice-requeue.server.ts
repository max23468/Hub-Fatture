import type pg from "pg";

import { writeAudit } from "./audit.server.ts";
import { orderReissuableAfterRejectedInvoiceSql } from "./billing-case-sql.server.ts";
import { groupOrder } from "./order-grouping.server.ts";

interface RejectedOrder {
  id: string;
  customer_id: string;
  customer_snapshot: Record<string, unknown>;
  local_order_date: string;
  currency: string;
  previous_billing_case_id: string;
  document_id: string;
}

/**
 * Riporta in preparazione gli ordini soltanto quando il readback API ha consolidato
 * lo scarto di tutte le submission della fattura. Il documento approvato e il suo
 * numero restano immutabili; cambia esclusivamente l'appartenenza operativa dell'ordine.
 */
export async function requeueAuthoritativelyRejectedInvoice(
  client: pg.PoolClient,
  submissionId: string,
  actor: { requestId: string },
) {
  const identity = await client.query<{ document_id: string }>(
    `SELECT document_id::text FROM aruba_submissions WHERE id = $1`,
    [submissionId],
  );
  const documentId = identity.rows[0]?.document_id;
  if (!documentId) return { affectedCount: 0, billingCaseIds: [] as string[] };
  // Due submission dello stesso documento possono diventare REJECTED insieme. Il lock
  // precede la rilettura in una nuova statement, così l'ultima vede i commit precedenti.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `rejected-invoice-requeue:${documentId}`,
  ]);
  const rejected = await client.query<RejectedOrder>(
    `SELECT orders.id, orders.customer_id,
            coalesce(orders.normalized_snapshot_json -> 'customerSnapshot', '{}'::jsonb)
              AS customer_snapshot,
            orders.local_order_date::text, orders.currency,
            orders.billing_case_id::text AS previous_billing_case_id,
            documents.id::text AS document_id
     FROM aruba_submissions AS rejected_submission
     JOIN documents ON documents.id = rejected_submission.document_id
     JOIN document_orders
       ON document_orders.document_id = documents.id
      AND document_orders.document_kind = 'INVOICE'
     JOIN orders ON orders.id = document_orders.order_id
     WHERE rejected_submission.id = $1
       AND rejected_submission.status = 'REJECTED'
       AND documents.kind = 'INVOICE'
       AND documents.status = 'APPROVED'
       AND orders.billing_case_id = documents.billing_case_id
       AND orders.trigger_status = 'INVOICED'
       AND ${orderReissuableAfterRejectedInvoiceSql("orders")}
       AND NOT EXISTS (
         SELECT 1 FROM aruba_submissions AS other_submission
         WHERE other_submission.document_id = documents.id
           AND other_submission.status <> 'REJECTED'
       )
     ORDER BY orders.id
     FOR UPDATE OF rejected_submission, orders`,
    [submissionId],
  );
  if (!rejected.rowCount) return { affectedCount: 0, billingCaseIds: [] as string[] };

  const billingCaseIds: string[] = [];
  for (const order of rejected.rows) {
    const released = await client.query(
      `UPDATE orders
       SET billing_case_id = NULL, trigger_status = 'ELIGIBLE'
       WHERE id = $1 AND billing_case_id = $2 AND trigger_status = 'INVOICED'`,
      [order.id, order.previous_billing_case_id],
    );
    if (!released.rowCount) continue;
    // Una sola transazione serializza il raggruppamento e conserva l'idempotenza.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const billingCaseId = await groupOrder(
      client,
      {
        id: order.id,
        customerId: order.customer_id,
        customerSnapshot: order.customer_snapshot,
        localOrderDate: order.local_order_date,
        currency: order.currency,
      },
      { type: "SYSTEM", requestId: actor.requestId },
    );
    billingCaseIds.push(billingCaseId);
  }

  if (billingCaseIds.length) {
    await writeAudit(client, {
      actorType: "SYSTEM",
      action: "INVOICE_REJECTED_REQUEUED",
      eventClass: "CRITICAL",
      entityType: "DOCUMENT",
      entityId: rejected.rows[0]!.document_id,
      metadata: { affectedCount: billingCaseIds.length, provider: "ARUBA" },
      before: { billingCaseId: rejected.rows[0]!.previous_billing_case_id },
      after: { billingCaseIds },
      requestId: actor.requestId,
    });
  }
  return { affectedCount: billingCaseIds.length, billingCaseIds };
}
