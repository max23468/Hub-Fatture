import type pg from "pg";

export const auditActions = [
  "ACCOUNT_PASSWORD_CHANGED",
  "ACCOUNT_SESSIONS_REVOKED",
  "ADMIN_ACCOUNT_CREATED",
  "BILLING_CASE_CREATED",
  "BILLING_CASE_DO_NOT_TRANSMIT",
  "BILLING_CASE_REACTIVATED",
  "CUSTOMER_CORRECTED",
  "DRAFT_TRIGGER_CHANGED",
  "SHOPIFY_PAYMENT_FEE_MODE_CHANGED",
  "DOCUMENT_APPROVED",
  "DOCUMENT_AMOUNT_DIFFERENCE_CONFIRMED",
  "DOCUMENT_DRAFT_SAVED",
  "DOCUMENT_NUMBERED",
  "DOCUMENT_PENDING_PAYMENT_CONFIRMED",
  "FISCAL_PROFILE_ACTIVATED",
  "REFUND_APPLIED_BEFORE_ISSUE",
  "REFUND_REVERSED_BEFORE_ISSUE",
  "REFUND_NEEDS_REVIEW",
  "REFUND_CREDIT_NOTE_LINKED",
  "REFUND_CREDIT_NOTE_UPDATED",
  "CUSTOMER_EMAIL_SETTINGS_CHANGED",
  "CUSTOMER_EMAIL_QUEUED",
  "CUSTOMER_EMAIL_SENT",
  "CUSTOMER_EMAIL_FAILED",
  "CUSTOMER_EMAIL_REQUEUED",
  "ARUBA_BATCH_CREATED",
  "ARUBA_HELPER_TOKEN_CREATED",
  "ARUBA_UPLOAD_VALIDATED",
  "ARUBA_VALIDATION_FAILED",
  "ARUBA_ASSISTED_STOPPED",
  "ARUBA_SEND_PERMIT_CREATED",
  "ARUBA_SEND_PERMIT_CONSUMED",
  "ARUBA_RECONCILIATION_REQUIRED",
  "ARUBA_READBACK_RECONCILED",
  "ARUBA_FILE_IMPORTED",
  "ARUBA_SETTINGS_CHANGED",
  "LOGIN_FAILED",
  "LOGIN_RATE_LIMITED",
  "LOGIN_SUCCEEDED",
  "LOGOUT_SUCCEEDED",
  "ORDER_GROUPED",
  "ORDER_GROUPING_FORCED",
  "ORDER_HISTORY_RECONCILED",
  "ORDER_IMPORTED",
  "ORDER_SEPARATED",
  "ORDER_SOURCE_CONFLICT",
  "ORDER_SOURCE_REVIEWED",
  "ORDER_SOURCE_UPDATED",
  "PROVIDER_CONNECTED",
  "PROVIDER_REVOKED",
  "CONNECTOR_JOB_RETRIED",
  "SHOPIFY_DATA_REQUEST_COMPLETED",
  "RETENTION_APPLIED",
] as const;

export type AuditAction = (typeof auditActions)[number];

export async function writeAudit(
  client: pg.PoolClient,
  event: {
    actorType: "ADMIN" | "SYSTEM";
    actorId?: string | null;
    action: AuditAction;
    eventClass: "CRITICAL" | "OPERATIONAL";
    entityType:
      | "USER"
      | "ORDER"
      | "BILLING_CASE"
      | "SETTING"
      | "WEBHOOK_EVENT"
      | "CONNECTION"
      | "JOB"
      | "DOCUMENT"
      | "ARUBA_BATCH"
      | "ARUBA_SUBMISSION"
      | "FISCAL_PROFILE"
      | "REFUND"
      | "EMAIL_DELIVERY";
    entityId?: string | null;
    metadata?: Partial<{
      billingCaseId: string;
      revisionId: string;
      reason: string;
      reviewRequired: boolean;
      provider: "SHOPIFY" | "EBAY";
      scope: string;
      value: "PAID" | "FULFILLED";
      documentKind: "INVOICE" | "CREDIT_NOTE";
      fiscalNumber: string;
      fiscalProfileVersion: number;
      lastObservedYear: number;
      lastObservedNumber: number;
      batchId: string;
      manifestSha256: string;
      documentCount: number;
      arubaMode: "ASSISTED" | "AUTOMATIC";
      fileKind: "ARUBA_XML" | "ARUBA_P7M" | "ARUBA_PDF" | "SDI_NOTIFICATION";
      dataClass:
        | "SOURCE_PAYLOADS"
        | "OPERATIONAL_JOBS"
        | "OPERATIONAL_AUDIT"
        | "CUSTOMER_EMAIL"
        | "ARUBA_CREDENTIALS";
      affectedCount: number;
    }>;
    /** Solo campi anagrafici allowlisted o riferimenti a snapshot: mai token o payload integrali. */
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    reason?: string | null;
    requestId: string;
  },
) {
  await client.query(
    `INSERT INTO audit_events
      (actor_type, actor_id, action, event_class, entity_type, entity_id, metadata_json,
       before_json, after_json, reason, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      event.actorType,
      event.actorId ?? null,
      event.action,
      event.eventClass,
      event.entityType,
      event.entityId ?? null,
      JSON.stringify(event.metadata ?? {}),
      event.before ? JSON.stringify(event.before) : null,
      event.after ? JSON.stringify(event.after) : null,
      event.reason ?? null,
      event.requestId,
    ],
  );
}
