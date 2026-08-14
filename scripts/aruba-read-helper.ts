import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { chromium, type BrowserContext, type Locator, type Page } from "playwright";

import { assertAccount } from "./aruba-helper.ts";

import {
  ARUBA_PANEL_ORIGIN,
  assertAllowedArubaDownload,
  assertAllowedArubaAuthenticationNavigation,
  assertAllowedArubaNavigation,
  assertAllowedArubaTarget,
  assertAllowedHubUrl,
} from "../src/aruba.ts";
import {
  inventoryPageSchema,
  remoteMatchesPreflightSearches,
  type RemoteInventoryDocument,
} from "../src/aruba-inbound.ts";

export interface ArubaReadManifest {
  operation: "READ_SYNC";
  sessionId: string;
  environment: "MOCK" | "PRODUCTION";
  accountReference: string;
  accountIdentity: string;
  panelUrl: string;
  oldestReconciliationDate: string;
  streams: Array<{
    name: string;
    cursor: string | null;
    overlapFrom: string | null;
    lastFullScanCompletedAt: string | null;
    resumePageOrdinal: number | null;
  }>;
  intervalSeconds: number;
  absoluteExpiresAt: string;
}

interface ReadHelperOptions {
  hubUrl: string;
  token: string;
  browser: "chrome" | "msedge" | "chromium";
  profileDirectory: string;
  headless?: boolean;
  singleCycle?: boolean;
}

interface PreflightWork {
  id: string;
  request_json: {
    searches?: Array<{
      provider: "SHOPIFY" | "EBAY";
      displayNumber: string;
      amount: number;
      documentType: "TD01" | "TD04";
    }>;
  };
}

async function hubJson<T>(
  hub: URL,
  token: string,
  endpoint: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(new URL(endpoint, hub), {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) throw new Error(`HUB_${response.status}`);
  return (await response.json()) as T;
}

async function hubFile(
  hub: URL,
  token: string,
  remoteId: string,
  kind: "ARUBA_XML" | "ARUBA_P7M" | "ARUBA_PDF" | "SDI_NOTIFICATION",
  bytes: Buffer,
) {
  const response = await fetch(
    new URL(`/api/aruba/sync/documenti/${encodeURIComponent(remoteId)}/file`, hub),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "X-Aruba-File-Kind": kind,
      },
      body: Uint8Array.from(bytes),
    },
  );
  if (!response.ok) throw new Error(`HUB_${response.status}`);
}

function launchOptions(options: ReadHelperOptions, environment: ArubaReadManifest["environment"]) {
  if (options.browser === "chromium") {
    if (environment !== "MOCK") throw new Error("Chromium è ammesso soltanto nei test sintetici");
    return { headless: options.headless ?? true };
  }
  return { channel: options.browser, headless: options.headless ?? false };
}

async function waitForAuthenticationNavigationToSettle(page: Page, target: URL) {
  if (target.origin !== ARUBA_PANEL_ORIGIN) return;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const current = assertAllowedArubaAuthenticationNavigation(page.url(), target);
    const loginVisible = await page
      .locator(
        '[data-aruba-state="login-required"], input[type="password"], input[autocomplete="current-password"]',
      )
      .first()
      .isVisible()
      .catch(() => false);
    if (current.origin !== target.origin || loginVisible) return;
    await page.waitForTimeout(250);
  }
}

async function waitForLogin(page: Page, target: URL, heartbeat: () => Promise<void>) {
  const login = page.locator(
    '[data-aruba-state="login-required"], input[type="password"], input[autocomplete="current-password"]',
  );
  const authenticationPending = async () => {
    if (page.url() === "about:blank") return true;
    const current = assertAllowedArubaAuthenticationNavigation(page.url(), target);
    if (current.origin !== target.origin) return true;
    return (await login.count()) > 0 && (await login.first().isVisible());
  };
  if (await authenticationPending()) {
    process.stdout.write("Completa personalmente l’accesso Aruba nel browser.\n");
    const deadline = Date.now() + 15 * 60_000;
    let nextHeartbeatAt = 0;
    while ((await authenticationPending()) && Date.now() < deadline) {
      if (Date.now() >= nextHeartbeatAt) {
        await heartbeat();
        nextHeartbeatAt = Date.now() + 60_000;
      }
      await page.waitForTimeout(1_000);
    }
    if (await authenticationPending()) {
      throw new Error("ARUBA_AUTHENTICATION_REQUIRED");
    }
  }
  assertAllowedArubaNavigation(page.url(), target);
}

function integer(value: string | null): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error("DOM_UNRECOGNIZED");
  return parsed;
}

function italianDate(value: string): string {
  const match = value.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
  if (!match) throw new Error("DOM_UNRECOGNIZED");
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function italianAmount(value: string): number {
  const match = value.match(/(?:€\s*)?(-?\d{1,3}(?:\.\d{3})*|\d+),(\d{2})(?:\s*€)?/);
  if (!match) throw new Error("DOM_UNRECOGNIZED");
  const cents = Number(`${match[1]!.replaceAll(".", "")}${match[2]}`);
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("DOM_UNRECOGNIZED");
  return cents;
}

function visibleRemoteStatus(value: string): RemoteInventoryDocument["status"] {
  if (/non consegnat|mancata consegna/i.test(value)) return "NOT_DELIVERED";
  if (/consegnat/i.test(value)) return "DELIVERED";
  if (/scartat|rifiutat/i.test(value)) return "REJECTED";
  if (/elaborazione|in lavorazione|inoltrat[oa] a sdi/i.test(value)) return "SDI_PROCESSING";
  if (/inviat|trasmess/i.test(value)) return "SUBMITTED";
  return "UNKNOWN";
}

function headerIndex(headers: string[], pattern: RegExp): number {
  return headers.findIndex((header) => pattern.test(header));
}

export function parseProductionOrderReferences(value: string): string[] {
  if (!value.trim()) return [];
  const label = /^(?:ordine|ordini|riferimento|riferimenti|causale)$/i;
  const hashReferences = [...value.matchAll(/#\s*[A-Z0-9][A-Z0-9._/-]*/gi)].map((match) =>
    match[0].replace(/\s+/g, ""),
  );
  const labelledReferences = value
    .split(/[,;\n]+/)
    .map((item) => {
      const [prefix, ...remainder] = item.split(":");
      return label.test(prefix?.trim() ?? "") ? remainder.join(":").trim() : item.trim();
    })
    .filter((item) => item && item.length <= 100 && !label.test(item));
  const references = [...new Set([...hashReferences, ...labelledReferences])];
  if (!references.length || references.length > 20) throw new Error("DOM_UNRECOGNIZED");
  return references;
}

async function uniqueInventoryTable(page: Page): Promise<Locator> {
  const tables = page.locator("table");
  const candidates: Locator[] = [];
  for (let index = 0; index < (await tables.count()); index += 1) {
    const table = tables.nth(index);
    if (!(await table.isVisible())) continue;
    const headers = (await table.locator("thead th").allInnerTexts()).map((value) => value.trim());
    if (
      headers.some((value) => /data/i.test(value)) &&
      headers.some((value) => /stato/i.test(value)) &&
      headers.some((value) => /totale|importo/i.test(value))
    ) {
      candidates.push(table);
    }
  }
  if (candidates.length !== 1) throw new Error("DOM_UNRECOGNIZED");
  return candidates[0]!;
}

async function readProductionRows(page: Page) {
  const table = await uniqueInventoryTable(page);
  const headers = (await table.locator("thead th").allInnerTexts()).map((value) => value.trim());
  const indices = {
    remoteId: headerIndex(headers, /^(?:id|identificativo)(?:\s+(?:aruba|remoto))?$/i),
    type: headerIndex(headers, /tipo|documento/i),
    number: headerIndex(headers, /numero/i),
    date: headerIndex(headers, /data/i),
    recipient: headerIndex(headers, /destinatario|cliente/i),
    recipientTaxId: headerIndex(headers, /codice fiscale|partita iva|identificativo fiscale/i),
    recipientAddress: headerIndex(headers, /indirizzo/i),
    orderReferences: headerIndex(headers, /riferiment|ordine|causale/i),
    total: headerIndex(headers, /totale|importo/i),
    status: headerIndex(headers, /stato/i),
  };
  if (
    [indices.remoteId, indices.date, indices.total, indices.status, indices.orderReferences].some(
      (value) => value < 0,
    )
  ) {
    throw new Error("DOM_UNRECOGNIZED");
  }
  const rows = table.locator("tbody tr");
  if ((await rows.count()) > 300) throw new Error("DOM_UNRECOGNIZED");
  const documents: RemoteInventoryDocument[] = [];
  const files: Array<{
    remoteId: string;
    kind: "ARUBA_XML" | "ARUBA_P7M" | "ARUBA_PDF" | "SDI_NOTIFICATION";
    url: string;
  }> = [];
  for (let index = 0; index < (await rows.count()); index += 1) {
    const row = rows.nth(index);
    if (!(await row.isVisible())) continue;
    const cells = (await row.locator("td").allInnerTexts()).map((value) => value.trim());
    if (cells.length !== headers.length) throw new Error("DOM_UNRECOGNIZED");
    const text = cells.join(" ");
    const typeText = indices.type >= 0 ? cells[indices.type]! : text;
    const documentType = /\bTD0?4\b/i.test(typeText)
      ? "TD04"
      : /\bTD0?1\b/i.test(typeText)
        ? "TD01"
        : null;
    const remoteId = cells[indices.remoteId]!.trim();
    if (!documentType || !remoteId || remoteId.length > 200) throw new Error("DOM_UNRECOGNIZED");
    const documentDate = italianDate(cells[indices.date]!);
    const number = indices.number >= 0 ? cells[indices.number]!.trim() : "";
    const fiscalYear = Number(documentDate.slice(0, 4));
    const fiscalIdentity = parseProductionFiscalNumber(number, fiscalYear);
    documents.push({
      remoteId,
      documentType,
      fiscalYear,
      series: fiscalIdentity.series,
      fiscalNumber: fiscalIdentity.fiscalNumber,
      documentDate,
      recipientName: indices.recipient >= 0 ? cells[indices.recipient] || null : null,
      recipientTaxId: indices.recipientTaxId >= 0 ? cells[indices.recipientTaxId] || null : null,
      recipientCountryCode: null,
      recipientAddress:
        indices.recipientAddress >= 0 ? cells[indices.recipientAddress] || null : null,
      totalAmount: italianAmount(cells[indices.total]!),
      currency: "EUR",
      status: visibleRemoteStatus(cells[indices.status]!),
      providerObservedAt: null,
      xmlSha256: null,
      orderReferences: parseProductionOrderReferences(cells[indices.orderReferences]!),
    });
    for (const [kind, label] of [
      ["ARUBA_XML", /Scarica XML/i],
      ["ARUBA_P7M", /Scarica P7M/i],
      ["ARUBA_PDF", /Scarica PDF/i],
      ["SDI_NOTIFICATION", /Scarica (?:notifica|ricevuta)/i],
    ] as const) {
      const links = row.getByRole("link", { name: label });
      if ((await links.count()) > 1) throw new Error("DOM_UNRECOGNIZED");
      if ((await links.count()) === 1 && (await links.first().isVisible())) {
        const url = await links.first().getAttribute("href");
        if (!url) throw new Error("DOM_UNRECOGNIZED");
        files.push({ remoteId, kind, url });
      }
    }
  }
  return { documents, files };
}

export function parseProductionFiscalNumber(value: string, fiscalYear: number) {
  const match = /^(\S+)\s+(\d+)\/(\d{2}|\d{4})$/.exec(value.trim());
  if (!match) throw new Error("DOM_UNRECOGNIZED");
  const progressive = Number(match[2]);
  const expectedYear = String(fiscalYear);
  if (
    !Number.isSafeInteger(progressive) ||
    progressive <= 0 ||
    (match[3] !== expectedYear && match[3] !== expectedYear.slice(-2))
  ) {
    throw new Error("DOM_UNRECOGNIZED");
  }
  return { series: match[1]!, fiscalNumber: String(progressive) };
}

export async function readVisiblePage(
  page: Page,
  stream: string,
  scanOrdinal: number,
  pageOrdinal: number,
  environment: ArubaReadManifest["environment"] = "MOCK",
) {
  if (environment === "PRODUCTION") {
    const { documents, files } = await readProductionRows(page);
    const next = page.getByRole("button", { name: /Pagina successiva|Successiva/i }).first();
    const hasNext = Boolean(
      (await next.count()) && (await next.isVisible()) && (await next.isEnabled()),
    );
    return {
      inventory: inventoryPageSchema.parse({
        stream,
        scanOrdinal,
        pageOrdinal,
        cursor: `${stream}:${pageOrdinal}`,
        terminal: !hasNext,
        fullScan: true,
        documents,
      }),
      files,
    };
  }
  const rows = page.locator("tr[data-aruba-remote-id][data-document-type]");
  const count = await rows.count();
  if (count > 300) throw new Error("DOM_UNRECOGNIZED");
  const documents = [];
  const files: Array<{
    remoteId: string;
    kind: "ARUBA_XML" | "ARUBA_P7M" | "ARUBA_PDF" | "SDI_NOTIFICATION";
    url: string;
  }> = [];
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    if (!(await row.isVisible())) continue;
    const data = await row.evaluate((element) => ({
      remoteId: element.getAttribute("data-aruba-remote-id"),
      documentType: element.getAttribute("data-document-type"),
      fiscalYear: element.getAttribute("data-fiscal-year"),
      series: element.getAttribute("data-series"),
      fiscalNumber: element.getAttribute("data-fiscal-number"),
      documentDate: element.getAttribute("data-document-date"),
      recipientName: element.getAttribute("data-recipient-name"),
      recipientTaxId: element.getAttribute("data-recipient-tax-id"),
      recipientCountryCode: element.getAttribute("data-recipient-country"),
      recipientAddress: element.getAttribute("data-recipient-address"),
      totalAmount: element.getAttribute("data-total-cents"),
      status: element.getAttribute("data-remote-status"),
      providerObservedAt: element.getAttribute("data-observed-at"),
      orderReferences: (element.getAttribute("data-order-references") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      fileUrls: {
        ARUBA_XML: element.getAttribute("data-aruba-xml-url"),
        ARUBA_P7M: element.getAttribute("data-aruba-p7m-url"),
        ARUBA_PDF: element.getAttribute("data-aruba-pdf-url"),
        SDI_NOTIFICATION: element.getAttribute("data-aruba-notification-url"),
      },
    }));
    documents.push({
      ...data,
      remoteId: data.remoteId ?? "",
      documentType: data.documentType,
      fiscalYear: integer(data.fiscalYear),
      totalAmount: integer(data.totalAmount),
      currency: "EUR",
      xmlSha256: null,
    });
    for (const [kind, url] of Object.entries(data.fileUrls)) {
      if (url) {
        files.push({
          remoteId: data.remoteId ?? "",
          kind: kind as (typeof files)[number]["kind"],
          url,
        });
      }
    }
  }
  const next = page.getByRole("button", { name: /Pagina successiva|Successiva/i }).first();
  const hasNext = Boolean(
    (await next.count()) && (await next.isVisible()) && (await next.isEnabled()),
  );
  return {
    inventory: inventoryPageSchema.parse({
      stream,
      scanOrdinal,
      pageOrdinal,
      cursor: `${stream}:${pageOrdinal}`,
      terminal: !hasNext,
      fullScan: true,
      documents,
    }),
    files,
  };
}

async function downloadOfficialFile(page: Page, url: string, target: URL) {
  const allowed = assertAllowedArubaDownload(new URL(url, page.url()).toString(), target);
  const response = await page.request.get(allowed.toString());
  if (!response.ok()) throw new Error("OFFICIAL_FILE_DOWNLOAD_FAILED");
  const bytes = await response.body();
  if (!bytes.byteLength || bytes.byteLength > 4_900_000) {
    throw new Error("OFFICIAL_FILE_DOWNLOAD_FAILED");
  }
  return bytes;
}

async function applyDateFilter(page: Page, overlapFrom?: string | null) {
  const from = page.locator('[data-aruba-filter-from], input[name="dataDa"]').first();
  if (!(await from.count())) throw new Error("DOM_UNRECOGNIZED");
  await from.fill(overlapFrom?.slice(0, 10) ?? "");
  const apply = page.getByRole("button", { name: /Applica|Cerca|Filtra/i }).first();
  if (await apply.count()) await apply.click();
}

async function selectStream(page: Page, stream: string, overlapFrom?: string | null) {
  const selector = page.locator(`[data-aruba-stream="${stream}"]`).first();
  if (await selector.count()) {
    await selector.click();
  } else {
    const [kind, year] = stream.split(":");
    const link = page.getByRole("link", {
      name: new RegExp(`${kind === "invoices" ? "Fatture" : "Note di credito"}.*${year}`, "i"),
    });
    if (!(await link.count())) throw new Error("DOM_UNRECOGNIZED");
    await link.first().click();
  }
  await applyDateFilter(page, overlapFrom);
}

export async function runArubaReadCycle(
  page: Page,
  hub: URL,
  token: string,
  manifest: ArubaReadManifest,
  scanOrdinal = 1,
  fullScan = true,
  browser: "chrome" | "msedge" = "chrome",
) {
  const target = assertAllowedArubaTarget(manifest.panelUrl, manifest.environment);
  if (!page.url() || page.url() === "about:blank") await page.goto(target.toString());
  assertAllowedArubaAuthenticationNavigation(page.url(), target);
  const heartbeat = async () => {
    await hubJson(hub, token, "/api/aruba/sync/heartbeat", {
      method: "POST",
      body: JSON.stringify({ helperVersion: "0.1.0", browser }),
    });
  };
  await heartbeat();
  await waitForAuthenticationNavigationToSettle(page, target);
  await waitForLogin(page, target, heartbeat);
  await assertAccount(page, manifest.accountIdentity);
  await heartbeat();
  const observed = [];
  for (const streamManifest of manifest.streams) {
    await heartbeat();
    const stream = streamManifest.name;
    await selectStream(page, stream, fullScan ? null : streamManifest.overlapFrom);
    let pageOrdinal = 1;
    const resumeAt = fullScan ? (streamManifest.resumePageOrdinal ?? 1) : 1;
    while (pageOrdinal < resumeAt) {
      await page
        .getByRole("button", { name: /Pagina successiva|Successiva/i })
        .first()
        .click();
      pageOrdinal += 1;
    }
    while (true) {
      await heartbeat();
      assertAllowedArubaNavigation(page.url(), target);
      const { inventory, files } = await readVisiblePage(
        page,
        stream,
        scanOrdinal,
        pageOrdinal,
        manifest.environment,
      );
      const ingest = await hubJson<{ requestedFiles?: Array<{ remoteId: string; kind: string }> }>(
        hub,
        token,
        "/api/aruba/sync/pagine",
        {
          method: "POST",
          body: JSON.stringify({ ...inventory, fullScan }),
        },
      );
      observed.push(...inventory.documents);
      const requested = new Set(
        (ingest.requestedFiles ?? []).map((file) => `${file.remoteId}:${file.kind}`),
      );
      for (const file of files.filter((file) => requested.has(`${file.remoteId}:${file.kind}`))) {
        await hubFile(
          hub,
          token,
          file.remoteId,
          file.kind,
          await downloadOfficialFile(page, file.url, target),
        );
      }
      if (inventory.terminal) break;
      await page
        .getByRole("button", { name: /Pagina successiva|Successiva/i })
        .first()
        .click();
      pageOrdinal += 1;
    }
  }
  await hubJson(hub, token, "/api/aruba/sync/completa", {
    method: "POST",
    body: JSON.stringify({
      streams: manifest.streams.map((stream) => stream.name),
      scanOrdinal,
      fullScan,
    }),
  });
  return observed;
}

function preflightCandidates(work: PreflightWork, observed: RemoteInventoryDocument[]) {
  const searches = work.request_json.searches ?? [];
  return observed
    .filter((remote) => remoteMatchesPreflightSearches(remote, searches))
    .map((remote) => remote.remoteId);
}

async function listPendingPreflights(hub: URL, token: string) {
  return hubJson<{ work: PreflightWork[]; syncRequestedAt: string | null }>(
    hub,
    token,
    "/api/aruba/sync/preflight",
  );
}

async function completePreflights(
  hub: URL,
  token: string,
  work: PreflightWork[],
  observed: RemoteInventoryDocument[],
) {
  for (const receipt of work) {
    await hubJson(hub, token, "/api/aruba/sync/preflight", {
      method: "POST",
      body: JSON.stringify({
        receiptId: receipt.id,
        candidateRemoteIds: preflightCandidates(receipt, observed),
        searchesCompleted: true,
      }),
    });
  }
}

export async function runArubaReadHelper(options: ReadHelperOptions) {
  const hub = assertAllowedHubUrl(options.hubUrl);
  const manifest = await hubJson<ArubaReadManifest>(hub, options.token, "/api/aruba/sync/manifest");
  await mkdir(options.profileDirectory, { recursive: true, mode: 0o700 });
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(
      options.profileDirectory,
      launchOptions(options, manifest.environment),
    );
    const page = context.pages()[0] ?? (await context.newPage());
    let scanOrdinal = 1;
    let nextPeriodicAt = 0;
    do {
      try {
        const pendingBeforeScan = await listPendingPreflights(hub, options.token);
        const observed = await runArubaReadCycle(
          page,
          hub,
          options.token,
          manifest,
          scanOrdinal,
          scanOrdinal === 1,
          options.browser === "msedge" ? "msedge" : "chrome",
        );
        await completePreflights(hub, options.token, pendingBeforeScan.work, observed);
        nextPeriodicAt = Date.now() + manifest.intervalSeconds * 1_000;
      } catch (error) {
        await hubJson(hub, options.token, "/api/aruba/sync/fallita", {
          method: "POST",
          body: JSON.stringify({
            code:
              error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
                ? error.message
                : "READ_SYNC_FAILED",
          }),
        }).catch(() => undefined);
        throw error;
      }
      if (options.singleCycle) break;
      scanOrdinal += 1;
      let nextHeartbeatAt = Date.now();
      while (Date.now() < nextPeriodicAt && Date.now() < Date.parse(manifest.absoluteExpiresAt)) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        if (Date.now() >= nextHeartbeatAt) {
          await hubJson(hub, options.token, "/api/aruba/sync/heartbeat", {
            method: "POST",
            body: JSON.stringify({
              helperVersion: "0.1.0",
              browser: options.browser === "msedge" ? "msedge" : "chrome",
            }),
          });
          nextHeartbeatAt = Date.now() + 60_000;
        }
        const pending = await listPendingPreflights(hub, options.token);
        if (pending.work.length || pending.syncRequestedAt) {
          const observed = await runArubaReadCycle(
            page,
            hub,
            options.token,
            manifest,
            scanOrdinal,
            false,
            options.browser === "msedge" ? "msedge" : "chrome",
          );
          await completePreflights(hub, options.token, pending.work, observed);
          scanOrdinal += 1;
          nextPeriodicAt = Date.now() + manifest.intervalSeconds * 1_000;
        }
      }
    } while (Date.now() < Date.parse(manifest.absoluteExpiresAt));
  } finally {
    await context?.close().catch(() => undefined);
  }
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const hubUrl = option("--hub");
  const browser = option("--browser") as ReadHelperOptions["browser"] | undefined;
  if (!hubUrl || !browser || !["chrome", "msedge"].includes(browser)) {
    throw new Error("Uso: npm run aruba:sync -- --hub https://hub.example --browser chrome|msedge");
  }
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const token = (await input.question("Codice helper di sola lettura: ")).trim();
  input.close();
  await runArubaReadHelper({
    hubUrl,
    token,
    browser,
    profileDirectory: path.resolve(
      option("--profile") ?? path.join(os.homedir(), ".hub-fatture", "aruba-read-browser"),
    ),
  });
}
