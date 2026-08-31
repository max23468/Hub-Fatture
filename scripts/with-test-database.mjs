import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import pg from "pg";

const LOCAL_TEST_DATABASE_ROOT_URL =
  "postgres://hub_fatture:hub_fatture_test@127.0.0.1:5433/hub_fatture_test";

export function localTestDatabaseName(worktreePath = process.cwd()) {
  const slug = path
    .basename(worktreePath)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .slice(0, 28);
  const fingerprint = createHash("sha256")
    .update(path.resolve(worktreePath))
    .digest("hex")
    .slice(0, 10);
  return `hf_${slug || "worktree"}_${fingerprint}_test`;
}

export function localTestDatabaseUrl(environment = process.env, worktreePath = process.cwd()) {
  const port = Number(environment.TEST_DATABASE_PORT ?? 5433);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("TEST_DATABASE_PORT deve essere una porta TCP valida");
  }
  const databaseUrl = new URL(LOCAL_TEST_DATABASE_ROOT_URL);
  databaseUrl.port = String(port);
  databaseUrl.pathname = `/${localTestDatabaseName(worktreePath)}`;
  return databaseUrl.toString();
}

function startLocalTestDatabase() {
  const result = spawnSync(
    "docker",
    ["compose", "--profile", "test", "up", "-d", "--wait", "postgres-test"],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error("Avvio automatico del database PostgreSQL di test non riuscito");
  }
}

export function prepareTestDatabaseEnvironment({
  environment = process.env,
  worktreePath = process.cwd(),
  startDatabase = startLocalTestDatabase,
} = {}) {
  if (environment.TEST_DATABASE_URL) return { ...environment };
  startDatabase();
  return {
    ...environment,
    TEST_DATABASE_AUTOCREATE: "1",
    TEST_DATABASE_URL: localTestDatabaseUrl(environment, worktreePath),
  };
}

export function testDatabaseLockIdentity(connectionString) {
  const databaseUrl = new URL(connectionString);
  return `${databaseUrl.hostname}:${databaseUrl.port || "5432"}${databaseUrl.pathname}`;
}

export async function ensureLocalTestDatabase(
  connectionString,
  { createClient = (options) => new pg.Client(options) } = {},
) {
  const targetUrl = new URL(connectionString);
  const databaseName = targetUrl.pathname.slice(1);
  const administrationUrl = new URL(connectionString);
  administrationUrl.pathname = "/hub_fatture_test";
  const client = createClient({ connectionString: administrationUrl.toString() });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [databaseName]);
    const database = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      databaseName,
    ]);
    if (database.rowCount === 0) {
      await client.query(`CREATE DATABASE ${pg.escapeIdentifier(databaseName)}`);
    }
    await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [databaseName]);
  } finally {
    await client.end();
  }
}

export async function runWithTestDatabase(
  command,
  args,
  environment,
  {
    createClient = (options) => new pg.Client(options),
    ensureDatabase = ensureLocalTestDatabase,
    runCommand = (nextCommand, nextArgs, nextEnvironment) =>
      spawnSync(nextCommand, nextArgs, { env: nextEnvironment, stdio: "inherit" }),
  } = {},
) {
  const connectionString = environment.TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TEST_DATABASE_URL assente nel runner automatico");
  if (environment.TEST_DATABASE_AUTOCREATE === "1") {
    await ensureDatabase(connectionString);
  }

  // Ogni worktree ha un database sintetico distinto. Il lock resta detenuto per
  // l'intero comando, così due gate dello stesso checkout non possono comunque
  // azzerare lo schema mentre il primo server E2E sta ancora rispondendo.
  const client = createClient({ connectionString });
  const lockIdentity = testDatabaseLockIdentity(connectionString);
  let connectionError;
  client.on?.("error", (error) => {
    connectionError ??= error;
  });
  await client.connect();
  await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockIdentity]);

  let result;
  let commandError;
  try {
    result = runCommand(command, args, environment);
    if (result.error) throw result.error;
  } catch (error) {
    commandError = error;
  } finally {
    try {
      if (!connectionError) {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockIdentity]);
      }
    } catch (error) {
      connectionError ??= error;
    }
    try {
      await client.end();
    } catch (error) {
      connectionError ??= error;
    }
  }
  if (commandError) throw commandError;
  if (connectionError) {
    throw new Error("Connessione al database di test interrotta durante il gate", {
      cause: connectionError,
    });
  }
  return result.status ?? 1;
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error("Uso: node scripts/with-test-database.mjs <comando> [argomenti...]");
    process.exitCode = 2;
  } else {
    try {
      const environment = prepareTestDatabaseEnvironment();
      process.exitCode = await runWithTestDatabase(command, args, environment);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Database di test non disponibile");
      process.exitCode = 1;
    }
  }
}
