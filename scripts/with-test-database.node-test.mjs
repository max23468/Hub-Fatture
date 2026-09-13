import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ensureLocalTestDatabase,
  localTestDatabaseName,
  localTestDatabaseUrl,
  prepareTestDatabaseEnvironment,
  runWithTestDatabase,
  testDatabaseLockIdentity,
} from "./with-test-database.mjs";

test("riusa il database esplicito senza avviare Docker", () => {
  let starts = 0;
  const environment = prepareTestDatabaseEnvironment({
    environment: { TEST_DATABASE_URL: "postgres://database-ci.invalid/test" },
    startDatabase() {
      starts += 1;
    },
  });
  assert.equal(environment.TEST_DATABASE_URL, "postgres://database-ci.invalid/test");
  assert.equal(starts, 0);
});

test("avvia PostgreSQL locale e imposta l'URL sintetico quando manca", () => {
  let starts = 0;
  const environment = prepareTestDatabaseEnvironment({
    environment: { PATH: "/bin" },
    worktreePath: "/tmp/Hub-Fatture-controls",
    startDatabase() {
      starts += 1;
    },
  });
  assert.equal(starts, 1);
  assert.equal(environment.TEST_DATABASE_AUTOCREATE, "1");
  assert.equal(
    environment.TEST_DATABASE_URL,
    localTestDatabaseUrl({ PATH: "/bin" }, "/tmp/Hub-Fatture-controls"),
  );
  assert.equal(environment.PATH, "/bin");
});

test("una porta dedicata mantiene isolata la corsia automatica", () => {
  const environment = prepareTestDatabaseEnvironment({
    environment: { PATH: "/bin", TEST_DATABASE_PORT: "55433" },
    worktreePath: "/tmp/Hub-Fatture-controls",
    startDatabase() {},
  });
  assert.equal(
    environment.TEST_DATABASE_URL,
    `postgres://hub_fatture:hub_fatture_test@127.0.0.1:55433/${localTestDatabaseName(
      "/tmp/Hub-Fatture-controls",
    )}`,
  );
  assert.throws(() => localTestDatabaseUrl({ TEST_DATABASE_PORT: "0" }), /porta TCP valida/);
});

test("serializza il gate sul database senza usare credenziali nel lock", async () => {
  const events = [];
  const environment = {
    TEST_DATABASE_URL: "postgres://utente:segreto@127.0.0.1:5433/hub_fatture_test",
  };

  assert.equal(
    testDatabaseLockIdentity(environment.TEST_DATABASE_URL),
    "127.0.0.1:5433/hub_fatture_test",
  );
  const status = await runWithTestDatabase("npm", ["run", "test:db:direct"], environment, {
    createClient({ connectionString }) {
      assert.equal(connectionString, environment.TEST_DATABASE_URL);
      return {
        async connect() {
          events.push("connect");
        },
        async query(statement, values) {
          events.push([statement, values]);
        },
        async end() {
          events.push("end");
        },
      };
    },
    runCommand(command, args, nextEnvironment) {
      events.push(["run", command, args, nextEnvironment]);
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(events, [
    "connect",
    ["SELECT pg_advisory_lock(hashtextextended($1, 0))", ["127.0.0.1:5433/hub_fatture_test"]],
    ["run", "npm", ["run", "test:db:direct"], environment],
    ["SELECT pg_advisory_unlock(hashtextextended($1, 0))", ["127.0.0.1:5433/hub_fatture_test"]],
    "end",
  ]);
});

test("crea una sola volta il database sintetico dedicato al worktree", async () => {
  const events = [];
  const target =
    "postgres://hub_fatture:hub_fatture_test@127.0.0.1:5433/hf_controls_1234567890_test";
  await ensureLocalTestDatabase(target, {
    createClient({ connectionString }) {
      assert.equal(
        connectionString,
        "postgres://hub_fatture:hub_fatture_test@127.0.0.1:5433/hub_fatture_test",
      );
      return {
        async connect() {
          events.push("connect");
        },
        async query(statement, values) {
          events.push([statement, values]);
          if (statement.startsWith("SELECT 1 FROM pg_database")) return { rowCount: 0 };
          return { rowCount: 1 };
        },
        async end() {
          events.push("end");
        },
      };
    },
  });

  assert.deepEqual(events, [
    "connect",
    ["SELECT pg_advisory_lock(hashtextextended($1, 0))", ["hf_controls_1234567890_test"]],
    ["SELECT 1 FROM pg_database WHERE datname = $1", ["hf_controls_1234567890_test"]],
    ['CREATE DATABASE "hf_controls_1234567890_test"', undefined],
    ["SELECT pg_advisory_unlock(hashtextextended($1, 0))", ["hf_controls_1234567890_test"]],
    "end",
  ]);
});

test("trasforma la caduta della connessione al lock in un errore leggibile", async () => {
  let connectionErrorListener;
  const environment = {
    TEST_DATABASE_URL: "postgres://utente:segreto@127.0.0.1:5433/hub_fatture_test",
  };

  await assert.rejects(
    runWithTestDatabase("npm", ["run", "test:db:direct"], environment, {
      createClient() {
        return {
          on(event, listener) {
            assert.equal(event, "error");
            connectionErrorListener = listener;
          },
          async connect() {},
          async query() {},
          async end() {},
        };
      },
      runCommand() {
        connectionErrorListener(new Error("server chiuso"));
        return { status: 1 };
      },
    }),
    /Connessione al database di test interrotta durante il gate/,
  );
});

test("i gate DB ed E2E usano sempre il runner automatico", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(
    packageJson.scripts["test:db"],
    "node scripts/with-test-database.mjs npm run test:db:direct",
  );
  assert.equal(
    packageJson.scripts["test:e2e"],
    "npm run build && node scripts/with-test-database.mjs npm run test:e2e:direct",
  );
  assert.equal(
    packageJson.scripts["test:e2e:release-candidate"],
    "npm run build && node scripts/with-test-database.mjs npm run test:e2e:direct",
  );
});
