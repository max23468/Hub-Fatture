import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../errors.ts";
import {
  assertEbayDeletionRequestAllowed,
  assertEbayPublicKeyRequestAllowed,
  processEbayAccountDeletion,
} from "./ebay.server.ts";

process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
process.env.APP_BASE_URL = "http://localhost:8080";
process.env.APP_ENV = "test";
process.env.DATABASE_URL = "postgres://example.invalid/test";
process.env.EBAY_CLIENT_ID = "client-sintetico";
process.env.EBAY_CLIENT_SECRET = "secret-sintetico";
process.env.EBAY_ENVIRONMENT = "sandbox";

test("il webhook eBay limita l'origine prima del recupero della chiave", () => {
  const origin = `origine-${Date.now()}`;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.doesNotThrow(() => assertEbayDeletionRequestAllowed(origin));
  }
  assert.throws(
    () => assertEbayDeletionRequestAllowed(origin),
    (error) => error instanceof AppError && error.code === "PROVIDER_RATE_LIMITED",
  );
});

test("un kid eBay fallito usa la negative cache", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  try {
    globalThis.fetch = async () => {
      requests += 1;
      if (requests === 1) {
        return Response.json({ access_token: "token-sintetico", expires_in: 3600 });
      }
      return new Response("{}", { status: 404 });
    };
    const signatureHeader = Buffer.from(
      JSON.stringify({ kid: `inesistente-${Date.now()}`, signature: "AA==" }),
    ).toString("base64");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        processEbayAccountDeletion(Buffer.from("{}"), signatureHeader),
        (error) => error instanceof AppError && error.code === "WEBHOOK_SIGNATURE_INVALID",
      );
    }
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("i kid eBay distinti condividono un budget globale", () => {
  const start = Date.now() + 60_001;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    assert.doesNotThrow(() => assertEbayPublicKeyRequestAllowed(start));
  }
  assert.throws(
    () => assertEbayPublicKeyRequestAllowed(start),
    (error) => error instanceof AppError && error.code === "PROVIDER_RATE_LIMITED",
  );
});
