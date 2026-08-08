import type pg from "pg";

type AuditAction =
  | "ADMIN_ACCOUNT_CREATED"
  | "LOGIN_FAILED"
  | "LOGIN_SUCCEEDED"
  | "LOGOUT_SUCCEEDED"
  | "BILLING_CASE_CREATED"
  | "ORDER_GROUPED"
  | "ORDER_GROUPING_FORCED"
  | "ORDER_SOURCE_CONFLICT"
  | "ORDER_SOURCE_UPDATED"
  | "ORDER_IMPORTED"
  | "DRAFT_TRIGGER_CHANGED";

export async function writeAudit(
  client: pg.PoolClient,
  event: {
    actorType: "ADMIN" | "SYSTEM";
    actorId?: string | null;
    action: AuditAction;
    eventClass: "CRITICAL" | "OPERATIONAL";
    entityType: "USER" | "ORDER" | "BILLING_CASE" | "SETTING";
    entityId?: string | null;
    metadata?: Partial<{
      billingCaseId: string;
      provider: "SHOPIFY" | "EBAY";
      value: "PAID" | "FULFILLED";
    }>;
    requestId: string;
  },
) {
  await client.query(
    `INSERT INTO audit_events
      (actor_type, actor_id, action, event_class, entity_type, entity_id, metadata_json, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      event.actorType,
      event.actorId ?? null,
      event.action,
      event.eventClass,
      event.entityType,
      event.entityId ?? null,
      JSON.stringify(event.metadata ?? {}),
      event.requestId,
    ],
  );
}
