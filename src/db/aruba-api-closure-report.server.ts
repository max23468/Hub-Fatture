import { getConfig } from "../config.server.ts";
import {
  getArubaApiConnectionStatus,
  getArubaInboundClosureReadiness,
} from "./aruba-api-inbound.server.ts";
import { getArubaApiReconciliationPreview } from "./aruba-api-reconciliation-preview.server.ts";
import { getPool } from "./client.server.ts";

export async function getArubaInboundClosureReport() {
  const config = getConfig();
  const [closure, connection, reconciliation, schema] = await Promise.all([
    getArubaInboundClosureReadiness(),
    getArubaApiConnectionStatus(),
    getArubaApiReconciliationPreview(),
    getPool().query<{ name: string }>("SELECT max(name) AS name FROM schema_migrations"),
  ]);
  return {
    status: closure.readyForAuthoritySwitch ? "READY" : "BLOCKED",
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
  };
}
