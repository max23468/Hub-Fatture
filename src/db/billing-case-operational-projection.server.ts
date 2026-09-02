import {
  arubaPotentialMatchSql,
  billingCaseApprovalCandidateSql,
  billingCaseHasApprovedInvoiceOrderSql,
  billingCasePendingPaymentSql,
  customerProfileMismatchSql,
} from "./billing-case-sql.server.ts";

export type OpenBillingCasePool = "APPROVABLE" | "PENDING_PAYMENT" | "REQUIRES_ACTION";

export const openBillingCaseReasonCodes = [
  "PENDING_PAYMENT",
  "ARUBA_INVENTORY_BLOCKED",
  "ARUBA_POTENTIAL_MATCH",
  "CUSTOMER_INCOMPLETE",
  "CUSTOMER_MISMATCH",
  "SOURCE_CONFLICT",
  "TOTALS_MISMATCH",
  "ORDER_NOT_BILLABLE",
  "ALREADY_INVOICED",
  "FISCAL_PROFILE_UNAVAILABLE",
  "DRAFT_REQUIRES_REFRESH",
  "PREPARATION_REVIEW_REQUIRED",
] as const;

export type OpenBillingCaseReasonCode = (typeof openBillingCaseReasonCodes)[number];

export interface OpenBillingCaseProjection {
  operationalPool: OpenBillingCasePool;
  reasonCodes: OpenBillingCaseReasonCode[];
}

export const openBillingCasePoolSql = (
  approvalsGloballyBlockedSql: string,
  billingCaseAlias = "billing_cases",
  approvalCandidateSql = billingCaseApprovalCandidateSql(billingCaseAlias),
) => `CASE
  WHEN ${billingCasePendingPaymentSql(billingCaseAlias)} THEN 'PENDING_PAYMENT'
  WHEN NOT ${approvalsGloballyBlockedSql}
    AND ${approvalCandidateSql} THEN 'APPROVABLE'
  ELSE 'REQUIRES_ACTION'
END`;

/**
 * Restituisce le cause osservabili usando gli stessi predicati della classificazione.
 * L'array non è uno stato fiscale: è una proiezione ricalcolata per spiegare il pool.
 */
export const openBillingCaseReasonCodesSql = (
  approvalsGloballyBlockedSql: string,
  billingCaseAlias = "billing_cases",
) => `array_remove(ARRAY[
  CASE WHEN ${billingCasePendingPaymentSql(billingCaseAlias)}
    THEN 'PENDING_PAYMENT' END,
  CASE WHEN ${approvalsGloballyBlockedSql}
    THEN 'ARUBA_INVENTORY_BLOCKED' END,
  CASE WHEN ${arubaPotentialMatchSql}
    THEN 'ARUBA_POTENTIAL_MATCH' END,
  CASE WHEN coalesce((${billingCaseAlias}.customer_snapshot_json ->> 'reviewRequired')::boolean, true)
    THEN 'CUSTOMER_INCOMPLETE' END,
  CASE WHEN EXISTS (
    SELECT 1 FROM orders
    WHERE orders.billing_case_id = ${billingCaseAlias}.id
      AND ${customerProfileMismatchSql}
  ) THEN 'CUSTOMER_MISMATCH' END,
  CASE WHEN EXISTS (
    SELECT 1 FROM orders
    WHERE orders.billing_case_id = ${billingCaseAlias}.id
      AND (
        coalesce((orders.normalized_snapshot_json ->> 'sourceConflictRequired')::boolean, false)
        OR coalesce((orders.normalized_snapshot_json ->> 'deferredReviewRequired')::boolean, false)
      )
  ) THEN 'SOURCE_CONFLICT' END,
  CASE WHEN EXISTS (
    SELECT 1 FROM orders
    WHERE orders.billing_case_id = ${billingCaseAlias}.id
      AND NOT coalesce((orders.normalized_snapshot_json ->> 'totalsReconciled')::boolean, false)
  ) THEN 'TOTALS_MISMATCH' END,
  CASE WHEN EXISTS (
    SELECT 1 FROM orders
    WHERE orders.billing_case_id = ${billingCaseAlias}.id
      AND (orders.cancelled_at IS NOT NULL OR orders.payment_status = 'REFUNDED')
  ) THEN 'ORDER_NOT_BILLABLE' END,
  CASE WHEN ${billingCaseHasApprovedInvoiceOrderSql(billingCaseAlias)}
    THEN 'ALREADY_INVOICED' END,
  CASE WHEN NOT EXISTS (
    SELECT 1 FROM fiscal_profiles WHERE status IN ('MOCK', 'AUDITED')
  ) THEN 'FISCAL_PROFILE_UNAVAILABLE' END,
  CASE WHEN EXISTS (
    SELECT 1 FROM documents
    WHERE documents.billing_case_id = ${billingCaseAlias}.id
      AND documents.kind = 'INVOICE'
      AND (
        documents.status <> 'DRAFT'
        OR documents.difference_amount <> 0
        OR documents.projection_sha256 = repeat('0', 64)
        OR documents.document_date <>
          (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Rome')::date
      )
  ) THEN 'DRAFT_REQUIRES_REFRESH' END
]::text[], NULL)`;

export function normalizeOpenBillingCaseProjection(input: {
  operational_pool: OpenBillingCasePool;
  reason_codes: string[] | null;
}): OpenBillingCaseProjection {
  const known = new Set<string>(openBillingCaseReasonCodes);
  const reasonCodes = (input.reason_codes ?? []).filter(
    (reason): reason is OpenBillingCaseReasonCode => known.has(reason),
  );
  if (input.operational_pool === "REQUIRES_ACTION" && reasonCodes.length === 0) {
    reasonCodes.push("PREPARATION_REVIEW_REQUIRED");
  }
  return { operationalPool: input.operational_pool, reasonCodes };
}
