import assert from "node:assert/strict";
import test from "node:test";

import { readBoundedResponse } from "./aruba-download-limit.ts";

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
