import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import { manifestSha256, type ArubaManifest } from "../src/aruba.ts";
import { runHelper, type HelperOptions } from "./aruba-helper.ts";

const browser = process.argv[2] as HelperOptions["browser"] | undefined;
if (!browser || !["chrome", "msedge"].includes(browser)) {
  throw new Error("Uso: npm run test:aruba:platform -- chrome|msedge");
}

const token = "a".repeat(43);
const xml = await readFile("tests/fixtures/fatturapa/accepted-invoice.anonymized.xml");
const filename = "accepted-invoice.anonymized.xml";
const events: unknown[] = [];
let importedFiles = 0;

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  const json = (status: number, value: unknown) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  };
  if (url.pathname.startsWith("/api/") && request.headers.authorization !== `Bearer ${token}`) {
    json(401, { code: "ARUBA_HELPER_TOKEN_INVALID" });
    return;
  }
  if (url.pathname === "/api/aruba/helper/manifest") {
    json(200, manifest);
    return;
  }
  if (url.pathname === "/api/aruba/helper/documenti/1/xml") {
    response.writeHead(200, { "Content-Type": "application/xml" });
    response.end(xml);
    return;
  }
  if (url.pathname === "/api/aruba/helper/consuma-permesso") {
    json(200, { ok: true });
    return;
  }
  if (url.pathname === "/api/aruba/helper/eventi") {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    events.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    json(200, { ok: true });
    return;
  }
  if (url.pathname === "/api/aruba/helper/documenti/1/file") {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), xml);
    assert.equal(request.headers["x-aruba-file-kind"], "ARUBA_XML");
    importedFiles += 1;
    json(200, { ok: true });
    return;
  }
  if (url.pathname === "/official.xml") {
    response.writeHead(200, {
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Type": "application/xml",
    });
    response.end(xml);
    return;
  }
  if (url.pathname === "/aruba-sintetica") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html lang="it"><body>
        <p data-aruba-account="synthetic-aruba-account">Account: synthetic-aruba-account</p>
        <label for="upload">Seleziona documenti</label><input id="upload" type="file" multiple>
        <table><tbody></tbody></table>
        <button id="send" disabled>Invia</button>
        <script>
          const input = document.querySelector('#upload');
          const send = document.querySelector('#send');
          input.addEventListener('change', () => {
            const row = document.createElement('tr');
            row.dataset.fiscalNumber = 'FPR 0001/26';
            row.dataset.documentDate = '2026-08-10';
            row.dataset.totalCents = '12345';
            row.innerHTML = '<td>${filename} · FPR 0001/26 · 2026-08-10 · 123.45</td><td>Documento valido</td>';
            document.querySelector('tbody').append(row);
            send.disabled = false;
          });
          send.addEventListener('click', () => {
            const row = document.querySelector('tr');
            row.dataset.remoteId = 'PLATFORM-REMOTE-1';
            row.children[1].textContent = 'Inviato · ID Aruba: PLATFORM-REMOTE-1';
            const link = document.createElement('a');
            link.textContent = 'Scarica XML';
            link.href = '/official.xml';
            row.children[1].append(link);
          });
        </script>
      </body></html>`);
    return;
  }
  response.writeHead(404).end();
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Server sintetico non disponibile");
const baseUrl = `http://127.0.0.1:${address.port}`;
const payload = {
  batchId: "00000000-0000-4000-8000-000000000001",
  environment: "MOCK" as const,
  mode: "AUTOMATIC" as const,
  accountReference: "synthetic-aruba-account",
  attemptNumber: 1,
  documents: [
    {
      id: "1",
      revision: 1,
      sha256: createHash("sha256").update(xml).digest("hex"),
      filename,
      sizeBytes: xml.byteLength,
      fiscalNumber: "FPR 0001/26",
      documentDate: "2026-08-10",
      totalAmount: 12_345,
    },
  ],
};
const manifest: ArubaManifest = {
  ...payload,
  operation: "UPLOAD",
  manifestSha256: manifestSha256(payload),
  panelUrl: `${baseUrl}/aruba-sintetica`,
};
const profileDirectory = path.join(os.tmpdir(), `hub-fatture-platform-${process.pid}`);
try {
  assert.equal(
    await runHelper({
      hubUrl: baseUrl,
      token,
      profileDirectory,
      browser,
      headless: true,
      closeAfterStop: true,
    }),
    "SUBMITTED",
  );
  assert.deepEqual(
    events.map((event) => (event as { type: string }).type),
    ["HELPER_STARTED", "VALIDATION", "SUBMITTED", "READBACK"],
  );
  assert.equal(
    (events[2] as { remoteIds: Record<string, string> }).remoteIds["1"],
    "PLATFORM-REMOTE-1",
  );
  assert.equal(importedFiles, 1);
} finally {
  await rm(profileDirectory, { recursive: true, force: true });
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
