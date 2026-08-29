import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import { manifestSha256, type ArubaManifest } from "../src/aruba.ts";
import { runHelper, type HelperOptions } from "./aruba-helper.ts";
import { runArubaReadHelper } from "./aruba-read-helper.ts";

const browser = process.argv[2] as HelperOptions["browser"] | undefined;
if (!browser || !["chrome", "msedge"].includes(browser)) {
  throw new Error("Uso: npm run test:aruba:platform -- chrome|msedge");
}

const token = "a".repeat(43);
const xml = await readFile("tests/fixtures/fatturapa/accepted-invoice.anonymized.xml");
const filename = "accepted-invoice.anonymized.xml";
const events: unknown[] = [];
let importedFiles = 0;
let inventoryPages = 0;
let inventoryFiles = 0;
let inventoryCompleted = false;
let preflightCompleted = false;

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
  if (url.pathname === "/api/aruba/sync/manifest") {
    json(200, {
      operation: "READ_SYNC",
      sessionId: "00000000-0000-4000-8000-000000000002",
      environment: "MOCK",
      accountReference: "synthetic-aruba-account",
      accountIdentity: "synthetic-aruba-account",
      panelUrl: `${baseUrl}/aruba-sintetica?scenario=inventory`,
      oldestReconciliationDate: "2026-01-01",
      fullScanRequired: true,
      incrementalOverlapDays: 7,
      streams: [
        {
          name: "invoices:2026",
          cursor: null,
          overlapFrom: null,
          nonTerminalFrom: null,
          incrementalFrom: null,
          lastFullScanCompletedAt: null,
        },
      ],
      intervalSeconds: 900,
      absoluteExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    return;
  }
  if (url.pathname === "/api/aruba/sync/heartbeat") {
    json(200, { ok: true });
    return;
  }
  if (url.pathname === "/api/aruba/sync/preflight" && request.method === "GET") {
    json(200, {
      work: [
        {
          id: "00000000-0000-4000-8000-000000000003",
          request_json: {
            searches: [
              {
                provider: "SHOPIFY",
                displayNumber: "#1001",
                amount: 12345,
                documentType: "TD01",
              },
            ],
          },
        },
      ],
      syncRequestedAt: null,
    });
    return;
  }
  if (url.pathname === "/api/aruba/sync/preflight" && request.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.deepEqual(body.candidateRemoteIds, ["PLATFORM-INBOUND-1"]);
    assert.equal(body.searchesCompleted, true);
    preflightCompleted = true;
    json(200, { passed: false });
    return;
  }
  if (url.pathname === "/api/aruba/sync/pagine") {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(body.stream, "invoices:2026");
    assert.equal(body.fullScan, true);
    assert.equal(body.terminal, true);
    inventoryPages += 1;
    json(200, {
      repeated: false,
      documents: 1,
      requestedFiles: [{ remoteId: "PLATFORM-INBOUND-1", kind: "ARUBA_XML" }],
    });
    return;
  }
  if (url.pathname === "/api/aruba/sync/documenti/PLATFORM-INBOUND-1/file") {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), xml);
    assert.equal(request.headers["x-aruba-file-kind"], "ARUBA_XML");
    inventoryFiles += 1;
    json(200, { ok: true });
    return;
  }
  if (url.pathname === "/api/aruba/sync/completa") {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.deepEqual(body.streams, ["invoices:2026"]);
    assert.equal(body.fullScan, true);
    inventoryCompleted = true;
    json(200, { completed: true });
    return;
  }
  if (url.pathname === "/api/aruba/helper/documenti/1/xml") {
    response.writeHead(200, { "Content-Type": "application/xml" });
    response.end(xml);
    return;
  }
  if (url.pathname === "/api/aruba/helper/verifica-invio") {
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
  if (url.pathname === "/aruba-sintetica" && url.searchParams.get("scenario") === "inventory") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html lang="it"><body>
        <p data-aruba-account="synthetic-aruba-account">Account: synthetic-aruba-account</p>
        <button data-aruba-stream="invoices:2026">Fatture 2026</button>
        <label>Dal <input data-aruba-filter-from name="dataDa" type="date"></label>
        <button>Applica filtri</button>
        <table><tbody><tr
          data-aruba-remote-id="PLATFORM-INBOUND-1"
          data-document-type="TD01"
          data-fiscal-year="2026"
          data-series="FPR"
          data-fiscal-number="1"
          data-document-date="2026-08-10"
          data-recipient-name="Mario Rossi"
          data-recipient-tax-id="RSSMRA80A01H501U"
          data-recipient-country="IT"
          data-recipient-address="Via Cliente 1 00100 Roma IT"
          data-total-cents="12345"
          data-remote-status="DELIVERED"
          data-observed-at="2026-08-12T12:00:00+02:00"
          data-order-references="#1001"
          data-aruba-xml-url="/official.xml"
          data-aruba-pdf-url="/not-requested.pdf"><td>FPR 1</td></tr></tbody></table>
        <button aria-label="Pagina successiva" disabled>Pagina successiva</button>
      </body></html>`);
    return;
  }
  if (url.pathname === "/not-requested.pdf") {
    throw new Error("Il download selettivo non deve richiedere il PDF");
  }
  if (url.pathname === "/aruba-sintetica") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html lang="it"><body>
        <p data-aruba-account="synthetic-aruba-account">Account: synthetic-aruba-account</p>
        <label for="upload">SELEZIONA DOCUMENTI</label><input id="upload" type="file" multiple>
        <table><tbody></tbody></table>
        <button id="send" disabled>INVIA TUTTE</button>
        <script>
          const input = document.querySelector('#upload');
          const send = document.querySelector('#send');
          input.addEventListener('change', () => {
            const row = document.createElement('tr');
            row.dataset.fiscalNumber = 'FPR 0001/26';
            row.dataset.documentDate = '2026-08-10';
            row.dataset.totalCents = '12345';
            row.innerHTML = '<td>${filename} · FPR 0001/26 · 10/08/2026 · 123,45 €</td><td>Documento valido</td>';
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
  mode: "AUTOMATIC_AFTER_APPROVAL" as const,
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
const readProfileDirectory = path.join(os.tmpdir(), `hub-fatture-read-platform-${process.pid}`);
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
  await runArubaReadHelper({
    hubUrl: baseUrl,
    token,
    profileDirectory: readProfileDirectory,
    browser,
    headless: true,
    singleCycle: true,
  });
  assert.equal(inventoryPages, 1);
  assert.equal(inventoryFiles, 1);
  assert.equal(inventoryCompleted, true);
  assert.equal(preflightCompleted, true);
} finally {
  await rm(profileDirectory, { recursive: true, force: true });
  await rm(readProfileDirectory, { recursive: true, force: true });
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
