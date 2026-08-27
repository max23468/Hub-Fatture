import { z } from "zod";

import { getConfig } from "../config.server.ts";
import { hashToken } from "../crypto.server.ts";
import { AppError } from "../errors.ts";
import { withTransaction } from "./client.server.ts";

export async function failArubaInventory(token: string, rawCode: unknown) {
  const code = z
    .string()
    .regex(/^[A-Z0-9_]{3,100}$/)
    .safeParse(rawCode);
  if (!code.success) throw new AppError("ARUBA_INVENTORY_INVALID", 422);
  return withTransaction(async (client) => {
    const environment = getConfig().APP_ENV === "production" ? "PRODUCTION" : "MOCK";
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `aruba-read:${environment}:${getConfig().ARUBA_ACCOUNT_REFERENCE}`,
    ]);
    const result = await client.query(
      `UPDATE aruba_sync_sessions SET status = 'FAILED', lease_expires_at = NULL, failed_at = now(),
         error_code = $2, error_message_sanitized = 'Sincronizzazione Aruba interrotta'
       WHERE token_hash = $1 AND status IN ('ACTIVE', 'SCANNING')
         AND (completed_at IS NULL OR last_heartbeat_at > completed_at)
       RETURNING id`,
      [hashToken(token), code.data],
    );
    if (result.rows[0]) return { failed: true, ignored: false };
    const completed = await client.query(
      `SELECT 1 FROM aruba_sync_sessions
       WHERE token_hash = $1 AND status IN ('ACTIVE', 'SCANNING', 'COMPLETED')
         AND completed_at IS NOT NULL
         AND (last_heartbeat_at IS NULL OR last_heartbeat_at <= completed_at)`,
      [hashToken(token)],
    );
    if (completed.rows[0]) return { failed: false, ignored: true };
    throw new AppError("ARUBA_READ_SESSION_INVALID", 401);
  });
}
