import type pg from "pg";

export const auditActions = [
  "ADMIN_ACCOUNT_CREATED",
  "BILLING_CASE_CREATED",
  "BILLING_CASE_DO_NOT_TRANSMIT",
  "BILLING_CASE_REACTIVATED",
  "CUSTOMER_CORRECTED",
  "DRAFT_TRIGGER_CHANGED",
  "LOGIN_FAILED",
  "LOGIN_RATE_LIMITED",
  "LOGIN_SUCCEEDED",
  "LOGOUT_SUCCEEDED",
  "ORDER_GROUPED",
  "ORDER_GROUPING_FORCED",
  "ORDER_IMPORTED",
  "ORDER_SEPARATED",
  "ORDER_SOURCE_CONFLICT",
  "ORDER_SOURCE_UPDATED",
  "PROVIDER_CONNECTED",
  "PROVIDER_REVOKED",
  "CONNECTOR_JOB_RETRIED",
  "SHOPIFY_DATA_REQUEST_COMPLETED",
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
      | "JOB";
    entityId?: string | null;
    metadata?: Partial<{
      billingCaseId: string;
      revisionId: string;
      reason: string;
      reviewRequired: boolean;
      provider: "SHOPIFY" | "EBAY";
      scope: string;
      value: "PAID" | "FULFILLED";
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
