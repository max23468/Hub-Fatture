import type pg from "pg";

import { isEbayPaymentTimestampOnlyChange } from "../order-source-alignment.ts";
import { writeAudit } from "./audit.server.ts";
import { recomputeBillingCaseStatus } from "./billing-case-status.server.ts";

interface PreviousPaymentOrder {
  billing_case_id: string | null;
  trigger_status: string;
  source_conflict_required: boolean;
  order_review_required: boolean;
  last_observed_snapshot_json: Record<string, unknown>;
  latest_revision_id: string | null;
  latest_revision_previous_snapshot_json: Record<string, unknown> | null;
  latest_revision_current_snapshot_json: Record<string, unknown> | null;
}

export async function reconcileEbayPaymentTimestampChange(
  client: pg.PoolClient,
  input: {
    provider: string;
    documentIssued: boolean;
    oldOrder: PreviousPaymentOrder | undefined;
    fingerprint: string;
    orderId: string;
    requestId: string;
    normalizedSnapshot: Record<string, unknown>;
    fingerprintChanged: boolean;
  },
) {
  const previous = input.oldOrder;
  if (input.documentIssued || input.provider !== "EBAY" || !previous?.billing_case_id) return false;

  const newAlignment =
    input.fingerprintChanged &&
    isEbayPaymentTimestampOnlyChange(
      previous.last_observed_snapshot_json,
      input.normalizedSnapshot,
    );
  const existingAlignment = Boolean(
    !newAlignment &&
    ["NEEDS_REVIEW", "GROUPED"].includes(previous.trigger_status) &&
    previous.source_conflict_required &&
    !previous.order_review_required &&
    previous.latest_revision_id &&
    previous.latest_revision_previous_snapshot_json &&
    previous.latest_revision_current_snapshot_json &&
    previous.latest_revision_current_snapshot_json.reviewFingerprint === input.fingerprint &&
    isEbayPaymentTimestampOnlyChange(
      previous.latest_revision_previous_snapshot_json,
      previous.latest_revision_current_snapshot_json,
    ),
  );
  if (!newAlignment && !existingAlignment) return false;

  if (existingAlignment) {
    const cleared = await client.query(
      `UPDATE orders
       SET trigger_status = CASE WHEN trigger_status = 'NEEDS_REVIEW' THEN 'GROUPED'
                                 ELSE trigger_status END,
           normalized_snapshot_json = jsonb_set(
             normalized_snapshot_json, '{sourceConflictRequired}', 'false'::jsonb)
       WHERE id = $1
         AND trigger_status IN ('NEEDS_REVIEW', 'GROUPED')
         AND coalesce(
           (normalized_snapshot_json ->> 'sourceConflictRequired')::boolean,
           false
         )`,
      [input.orderId],
    );
    if (!cleared.rowCount) return false;
  }

  await writeAudit(client, {
    actorType: "SYSTEM",
    action: "ORDER_SOURCE_REVIEWED",
    eventClass: "CRITICAL",
    entityType: "ORDER",
    entityId: input.orderId,
    metadata: {
      billingCaseId: previous.billing_case_id,
      provider: "EBAY",
      ...(existingAlignment && previous.latest_revision_id
        ? { revisionId: previous.latest_revision_id }
        : {}),
      automaticAlignment: "PAYMENT_TIMESTAMP_ONLY",
    },
    before: { sourceReview: existingAlignment ? "OPEN" : "NOT_OPENED" },
    after: { sourceReview: "ALIGNED_AUTOMATICALLY" },
    reason: "Timestamp eBay del pagamento riallineato nello stesso giorno senza variazioni fiscali",
    requestId: input.requestId,
  });
  if (existingAlignment) await recomputeBillingCaseStatus(client, previous.billing_case_id);
  return true;
}
