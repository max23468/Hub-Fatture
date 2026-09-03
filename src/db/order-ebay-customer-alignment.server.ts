import type pg from "pg";

import { recipientFromCustomerSnapshot } from "../documents.ts";
import { writeAudit } from "./audit.server.ts";
import { recomputeBillingCaseStatus } from "./billing-case-status.server.ts";
import { refreshInvoiceDraftProjection } from "./invoice-draft-projection.server.ts";

export async function reconcileEbayCustomerAlignment(
  client: pg.PoolClient,
  input: {
    caseId: string;
    orderId: string;
    customerId: string;
    customerSnapshot: Record<string, unknown>;
    requestId: string;
    revisionId?: string;
    clearExistingConflict: boolean;
    alignment: "EMAIL_ONLY" | "EMAIL_AND_MAPPER" | "CARE_OF_ADDRESS";
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
             jsonb_set(
               normalized_snapshot_json, '{deferredReviewRequired}', 'false'::jsonb),
             '{sourceConflictRequired}', 'false'::jsonb)
       WHERE id = $1`,
      [input.orderId],
    );
  }
  const careOfAddress = input.alignment === "CARE_OF_ADDRESS";
  await writeAudit(client, {
    actorType: "SYSTEM",
    action: careOfAddress ? "CUSTOMER_CORRECTED" : "ORDER_SOURCE_REVIEWED",
    eventClass: "CRITICAL",
    entityType: careOfAddress ? "BILLING_CASE" : "ORDER",
    entityId: careOfAddress ? input.caseId : input.orderId,
    metadata: {
      billingCaseId: input.caseId,
      provider: "EBAY",
      automaticAlignment: input.alignment,
      ...(input.revisionId ? { revisionId: input.revisionId } : {}),
    },
    before: careOfAddress
      ? { customerSnapshot: "EBAY_NAME_WITH_CARE_OF" }
      : { sourceReview: input.clearExistingConflict ? "OPEN" : "NOT_REQUIRED" },
    after: careOfAddress
      ? { customerSnapshot: "CARE_OF_MOVED_TO_ADDRESS_LINE_2" }
      : { sourceReview: "ALIGNED_AUTOMATICALLY" },
    reason: careOfAddress
      ? "Riferimento c/o eBay spostato automaticamente dal nome alla seconda riga dell’indirizzo"
      : input.alignment === "EMAIL_ONLY"
        ? "Variazione limitata all’e-mail eBay, senza modifiche fiscali o d’ordine"
        : "Variazione eBay riallineata con profilo invariato e mapper anagrafico verificato",
    requestId: input.requestId,
  });
  await recomputeBillingCaseStatus(client, input.caseId);
  if (!current.manually_corrected) await refreshInvoiceDraftProjection(client, input.caseId);
  return true;
}
