import type pg from "pg";

import { canonicalTaxIdentifiers, type OrderInput } from "../orders.ts";
import { writeAudit } from "./audit.server.ts";
import { auditOrderActor, type OrderActor } from "./order-actor.server.ts";
import { canonicalOrderTimestamp } from "./order-timestamp.ts";
import { refreshCreditNoteDraft } from "./refunds.server.ts";

interface OrderChildAmounts {
  lineAmounts: Array<{ grossAmount: number; discountAmount: number }>;
  paymentAmounts: number[];
  shopifyPaymentsFeeAmounts: number[];
  refundAmounts: Array<number | null>;
}

/**
 * Righe, identificativi fiscali e pagamenti seguono la sorgente. Dopo l'emissione righe e
 * identificativi restano congelati sul documento, mentre i pagamenti continuano ad allinearsi:
 * quelli registrati a mano non vengono mai toccati.
 */
export async function replaceOrderChildren(
  client: pg.PoolClient,
  orderId: string,
  input: OrderInput,
  amounts: OrderChildAmounts,
  invoiced: boolean,
  actor: OrderActor,
) {
  const { lineAmounts, paymentAmounts, shopifyPaymentsFeeAmounts, refundAmounts } = amounts;
  const previousApplied = await client.query<{ amount: number }>(
    `SELECT coalesce(sum(amount), 0)::integer AS amount FROM refunds
     WHERE order_id = $1 AND applied_before_issue`,
    [orderId],
  );
  if (!invoiced) {
    await client.query("DELETE FROM order_lines WHERE order_id = $1", [orderId]);
    for (const [index, line] of input.lines.entries()) {
      const lineAmount = lineAmounts[index]!;
      await client.query(
        `INSERT INTO order_lines
          (order_id, external_line_id, description, quantity, gross_amount, discount_amount, raw_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          orderId,
          line.externalLineId,
          line.description,
          line.quantity,
          lineAmount.grossAmount,
          lineAmount.discountAmount,
          JSON.stringify(line),
        ],
      );
    }
    await client.query("DELETE FROM order_tax_identifiers WHERE order_id = $1", [orderId]);
    for (const identifier of canonicalTaxIdentifiers(input)) {
      await client.query(
        `INSERT INTO order_tax_identifiers
          (order_id, type, raw_value, normalized_value, country_code, source_field)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          orderId,
          identifier.type,
          identifier.rawValue,
          identifier.value,
          identifier.countryCode ?? null,
          identifier.sourceField,
        ],
      );
    }
  }
  await client.query(
    `DELETE FROM payments
     WHERE order_id = $1 AND recorded_manually = false
       AND NOT (external_payment_id = ANY($2::text[]))`,
    [orderId, input.payments.map((payment) => payment.externalPaymentId)],
  );
  for (const [index, payment] of input.payments.entries()) {
    await client.query(
      `INSERT INTO payments
        (order_id, external_payment_id, method, status, amount,
         shopify_payments_fee_amount, paid_at, raw_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (order_id, external_payment_id) DO UPDATE SET
         method = EXCLUDED.method,
         status = EXCLUDED.status,
         amount = EXCLUDED.amount,
         shopify_payments_fee_amount = EXCLUDED.shopify_payments_fee_amount,
         paid_at = EXCLUDED.paid_at,
         raw_json = EXCLUDED.raw_json
       WHERE payments.recorded_manually = false`,
      [
        orderId,
        payment.externalPaymentId,
        payment.method,
        payment.status,
        paymentAmounts[index],
        shopifyPaymentsFeeAmounts[index],
        payment.paidAt,
        JSON.stringify(payment),
      ],
    );
  }
  const creditDraftsToRefresh = new Set<string>();
  const removedFromDrafts = await client.query<{ credit_document_id: string }>(
    `SELECT refunds.credit_document_id
     FROM refunds JOIN documents ON documents.id = refunds.credit_document_id
     WHERE refunds.order_id = $1 AND documents.status = 'DRAFT'
       AND NOT (refunds.external_refund_id = ANY($2::text[]))
     FOR UPDATE OF refunds`,
    [orderId, input.refunds.map((refund) => refund.externalRefundId)],
  );
  for (const refund of removedFromDrafts.rows) {
    creditDraftsToRefresh.add(refund.credit_document_id);
  }
  await client.query(
    `DELETE FROM refunds
     WHERE order_id = $1
       AND (credit_document_id IS NULL OR EXISTS (
         SELECT 1 FROM documents
         WHERE documents.id = refunds.credit_document_id AND documents.status = 'DRAFT'
       ))
       AND NOT ($3::boolean AND applied_before_issue)
       AND NOT (external_refund_id = ANY($2::text[]))`,
    [orderId, input.refunds.map((refund) => refund.externalRefundId), invoiced],
  );
  for (const [index, refund] of input.refunds.entries()) {
    const previous = await client.query<{
      credit_document_id: string | null;
      status: string;
      amount: number | null;
      completed_at: Date | null;
    }>(
      `SELECT refunds.credit_document_id, refunds.status, refunds.amount, refunds.completed_at
       FROM refunds
       WHERE provider = $1 AND external_account_id = $2 AND external_order_id = $3
         AND external_refund_id = $4
       FOR UPDATE`,
      [input.provider, input.externalAccountId, input.externalOrderId, refund.externalRefundId],
    );
    const old = previous.rows[0];
    const nextAmount = refundAmounts[index];
    const changed = Boolean(
      old &&
      (old.status !== refund.status ||
        old.amount !== nextAmount ||
        old.completed_at?.toISOString() !== canonicalOrderTimestamp(refund.completedAt)),
    );
    if (changed && old?.credit_document_id) {
      const linked = await client.query<{ status: string }>(
        "SELECT status FROM documents WHERE id = $1",
        [old.credit_document_id],
      );
      if (linked.rows[0]?.status === "DRAFT") creditDraftsToRefresh.add(old.credit_document_id);
    }
    await client.query(
      `INSERT INTO refunds
        (provider, external_account_id, external_order_id, external_refund_id, order_id,
         status, amount, completed_at, raw_json, applied_before_issue)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (provider, external_account_id, external_order_id, external_refund_id)
       DO UPDATE SET status = EXCLUDED.status, amount = EXCLUDED.amount,
                     completed_at = EXCLUDED.completed_at, raw_json = EXCLUDED.raw_json,
                     applied_before_issue = CASE WHEN $11::boolean
                       THEN refunds.applied_before_issue
                       ELSE EXCLUDED.applied_before_issue
                     END,
                     credit_document_id = CASE
                       WHEN EXCLUDED.status = 'COMPLETED' AND EXCLUDED.amount > 0
                         THEN refunds.credit_document_id
                       ELSE NULL
                     END,
                     updated_at = now()
       WHERE refunds.credit_document_id IS NULL OR EXISTS (
         SELECT 1 FROM documents
         WHERE documents.id = refunds.credit_document_id AND documents.status = 'DRAFT'
       )`,
      [
        input.provider,
        input.externalAccountId,
        input.externalOrderId,
        refund.externalRefundId,
        orderId,
        refund.status,
        refundAmounts[index],
        refund.completedAt,
        JSON.stringify(refund.raw),
        !invoiced && refund.status === "COMPLETED" && nextAmount !== null && nextAmount > 0,
        invoiced,
      ],
    );
  }
  for (const documentId of creditDraftsToRefresh) {
    // Le modifiche e il relativo registro condividono la stessa operazione PostgreSQL.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const total = await refreshCreditNoteDraft(client, documentId);
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    await writeAudit(client, {
      ...auditOrderActor(actor),
      action: "REFUND_CREDIT_NOTE_UPDATED",
      eventClass: "CRITICAL",
      entityType: "DOCUMENT",
      entityId: documentId,
      metadata: { provider: input.provider, documentKind: "CREDIT_NOTE" },
      after: { total },
      requestId: actor.requestId,
    });
  }
  await client.query(
    `INSERT INTO jobs (type, payload_json)
     SELECT 'process_refund', jsonb_build_object('refundId', refunds.id::text)
     FROM refunds
     WHERE refunds.order_id = $1 AND refunds.status IN ('COMPLETED', 'AMBIGUOUS')
       AND NOT refunds.applied_before_issue
     ON CONFLICT DO NOTHING`,
    [orderId],
  );
  return previousApplied.rows[0]?.amount ?? 0;
}
