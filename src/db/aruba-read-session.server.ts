import type pg from "pg";

import { hashToken } from "../crypto.server.ts";
import { AppError } from "../errors.ts";

export interface ArubaReadSessionRow {
  id: string;
  environment: "MOCK" | "PRODUCTION";
  account_reference: string;
  device_id: string;
  token_hash: string;
  status: string;
  started_at: Date;
  absolute_expires_at: Date;
  inventory_watermark: string;
}

export async function loadArubaReadSession(
  client: pg.Pool | pg.PoolClient,
  token: string,
  lock = false,
): Promise<ArubaReadSessionRow | null> {
  const match = /^([A-Za-z0-9_-]{16,100})\.[A-Za-z0-9_-]{43}$/.exec(token);
  if (!match) return null;
  const result = await client.query<ArubaReadSessionRow>(
    `SELECT * FROM aruba_sync_sessions
     WHERE token_hash = $1 AND device_id = $2 AND status IN ('ACTIVE', 'SCANNING')
       AND absolute_expires_at > now() AND lease_expires_at > now()
     ${lock ? "FOR UPDATE" : ""}`,
    [hashToken(token), match[1]],
  );
  return result.rows[0] ?? null;
}

export function arubaReadBearer(request: Request): string {
  const match = /^Bearer ([A-Za-z0-9_-]{16,100}\.[A-Za-z0-9_-]{43})$/.exec(
    request.headers.get("authorization") ?? "",
  );
  if (!match) throw new AppError("ARUBA_READ_SESSION_INVALID", 401);
  return match[1]!;
}
