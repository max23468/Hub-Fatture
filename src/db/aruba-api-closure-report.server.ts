import { getConfig } from "../config.server.ts";
import {
  getArubaApiConnectionStatus,
  getArubaInboundClosureReadiness,
} from "./aruba-api-inbound.server.ts";
import { getArubaApiReconciliationPreview } from "./aruba-api-reconciliation-preview.server.ts";
import { getPool } from "./client.server.ts";

export async function getArubaInboundClosureReport() {
  const config = getConfig();
  const [closure, connection, reconciliation, schema, finalization] = await Promise.all([
    getArubaInboundClosureReadiness(),
    getArubaApiConnectionStatus(),
    getArubaApiReconciliationPreview(),
    getPool().query<{ name: string }>("SELECT max(name) AS name FROM schema_migrations"),
    getPool().query<{
      cutover_recorded: boolean;
      canonical_reconciliation_complete: boolean;
    }>(
      `WITH current_connection AS (
         SELECT id, account_reference,
           CASE WHEN environment = 'PRODUCTION' THEN 'PRODUCTION' ELSE 'MOCK' END AS environment
         FROM connections
         WHERE provider = 'ARUBA' AND environment = $1
       ), cutover AS (
         SELECT max(events.created_at) AS created_at
         FROM audit_events AS events
         JOIN current_connection AS connection ON connection.id::text = events.entity_id
         WHERE events.action = 'ARUBA_API_AUTHORITY_CHANGED'
           AND events.after_json->>'automaticAuthority' = 'API'
       )
       SELECT
         cutover.created_at IS NOT NULL AS cutover_recorded,
         EXISTS (
           SELECT 1 FROM aruba_sync_runs AS runs
           JOIN current_connection AS connection
             ON connection.environment = runs.environment
            AND connection.account_reference = runs.account_reference
           WHERE runs.authority_mode = 'CANONICAL' AND runs.kind = 'TARGETED'
             AND runs.status = 'COMPLETED' AND runs.completed_at >= cutover.created_at
         ) AS canonical_reconciliation_complete
       FROM cutover`,
      [config.APP_ENV === "production" ? "PRODUCTION" : "DEVELOPMENT"],
    ),
  ]);
  const postSwitch = {
    cutoverRecorded: finalization.rows[0]?.cutover_recorded ?? false,
    canonicalReconciliationComplete:
      finalization.rows[0]?.canonical_reconciliation_complete ?? false,
    unresolvedDocuments: reconciliation.unresolvedDocuments,
  };
  const closed =
    connection.automaticAuthority === "API" &&
    postSwitch.cutoverRecorded &&
    postSwitch.canonicalReconciliationComplete &&
    postSwitch.unresolvedDocuments === 0 &&
    closure.gates.NO_ACTIVE_JOBS &&
    closure.gates.NO_ACTIONABLE_FAILURES;
  const finalizing = connection.automaticAuthority === "API" && !closed;
  return {
    status: closed
      ? "CLOSED"
      : finalizing
        ? "FINALIZING"
        : closure.readyForAuthoritySwitch
          ? "READY"
          : "BLOCKED",
    checkedAt: new Date().toISOString(),
    candidate: {
      commit: config.APP_COMMIT_SHA,
      version: config.APP_VERSION,
      schema: schema.rows[0]?.name ?? null,
    },
    authority: connection.automaticAuthority,
    latestRun: connection.latestRun,
    parity: connection.parity,
    closure,
    reconciliation,
    postSwitch,
  };
}
