import type pg from "pg";

import { recipientFromCustomerSnapshot } from "../documents.ts";
import { writeAudit } from "./audit.server.ts";
import { recomputeBillingCaseStatus } from "./billing-case-status.server.ts";
import { openBillingCaseSql } from "./billing-case-sql.server.ts";
import type { Provider } from "./connector-types.server.ts";
import { refreshInvoiceDraftProjection } from "./invoice-draft-projection.server.ts";

/**
 * Un replay dello stesso payload può migliorare soltanto la sua interpretazione. Per una
 * preparazione singola ancora da verificare, riallinea cliente, destinatario e stato senza
 * trasformare la correzione del mapper in un falso conflitto della sorgente.
 */
export async function reconcileMapperCustomerCorrection(
  client: pg.PoolClient,
  input: {
    caseId: string;
    orderId: string;
    oldCustomerId: string;
    newCustomerId: string;
    previousSnapshot: Record<string, unknown>;
    customerSnapshot: Record<string, unknown>;
    requestId: string;
    provider: Provider;
  },
) {
  const previousCustomer = input.previousSnapshot.customerSnapshot as
    | Record<string, unknown>
    | undefined;
  if (
    previousCustomer?.reviewRequired !== true ||
    input.customerSnapshot.reviewRequired !== false
  ) {
    return false;
  }
  const updated = await client.query(
    `UPDATE billing_cases
     SET customer_id = $2, customer_snapshot_json = $3, customer_corrected_at = now(),
         revision = revision + 1, updated_at = now()
     WHERE id = $1 AND status = 'NEEDS_REVIEW' AND customer_corrected_at IS NULL
       AND (SELECT count(*) FROM orders WHERE billing_case_id = billing_cases.id) = 1
       AND NOT EXISTS (
         SELECT 1 FROM billing_cases AS other
         WHERE other.id <> billing_cases.id AND other.customer_id = $2
           AND other.local_order_date = billing_cases.local_order_date
           AND other.currency = billing_cases.currency
           AND ${openBillingCaseSql("other")}
       )`,
    [input.caseId, input.newCustomerId, JSON.stringify(input.customerSnapshot)],
  );
  if (!updated.rowCount) return false;
  await client.query("UPDATE orders SET customer_id = $2 WHERE id = $1", [
    input.orderId,
    input.newCustomerId,
  ]);
  await client.query(
    `UPDATE documents
     SET recipient_snapshot_json = $2, draft_version = draft_version + 1,
         projection_sha256 = repeat('0', 64), updated_at = now()
     WHERE billing_case_id = $1 AND kind = 'INVOICE' AND status = 'DRAFT'`,
    [input.caseId, JSON.stringify(recipientFromCustomerSnapshot(input.customerSnapshot))],
  );
  await writeAudit(client, {
    actorType: "SYSTEM",
    action: "CUSTOMER_CORRECTED",
    eventClass: "CRITICAL",
    entityType: "BILLING_CASE",
    entityId: input.caseId,
    metadata: { billingCaseId: input.caseId, provider: input.provider },
    before: previousCustomer,
    after: input.customerSnapshot,
    reason: `Rilettura dello stesso payload con il mapper ${input.provider === "SHOPIFY" ? "Shopify" : "eBay"} corretto`,
    requestId: input.requestId,
  });
  await client.query(
    `DELETE FROM customers
     WHERE id = $1
       AND NOT EXISTS (SELECT 1 FROM orders WHERE customer_id = customers.id)
       AND NOT EXISTS (SELECT 1 FROM billing_cases WHERE customer_id = customers.id)
       AND NOT EXISTS (SELECT 1 FROM customer_source_records WHERE customer_id = customers.id)`,
    [input.oldCustomerId],
  );
  await recomputeBillingCaseStatus(client, input.caseId);
  await refreshInvoiceDraftProjection(client, input.caseId);
  return true;
}

export async function reconcileEbayEmailUpdate(
  client: pg.PoolClient,
  input: {
    caseId: string;
    orderId: string;
    customerId: string;
    customerSnapshot: Record<string, unknown>;
    requestId: string;
    revisionId?: string;
    clearExistingConflict: boolean;
    alignment: "EMAIL_ONLY" | "EMAIL_AND_MAPPER";
  },
) {
  const billingCase = await client.query<{
    status: string;
    manually_corrected: boolean;
    order_count: number;
  }>(
    `SELECT status, customer_corrected_at IS NOT NULL AS manually_corrected,
            (SELECT count(*)::integer FROM orders WHERE billing_case_id = billing_cases.id)
              AS order_count
     FROM billing_cases WHERE id = $1 FOR UPDATE`,
    [input.caseId],
  );
  const current = billingCase.rows[0];
  if (!current || !["DRAFT", "READY", "NEEDS_REVIEW"].includes(current.status)) return false;
  if (current.order_count !== 1) return false;

  if (!current.manually_corrected) {
    await client.query(
      `UPDATE billing_cases
       SET customer_id = $2, customer_snapshot_json = $3,
           revision = revision + 1, updated_at = now()
       WHERE id = $1`,
      [input.caseId, input.customerId, JSON.stringify(input.customerSnapshot)],
    );
    await client.query("UPDATE orders SET customer_id = $2 WHERE id = $1", [
      input.orderId,
      input.customerId,
    ]);
    await client.query(
      `UPDATE documents
       SET recipient_snapshot_json = $2, draft_version = draft_version + 1,
           projection_sha256 = repeat('0', 64), updated_at = now()
       WHERE billing_case_id = $1 AND kind = 'INVOICE' AND status = 'DRAFT'`,
      [input.caseId, JSON.stringify(recipientFromCustomerSnapshot(input.customerSnapshot))],
    );
  }
  if (input.clearExistingConflict) {
    await client.query(
      `UPDATE orders
       SET trigger_status = CASE WHEN trigger_status = 'NEEDS_REVIEW' THEN 'GROUPED'
                                 ELSE trigger_status END,
           normalized_snapshot_json = jsonb_set(
             normalized_snapshot_json, '{deferredReviewRequired}', 'false'::jsonb)
       WHERE id = $1`,
      [input.orderId],
    );
  }
  await writeAudit(client, {
    actorType: "SYSTEM",
    action: "ORDER_SOURCE_REVIEWED",
    eventClass: "CRITICAL",
    entityType: "ORDER",
    entityId: input.orderId,
    metadata: {
      billingCaseId: input.caseId,
      provider: "EBAY",
      automaticAlignment: input.alignment,
      ...(input.revisionId ? { revisionId: input.revisionId } : {}),
    },
    before: { sourceReview: input.clearExistingConflict ? "OPEN" : "NOT_REQUIRED" },
    after: { sourceReview: "ALIGNED_AUTOMATICALLY" },
    reason:
      input.alignment === "EMAIL_ONLY"
        ? "Variazione limitata all’e-mail eBay, senza modifiche fiscali o d’ordine"
        : "Variazione eBay riallineata con profilo invariato e mapper anagrafico verificato",
    requestId: input.requestId,
  });
  await recomputeBillingCaseStatus(client, input.caseId);
  if (!current.manually_corrected) await refreshInvoiceDraftProjection(client, input.caseId);
  return true;
}
