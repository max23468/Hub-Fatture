import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig, SESSION_TTL_SECONDS } from "./config.server.ts";

test("la configurazione applica i vincoli operativi", () => {
  const base = {
    ADMIN_BOOTSTRAP_TOKEN: "x".repeat(32),
    APP_BASE_URL: "http://localhost:8080",
    APP_ENV: "test",
    ARUBA_ACCOUNT_IDENTITY: "Synthetic Company Account",
    DATABASE_URL: "postgres://example.invalid/test",
  };
  assert.equal(SESSION_TTL_SECONDS, 31_536_000);
  assert.deepEqual(
    parseConfig({ ...base, SMTP_HOST: "", SMTP_PASSWORD: "", SMTP_USERNAME: "" }),
    parseConfig(base),
  );
  assert.throws(() => parseConfig({ ...base, APP_BASE_URL: undefined }));
  assert.equal(parseConfig(base).EBAY_ENVIRONMENT, "sandbox");
  assert.equal(
    parseConfig({ ...base, CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64url") })
      .CREDENTIALS_ENCRYPTION_KEY?.length,
    43,
  );
  assert.throws(() => parseConfig({ ...base, CREDENTIALS_ENCRYPTION_KEY: "troppo-corta" }));
  assert.throws(() =>
    parseConfig({ ...base, APP_ENV: "production", APP_BASE_URL: "http://example.invalid" }),
  );
  assert.throws(() => parseConfig({ ...base, EBAY_ENVIRONMENT: "production" }));
  assert.throws(() =>
    parseConfig({
      ...base,
      APP_ENV: "production",
      APP_BASE_URL: "https://example.invalid",
      ARUBA_ACCOUNT_IDENTITY: "synthetic-aruba-account",
    }),
  );
  assert.throws(() =>
    parseConfig({ ...base, APP_ENV: "production", APP_BASE_URL: "https://example.invalid" }),
  );
  assert.equal(
    parseConfig({
      ...base,
      APP_ENV: "production",
      APP_BASE_URL: "https://example.invalid",
      EBAY_ENVIRONMENT: "production",
      ARUBA_ACCOUNT_REFERENCE: "aruba-account-test",
      SMTP_TRANSPORT: "OCI_EMAIL_DELIVERY",
      SMTP_FROM: "contabilita@numisleo.it",
      SMTP_HOST: "smtp.email.eu-milan-1.oci.oraclecloud.com",
      SMTP_USERNAME: "synthetic-user",
      SMTP_PASSWORD: "synthetic-password",
    }).APP_ENV,
    "production",
  );
  assert.throws(() =>
    parseConfig({
      ...base,
      APP_ENV: "production",
      APP_BASE_URL: "https://example.invalid",
      EBAY_ENVIRONMENT: "production",
      ARUBA_ACCOUNT_REFERENCE: "aruba-account-test",
      SMTP_TRANSPORT: "EXISTING_SMTP",
      SMTP_FROM: "contabilita@numisleo.it",
      SMTP_HOST: "smtp.example.invalid",
      SMTP_USERNAME: "synthetic-user",
      SMTP_PASSWORD: "synthetic-password",
    }),
  );
  assert.throws(() =>
    parseConfig({
      ...base,
      APP_ENV: "production",
      APP_BASE_URL: "https://example.invalid",
      EBAY_ENVIRONMENT: "production",
      ARUBA_ACCOUNT_REFERENCE: "aruba-account-test",
      SMTP_TRANSPORT: "OCI_EMAIL_DELIVERY",
      SMTP_FROM: "contabilita@numisleo.it",
      SMTP_HOST: "smtp.example.invalid",
      SMTP_USERNAME: "synthetic-user",
      SMTP_PASSWORD: "synthetic-password",
    }),
  );
  assert.throws(() =>
    parseConfig({
      ...base,
      APP_ENV: "production",
      APP_BASE_URL: "https://example.invalid",
      EBAY_ENVIRONMENT: "production",
      ARUBA_ACCOUNT_REFERENCE: "aruba-account-test",
      SMTP_TRANSPORT: "OCI_EMAIL_DELIVERY",
      SMTP_HOST: "smtp.email.eu-milan-1.oci.oraclecloud.com",
      SMTP_USERNAME: "synthetic-user",
      SMTP_PASSWORD: "synthetic-password",
    }),
  );
  assert.throws(() =>
    parseConfig({
      ...base,
      APP_ENV: "production",
      APP_BASE_URL: "https://example.invalid",
      EBAY_ENVIRONMENT: "production",
      ARUBA_ACCOUNT_REFERENCE: "aruba-account-test",
      SMTP_TRANSPORT: "OCI_EMAIL_DELIVERY",
      SMTP_FROM: "contabilita@negozio.it",
      SMTP_HOST: "smtp.email.eu-milan-1.oci.oraclecloud.com",
      SMTP_USERNAME: "synthetic-user",
      SMTP_PASSWORD: "synthetic-password",
    }),
  );
});
