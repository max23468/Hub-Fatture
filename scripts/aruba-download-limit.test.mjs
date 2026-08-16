import assert from "node:assert/strict";
import test from "node:test";

import { request } from "playwright";

import { ARUBA_PANEL_ORIGIN } from "../src/aruba.ts";
import {
  installBoundedArubaRequestGet,
  readBoundedResponse,
} from "./aruba-download-limit.ts";

test("il download streaming Aruba conserva un body entro limite", async () => {
  const response = new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { "Content-Length": "3" },
  });
  assert.deepEqual(await readBoundedResponse(response, 4), Buffer.from([1, 2, 3]));
});

test("il download streaming Aruba rifiuta Content-Length oltre limite", async () => {
  const response = new Response(new Uint8Array([1]), {
    status: 200,
    headers: { "Content-Length": "10" },
  });
  await assert.rejects(() => readBoundedResponse(response, 4), /OFFICIAL_FILE_DOWNLOAD_FAILED/);
});

test("il download streaming Aruba interrompe un body senza Content-Length oltre limite", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5, 6]));
      controller.close();
    },
  });
  await assert.rejects(
    () => readBoundedResponse(new Response(stream, { status: 200 }), 5),
    /OFFICIAL_FILE_DOWNLOAD_FAILED/,
  );
});

test("l'intercettore bounded sostituisce davvero APIRequestContext.get di Playwright", async () => {
  const api = await request.newContext();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), redirect: init?.redirect });
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "Content-Length": "3" },
    });
  };
  try {
    installBoundedArubaRequestGet({
      request: api,
      cookies: async () => [],
      pages: () => [],
    });
    const response = await api.get(`${ARUBA_PANEL_ORIGIN}/bounded.xml`);
    assert.equal(response.ok(), true);
    assert.deepEqual(await response.body(), Buffer.from([1, 2, 3]));
    assert.deepEqual(calls, [
      { url: `${ARUBA_PANEL_ORIGIN}/bounded.xml`, redirect: "manual" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await api.dispose();
  }
});

test("l'intercettore Playwright blocca il body Aruba prima di materializzarlo oltre 4,9 MB", async () => {
  const api = await request.newContext();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(new Uint8Array([1]), {
      status: 200,
      headers: { "Content-Length": "4900001" },
    });
  try {
    installBoundedArubaRequestGet({
      request: api,
      cookies: async () => [],
      pages: () => [],
    });
    await assert.rejects(
      () => api.get(`${ARUBA_PANEL_ORIGIN}/oversized.xml`),
      /OFFICIAL_FILE_DOWNLOAD_FAILED/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await api.dispose();
  }
});
