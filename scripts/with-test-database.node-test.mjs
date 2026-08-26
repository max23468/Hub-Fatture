import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { LOCAL_TEST_DATABASE_URL, prepareTestDatabaseEnvironment } from "./with-test-database.mjs";

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
    startDatabase() {
      starts += 1;
    },
  });
  assert.equal(starts, 1);
  assert.equal(environment.TEST_DATABASE_URL, LOCAL_TEST_DATABASE_URL);
  assert.equal(environment.PATH, "/bin");
});

test("i gate DB ed E2E usano sempre il runner automatico", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(
    packageJson.scripts["test:db"],
    "node scripts/with-test-database.mjs npm run test:db:direct",
  );
  assert.equal(
    packageJson.scripts["test:e2e"],
    "node scripts/with-test-database.mjs npm run test:e2e:direct",
  );
  assert.equal(
    packageJson.scripts["test:e2e:release-candidate"],
    "node scripts/with-test-database.mjs npm run test:e2e:direct",
  );
});
