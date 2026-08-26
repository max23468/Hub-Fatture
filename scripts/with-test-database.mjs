import { spawnSync } from "node:child_process";
import process from "node:process";

export const LOCAL_TEST_DATABASE_URL =
  "postgres://hub_fatture:hub_fatture_test@127.0.0.1:5433/hub_fatture_test";

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
  startDatabase = startLocalTestDatabase,
} = {}) {
  if (environment.TEST_DATABASE_URL) return { ...environment };
  startDatabase();
  return { ...environment, TEST_DATABASE_URL: LOCAL_TEST_DATABASE_URL };
}

export function runWithTestDatabase(command, args, environment) {
  const result = spawnSync(command, args, { env: environment, stdio: "inherit" });
  if (result.error) throw result.error;
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
      process.exitCode = runWithTestDatabase(command, args, environment);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Database di test non disponibile");
      process.exitCode = 1;
    }
  }
}
