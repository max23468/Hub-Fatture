import pg from "pg";

import { getConfig } from "../config.server.ts";

const { Pool } = pg;
let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  return (pool ??= new Pool({ connectionString: getConfig().DATABASE_URL, max: 10 }));
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

export async function withTransaction<T>(
  callback: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
