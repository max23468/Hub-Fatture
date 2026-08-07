import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.server.ts";

test("la configurazione applica i limiti delle sessioni", () => {
  const base = {
    ADMIN_BOOTSTRAP_TOKEN: "x".repeat(32),
    APP_BASE_URL: "http://localhost:8080",
    APP_ENV: "test",
    DATABASE_URL: "postgres://example.invalid/test",
  };
  assert.equal(parseConfig(base).SESSION_TTL_SECONDS, 28_800);
  assert.throws(() => parseConfig({ ...base, SESSION_TTL_SECONDS: "299" }));
  assert.throws(() =>
    parseConfig({ ...base, APP_ENV: "production", APP_BASE_URL: "http://example.invalid" }),
  );
  assert.equal(
    parseConfig({ ...base, APP_ENV: "production", APP_BASE_URL: "https://example.invalid" })
      .APP_ENV,
    "production",
  );
});
