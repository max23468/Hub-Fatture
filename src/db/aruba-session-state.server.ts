import { hashToken } from "../crypto.server.ts";
import { getPool } from "./client.server.ts";

/**
 * Registra un completamento inventario incompleto dopo il rollback della transazione
 * che ne ha rilevato la causa. La scrittura deve avvenire fuori da quella transazione:
 * altrimenti l'eccezione che restituisce il 409 annullerebbe anche lo stato diagnostico.
 */
export async function markArubaInventoryIncomplete(token: string): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE aruba_sync_sessions
     SET status = 'INCOMPLETE', lease_expires_at = NULL, failed_at = now(),
         error_code = 'ARUBA_INVENTORY_INCOMPLETE',
         error_message_sanitized = 'Stream incompleti'
     WHERE token_hash = $1 AND status IN ('ACTIVE', 'SCANNING')
     RETURNING id`,
    [hashToken(token)],
  );
  return Boolean(result.rows[0]);
}
