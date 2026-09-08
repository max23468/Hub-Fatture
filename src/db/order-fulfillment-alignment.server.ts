import type pg from "pg";

import { isFulfillmentOnlyChange } from "../order-source-alignment.ts";
import { writeAudit } from "./audit.server.ts";
import { recomputeBillingCaseStatus } from "./billing-case-status.server.ts";

interface PreviousOrder {
  billing_case_id: string | null;
  trigger_status: string;
  latest_revision_id: string | null;
  latest_revision_previous_snapshot_json: Record<string, unknown> | null;
  latest_revision_current_snapshot_json: Record<string, unknown> | null;
  last_observed_snapshot_json: Record<string, unknown>;
}

export async function reconcileFulfillmentChange(
  client: pg.PoolClient,
  input: {
    provider: "SHOPIFY" | "EBAY";
    oldOrder: PreviousOrder | undefined;
    orderId: string;
    normalizedSnapshot: Record<string, unknown>;
    fingerprint: string;
    fingerprintChanged: boolean;
    documentIssued: boolean;
    requestId: string;
  },
) {
  const oldOrder = input.oldOrder;
  const newChange = Boolean(
    !input.documentIssued &&
    input.fingerprintChanged &&
    oldOrder?.billing_case_id &&
    isFulfillmentOnlyChange(oldOrder.last_observed_snapshot_json, input.normalizedSnapshot),
  );
  const existingConflict = Boolean(
    !input.documentIssued &&
    oldOrder?.billing_case_id &&
    oldOrder.trigger_status === "NEEDS_REVIEW" &&
    oldOrder.latest_revision_id &&
    oldOrder.latest_revision_previous_snapshot_json &&
    oldOrder.latest_revision_current_snapshot_json &&
    oldOrder.latest_revision_current_snapshot_json.reviewFingerprint === input.fingerprint &&
    isFulfillmentOnlyChange(
      oldOrder.latest_revision_previous_snapshot_json,
      oldOrder.latest_revision_current_snapshot_json,
    ),
  );
  if ((!newChange && !existingConflict) || !oldOrder?.billing_case_id) return false;

  const billingCase = await client.query<{ status: string }>(
    `SELECT status FROM billing_cases WHERE id = $1 FOR UPDATE`,
    [oldOrder.billing_case_id],
  );
  const current = billingCase.rows[0];
  if (!current || !["DRAFT", "READY", "NEEDS_REVIEW"].includes(current.status)) return false;
  if (existingConflict) {
    await client.query(
      `UPDATE orders
       SET trigger_status = CASE WHEN trigger_status = 'NEEDS_REVIEW' THEN 'GROUPED'
                                 ELSE trigger_status END,
           normalized_snapshot_json = jsonb_set(
             jsonb_set(normalized_snapshot_json, '{deferredReviewRequired}', 'false'::jsonb),
             '{sourceConflictRequired}', 'false'::jsonb)
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
      billingCaseId: oldOrder.billing_case_id,
      provider: input.provider,
      automaticAlignment: "FULFILLMENT_ONLY",
      ...(existingConflict && oldOrder.latest_revision_id
        ? { revisionId: oldOrder.latest_revision_id }
        : {}),
    },
    before: { sourceReview: existingConflict ? "OPEN" : "NOT_REQUIRED" },
    after: { sourceReview: "ALIGNED_AUTOMATICALLY" },
    reason: `Avanzamento ordinario dell’evasione ${input.provider === "SHOPIFY" ? "Shopify" : "eBay"} senza modifiche economiche o anagrafiche`,
    requestId: input.requestId,
  });
  await recomputeBillingCaseStatus(client, oldOrder.billing_case_id);
  return true;
}
