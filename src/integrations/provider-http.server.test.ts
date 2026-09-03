import assert from "node:assert/strict";
import test from "node:test";

import { AppError, type ErrorCode } from "../errors.ts";
import { providerJson, providerText } from "./provider-http.server.ts";

async function errorCode(promise: Promise<unknown>): Promise<ErrorCode> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error.code;
  }
  throw new Error("Era atteso un errore applicativo");
}

test("le risposte provider non affidabili usano i codici stabili", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, init) => {
      assert.equal(init?.redirect, "error");
      return new Response(null, { status: 401 });
    };
    assert.equal(
      await errorCode(providerJson("https://provider.invalid")),
      "AUTH_PROVIDER_EXPIRED",
    );

    globalThis.fetch = async () => new Response(null, { status: 429 });
    assert.equal(
      await errorCode(providerJson("https://provider.invalid")),
      "PROVIDER_RATE_LIMITED",
    );

    globalThis.fetch = async () => new Response("{}", { headers: { "content-length": "3" } });
    assert.equal(
      await errorCode(providerJson("https://provider.invalid", {}, { maxBytes: 2 })),
      "PROVIDER_RESPONSE_TOO_LARGE",
    );

    globalThis.fetch = async () => new Response("non-json");
    assert.equal(
      await errorCode(providerJson("https://provider.invalid")),
      "PROVIDER_RESPONSE_INVALID",
    );

    globalThis.fetch = async () => new Response("risposta testuale");
    assert.equal(await providerText("https://provider.invalid"), "risposta testuale");

    globalThis.fetch = async () => {
      throw new Error("timeout");
    };
    assert.equal(await errorCode(providerJson("https://provider.invalid")), "PROVIDER_UNAVAILABLE");

    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("stream interrotto"));
          },
        }),
      );
    assert.equal(await errorCode(providerJson("https://provider.invalid")), "PROVIDER_UNAVAILABLE");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
