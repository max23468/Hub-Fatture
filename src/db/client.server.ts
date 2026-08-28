import { AsyncLocalStorage } from "node:async_hooks";
import { unlink } from "node:fs/promises";

import pg from "pg";

import { getConfig } from "../config.server.ts";

const { Pool } = pg;
let pool: pg.Pool | undefined;
interface JoinedTransaction {
  client: pg.PoolClient;
  rollbackFiles: Set<string>;
}
const joinedTransaction = new AsyncLocalStorage<JoinedTransaction>();

export function getPool(): pg.Pool {
  return (pool ??= new Pool({ connectionString: getConfig().DATABASE_URL, max: 10 }));
}

export async function checkDatabaseHealth(): Promise<void> {
  await getPool().query("SELECT 1");
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

export async function withTransaction<T>(
  callback: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const joined = joinedTransaction.getStore();
  if (joined) return callback(joined.client);
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

export function registerJoinedTransactionFile(absolutePath: string) {
  joinedTransaction.getStore()?.rollbackFiles.add(absolutePath);
}

export function getJoinedTransactionClient() {
  return joinedTransaction.getStore()?.client;
}

export async function withJoinedTransaction<T>(
  callback: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const active = joinedTransaction.getStore();
  if (active) return callback(active.client);
  const client = await getPool().connect();
  const context: JoinedTransaction = { client, rollbackFiles: new Set() };
  let commitStarted = false;
  try {
    await client.query("BEGIN");
    const result = await joinedTransaction.run(context, () => callback(client));
    commitStarted = true;
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (!commitStarted) {
      await client.query("ROLLBACK").catch(() => undefined);
      await Promise.allSettled([...context.rollbackFiles].map((file) => unlink(file)));
    }
    throw error;
  } finally {
    client.release();
  }
}
