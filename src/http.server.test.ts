import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "./errors.ts";
import {
  allowedOrigins,
  readArubaInventoryForm,
  readForm,
  securePrivateHeaders,
} from "./http.server.ts";

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

test("i due loopback locali valgono come stessa origine, Production no", () => {
  assert.deepEqual(
    [...allowedOrigins("http://localhost:8080", "development")],
    ["http://localhost:8080", "http://127.0.0.1:8080"],
  );
  assert.deepEqual(
    [...allowedOrigins("http://127.0.0.1:4173", "test")],
    ["http://127.0.0.1:4173", "http://localhost:4173"],
  );
  assert.deepEqual(
    [...allowedOrigins("https://hub.example.invalid", "production")],
    ["https://hub.example.invalid"],
  );
  assert.deepEqual(
    [...allowedOrigins("http://localhost:8080", "production")],
    ["http://localhost:8080"],
  );
});

test("le risposte private non restano nella cache", () => {
  const headers = new Headers({ Vary: "Accept-Encoding" });
  securePrivateHeaders(headers);
  assert.equal(headers.get("Cache-Control"), "no-store, private");
  assert.equal(headers.get("Vary"), "Accept-Encoding, Cookie");
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

test("il limite vale anche senza Content-Length dichiarato", async () => {
  const oversized = new TextEncoder().encode("value=".concat("x".repeat(64)));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(oversized);
      controller.close();
    },
  });
  const request = new Request("https://example.invalid", {
    method: "POST",
    headers: { ...contentType, origin: "https://example.invalid" },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  await assert.rejects(readForm(request, { maxBytes: 8 }), (error: unknown) => {
    return error instanceof AppError && error.code === "REQUEST_BODY_TOO_LARGE";
  });
});

test("l’inventario Aruba accetta form completi oltre il limite ordinario", async () => {
  const value = "x".repeat(32 * 1024);
  const form = new Request("https://example.invalid", {
    method: "POST",
    headers: { ...contentType, origin: "https://example.invalid" },
    body: new URLSearchParams({ pagesJson: value }),
  });
  assert.equal((await readArubaInventoryForm(form)).get("pagesJson")?.length, value.length);
});
