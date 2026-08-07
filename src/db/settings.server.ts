import type pg from "pg";

import { AppError } from "../errors.ts";
import { getPool, withTransaction } from "./client.server.ts";

export async function getSetting<T>(key: string): Promise<{ value: T; version: number } | null> {
  const result = await getPool().query<{ value_json: T; version: number }>(
    "SELECT value_json, version FROM settings WHERE key = $1",
    [key],
  );
  const row = result.rows[0];
  return row ? { value: row.value_json, version: row.version } : null;
}

export async function updateSetting<T>(key: string, value: T, expectedVersion: number) {
  return withTransaction(async (client: pg.PoolClient) => {
    const current = await client.query<{ version: number }>(
      "SELECT version FROM settings WHERE key = $1 FOR UPDATE",
      [key],
    );
    const version = current.rows[0]?.version ?? 0;
    if (version !== expectedVersion) throw new AppError("CONFLICT_REVISION", 409);
    const result = await client.query<{ value_json: T; version: number }>(
      `INSERT INTO settings (key, value_json, version)
       VALUES ($1, $2, 1)
       ON CONFLICT (key) DO UPDATE
       SET value_json = EXCLUDED.value_json, version = settings.version + 1, updated_at = now()
       RETURNING value_json, version`,
      [key, JSON.stringify(value)],
    );
    return { value: result.rows[0]!.value_json, version: result.rows[0]!.version };
  });
}
