import type pg from "pg";

export const auditActions = [
  "ACCOUNT_PASSWORD_CHANGED",
  "ACCOUNT_SESSIONS_REVOKED",
  "ADMIN_ACCOUNT_CREATED",
  "BILLING_CASE_CREATED",
  "BILLING_CASE_DO_NOT_TRANSMIT",
  "BILLING_CASE_INVOICED_ORDERS_RECONCILED",
  "BILLING_CASE_ARUBA_IDENTITY_EVIDENCE_RECONCILED",
  "BILLING_CASE_REACTIVATED",
  "CUSTOMER_CORRECTED",
  "CUSTOMER_IDENTITY_EXCEPTION_ACCEPTED",
  "CUSTOMER_IDENTITY_EXCEPTION_APPLIED",
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
  "CUSTOMER_EMAIL_SUPPRESSED",
  "CUSTOMER_EMAIL_SENT",
  "CUSTOMER_EMAIL_FAILED",
  "CUSTOMER_EMAIL_REQUEUED",
  "ARUBA_BATCH_CREATED",
  "ARUBA_HELPER_TOKEN_CREATED",
  "ARUBA_UPLOAD_VALIDATED",
  "ARUBA_VALIDATION_FAILED",
  "ARUBA_ASSISTED_STOPPED",
  "ARUBA_SEND_AUTHORIZATION_VERIFIED",
  "ARUBA_RECONCILIATION_REQUIRED",
  "ARUBA_READBACK_RECONCILED",
  "ARUBA_FILE_IMPORTED",
  "ARUBA_API_CREDENTIALS_CHANGED",
  "ARUBA_API_CONTROLS_CHANGED",
  "ARUBA_API_SYNC_REQUESTED",
  "ARUBA_API_AUTHORITY_CHANGED",
  "ARUBA_API_BATCH_CONFIRMED",
  "ARUBA_API_DRY_RUN_AUTHORIZED",
  "ARUBA_API_DRY_RUN_STARTED",
  "ARUBA_API_DRY_RUN_COMPLETED",
  "ARUBA_API_DRY_RUN_FAILED",
  "ARUBA_API_DRY_RUN_UNKNOWN",
  "ARUBA_SETTINGS_CHANGED",
  "ARUBA_READ_SESSION_ISSUED",
  "ARUBA_INVENTORY_COMPLETED",
  "ARUBA_DOCUMENT_MATCH_RESOLVED",
  "ARUBA_DOCUMENT_CONFIRMED_OUT_OF_SCOPE",
  "ARUBA_PREFLIGHT_OVERRIDDEN",
  "LOGIN_FAILED",
  "LOGIN_RATE_LIMITED",
  "LOGIN_SUCCEEDED",
  "LOGOUT_SUCCEEDED",
  "ORDER_GROUPED",
  "ORDER_GROUPING_FORCED",
  "ORDER_HISTORY_RECONCILED",
  "ORDER_ALREADY_INVOICED_RECONCILED",
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
      | "ARUBA_SYNC_SESSION"
      | "ARUBA_REMOTE_DOCUMENT"
      | "ARUBA_PREFLIGHT_RECEIPT"
      | "ARUBA_SUBMISSION_ATTEMPT"
      | "FISCAL_PROFILE"
      | "REFUND"
      | "EMAIL_DELIVERY"
      | "CUSTOMER";
    entityId?: string | null;
    metadata?: Partial<{
      billingCaseId: string;
      revisionId: string;
      reason: string;
      reviewRequired: boolean;
      provider: "SHOPIFY" | "EBAY" | "ARUBA";
      automaticAlignment: "EMAIL_ONLY" | "EMAIL_AND_MAPPER" | "FULFILLMENT_ONLY" | "REFUND_MAPPER";
      credentialOperation: "CONFIGURED" | "ROTATED" | "REVOKED";
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
      arubaMode: "DOCUMENT_ONLY" | "CONTEXTUAL_CONFIRMATION" | "AUTOMATIC_AFTER_APPROVAL";
      fileKind: "ARUBA_XML" | "ARUBA_P7M" | "ARUBA_PDF" | "SDI_NOTIFICATION";
      dataClass: "SOURCE_PAYLOADS" | "OPERATIONAL_JOBS" | "OPERATIONAL_AUDIT" | "CUSTOMER_EMAIL";
      affectedCount: number;
      environment: "MOCK" | "PRODUCTION";
      deviceIdSuffix: string;
      streamCount: number;
      fullScan: boolean;
      readbackId: string;
      freshnessAgeMinutes: number;
      draftVersion: number;
      projectionSha256: string;
      endpoint: "/services/invoice/upload";
      requestLimit: 1;
      recoveredAfterRestart: boolean;
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
