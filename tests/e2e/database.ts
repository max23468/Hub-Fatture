import pg from "pg";
import { setTimeout as delay } from "node:timers/promises";

function isTransientResetConflict(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "40P01" || error.code === "55P03")
  );
}

async function truncateE2eData(client: pg.Client) {
  await client.query("SET lock_timeout = '2s'");
  const tables = await client.query<{ names: string | null }>(
    `SELECT string_agg(format('%I.%I', schemaname, tablename), ', ' ORDER BY tablename) AS names
       FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  const tableNames = tables.rows[0]?.names;
  if (!tableNames) throw new Error("Il database E2E non contiene tabelle applicative");

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      // Il catalogo è l'autorità sullo schema: anche le tabelle aggiunte da nuove
      // migrazioni vengono isolate automaticamente, senza una lista destinata a scadere.
      await client.query(`TRUNCATE ${tableNames} RESTART IDENTITY CASCADE`);
      return;
    } catch (error) {
      if (!isTransientResetConflict(error) || attempt === 5) throw error;
      await delay(attempt * 100);
    }
  }
}

export async function withResetE2eDatabase(
  databaseUrl: string,
  seed: (client: pg.Client) => Promise<void>,
) {
  if (!new URL(databaseUrl).pathname.endsWith("_test")) {
    throw new Error("Database E2E non isolato");
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // Il server E2E mantiene un pool sul database dedicato. Un reset tra suite
    // può quindi incrociare una richiesta appena conclusa: limitiamo l'attesa e
    // ripetiamo soltanto i conflitti di lock transitori, senza chiudere il pool.
    await truncateE2eData(client);
    await seed(client);
  } finally {
    await client.end();
  }
}
