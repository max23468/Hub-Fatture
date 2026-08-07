import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "./errors.ts";
import { readForm } from "./http.server.ts";

const contentType = { "content-type": "application/x-www-form-urlencoded" };

process.env.APP_ENV = "test";
process.env.APP_BASE_URL = "https://example.invalid";
process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
process.env.DATABASE_URL = "postgres://example.invalid/test";

test("il body viene limitato prima del parsing", async () => {
  const request = new Request("https://example.invalid", {
    method: "POST",
    headers: { ...contentType, origin: "https://example.invalid" },
    body: "value=12345",
  });
  await assert.rejects(readForm(request, { maxBytes: 5 }), (error: unknown) => {
    return error instanceof AppError && error.code === "REQUEST_BODY_TOO_LARGE";
  });
});

test("un body bloccato scade senza essere parsato", async () => {
  const body = new ReadableStream<Uint8Array>({ start() {} });
  const request = new Request("https://example.invalid", {
    method: "POST",
    headers: { ...contentType, origin: "https://example.invalid" },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  await assert.rejects(readForm(request, { timeoutMs: 5 }), (error: unknown) => {
    return error instanceof AppError && error.code === "REQUEST_TIMEOUT";
  });
});

test("un form da un’origine diversa viene rifiutato", async () => {
  const request = new Request("https://example.invalid", {
    method: "POST",
    headers: { ...contentType, origin: "https://attacker.invalid" },
    body: "value=ok",
  });
  await assert.rejects(readForm(request), (error: unknown) => {
    return error instanceof AppError && error.code === "REQUEST_ORIGIN_INVALID";
  });
});
