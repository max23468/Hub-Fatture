import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import {
  chromium,
  type BrowserContext,
  type Download,
  type Locator,
  type Page,
  type Request,
} from "playwright";

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
    nonTerminalFrom: string | null;
    lastFullScanCompletedAt: string | null;
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

type OfficialFileKind = "ARUBA_XML" | "ARUBA_P7M" | "ARUBA_PDF" | "SDI_NOTIFICATION";

type OfficialFileSource =
  | { remoteId: string; kind: OfficialFileKind; url: string; recordIndex?: never }
  | { remoteId: string; kind: OfficialFileKind; recordIndex: string; url?: never };

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
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { code?: unknown } | null;
    const code = typeof payload?.code === "string" ? payload.code : "UNKNOWN";
    throw new Error(`HUB_FILE_${kind}_${response.status}_${code}`);
  }
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
  const extGrid = page.locator(".aruba-grid-fatture-inviate").first();
  if ((await extGrid.count()) && (await extGrid.isVisible())) {
    return readProductionExtGrid(extGrid);
  }
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
      recipientTaxIdentifiers: [],
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

function parseStream(stream: string) {
  const match = /^(invoices|credit-notes):(\d{4})$/.exec(stream);
  if (!match) throw new Error("DOM_UNRECOGNIZED");
  return {
    documentType: match[1] === "invoices" ? ("TD01" as const) : ("TD04" as const),
    year: Number(match[2]),
  };
}

async function readProductionExtGrid(grid: Locator) {
  const rows = grid.locator(".x-gridrow[data-recordindex]");
  const primary = new Map<string, Locator>();
  const statuses = new Map<string, Locator>();
  const count = await rows.count();
  if (count > 600) throw new Error("DOM_UNRECOGNIZED");
  if (!count) return { documents: [], files: [] };
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const recordIndex = await row.getAttribute("data-recordindex");
    if (!recordIndex || !/^\d+$/.test(recordIndex)) throw new Error("DOM_UNRECOGNIZED");
    const cellCount = await row.locator(".x-gridcell").count();
    const target = cellCount >= 18 ? primary : statuses;
    if (target.has(recordIndex)) throw new Error("DOM_UNRECOGNIZED");
    target.set(recordIndex, row);
  }
  if (!primary.size || primary.size > 300 || primary.size !== statuses.size) {
    throw new Error("DOM_UNRECOGNIZED");
  }
  const documents: RemoteInventoryDocument[] = [];
  const files: OfficialFileSource[] = [];
  for (const [recordIndex, primaryRow] of primary) {
    const statusRow = statuses.get(recordIndex);
    if (!statusRow) throw new Error("DOM_UNRECOGNIZED");
    const cells = (await primaryRow.locator(".x-gridcell").allInnerTexts()).map((value) =>
      value.trim(),
    );
    const statusCells = (await statusRow.locator(".x-gridcell").allInnerTexts()).map((value) =>
      value.trim(),
    );
    if (cells.length < 18 || !statusCells.length) throw new Error("DOM_UNRECOGNIZED");
    const type = cells[8]!.match(/\b(TD01|TD04)\b/i)?.[1]?.toUpperCase();
    if (type !== "TD01" && type !== "TD04") continue;
    const documentDate = italianDate(cells[4]!);
    const fiscalYear = Number(documentDate.slice(0, 4));
    const fiscalIdentity = parseProductionFiscalNumber(cells[5]!, fiscalYear);
    const remoteId = cells[17]!.trim();
    if (!/^\d{6,30}$/.test(remoteId)) throw new Error("DOM_UNRECOGNIZED");
    documents.push({
      remoteId,
      documentType: type,
      fiscalYear,
      series: fiscalIdentity.series,
      fiscalNumber: fiscalIdentity.fiscalNumber,
      documentDate,
      recipientName: cells[7] || null,
      recipientTaxId: null,
      recipientTaxIdentifiers: [],
      recipientCountryCode: null,
      recipientAddress: null,
      totalAmount: italianAmount(cells[10]!),
      currency: "EUR",
      status: visibleRemoteStatus(statusCells[0]!),
      providerObservedAt: null,
      xmlSha256: null,
      orderReferences: [],
    });
    const downloads = statusRow.locator(".x-gridcell").nth(1);
    for (const [kind, iconClass] of [
      ["ARUBA_XML", "aru-xml"],
      ["ARUBA_P7M", "aru-p7m"],
      ["ARUBA_PDF", "aru-pdf"],
      ["SDI_NOTIFICATION", "aru-sdi"],
    ] as const) {
      const icons = downloads.locator(`.${iconClass}`);
      if ((await icons.count()) > 1) throw new Error("DOM_UNRECOGNIZED");
      if ((await icons.count()) === 1) files.push({ remoteId, kind, recordIndex });
    }
  }
  return { documents, files };
}

const PRODUCTION_NEXT_SELECTOR =
  '.aruba-grid-fatture-inviate button[aria-label*="nextPage"], .aruba-grid-fatture-inviate button[title*="nextPage"], .aruba-grid-fatture-inviate [title*="nextPage"] button';

async function productionNextButton(page: Page) {
  const candidates = page.locator(PRODUCTION_NEXT_SELECTOR);
  const visible: Locator[] = [];
  for (let index = 0; index < (await candidates.count()); index += 1) {
    const candidate = candidates.nth(index);
    if (await candidate.isVisible()) visible.push(candidate);
  }
  if (visible.length !== 1) throw new Error("DOM_UNRECOGNIZED");
  return visible[0]!;
}

async function productionFirstButton(page: Page) {
  const candidates = page.locator(".aruba-grid-fatture-inviate .pagingtoolbar-first button");
  const visible: Locator[] = [];
  for (let index = 0; index < (await candidates.count()); index += 1) {
    const candidate = candidates.nth(index);
    if (await candidate.isVisible()) visible.push(candidate);
  }
  if (visible.length !== 1) throw new Error("DOM_UNRECOGNIZED");
  return visible[0]!;
}

async function productionHasNext(page: Page) {
  const next = await productionNextButton(page);
  return next.evaluate((element) => {
    const control = element.closest(".x-button");
    return (
      !(element as HTMLButtonElement).disabled &&
      element.getAttribute("aria-disabled") !== "true" &&
      (!control ||
        (!control.classList.contains("x-disabled") &&
          control.getAttribute("aria-disabled") !== "true"))
    );
  });
}

async function productionPageFingerprint(page: Page) {
  const rows = page.locator(
    ".aruba-grid-fatture-inviate .x-gridrow[data-recordindex] .x-gridcell:nth-child(18)",
  );
  const values = (await rows.allInnerTexts()).map((value) => value.trim()).filter(Boolean);
  if (!values.length) throw new Error("DOM_UNRECOGNIZED");
  return values.join("|");
}

export async function advanceProductionPage(page: Page) {
  const before = await productionPageFingerprint(page);
  const next = await productionNextButton(page);
  if (!(await productionHasNext(page))) throw new Error("DOM_UNRECOGNIZED");
  await clickAndWaitForProductionGridReload(page, next);
  if ((await productionPageFingerprint(page)) === before) throw new Error("DOM_UNRECOGNIZED");
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
    const expected = parseStream(stream);
    const filtered = documents.filter(
      (document) =>
        document.documentType === expected.documentType && document.fiscalYear === expected.year,
    );
    const usesExtGrid = await page
      .locator(".aruba-grid-fatture-inviate")
      .first()
      .isVisible()
      .catch(() => false);
    const semanticNext = page
      .getByRole("button", { name: /Pagina successiva|Successiva/i })
      .first();
    const hasNext = usesExtGrid
      ? await productionHasNext(page)
      : Boolean(
          (await semanticNext.count()) &&
          (await semanticNext.isVisible()) &&
          (await semanticNext.isEnabled()),
        );
    return {
      inventory: inventoryPageSchema.parse({
        stream,
        scanOrdinal,
        pageOrdinal,
        cursor: `${stream}:${pageOrdinal}`,
        terminal: !hasNext,
        fullScan: true,
        documents: filtered,
      }),
      files,
    };
  }
  const rows = page.locator("tr[data-aruba-remote-id][data-document-type]");
  const count = await rows.count();
  if (count > 300) throw new Error("DOM_UNRECOGNIZED");
  const documents = [];
  const files: OfficialFileSource[] = [];
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

async function downloadOfficialFile(page: Page, file: OfficialFileSource, target: URL) {
  if (file.url) {
    const allowed = assertAllowedArubaDownload(new URL(file.url, page.url()).toString(), target);
    const response = await page.request.get(allowed.toString());
    if (!response.ok()) throw new Error("OFFICIAL_FILE_DOWNLOAD_FAILED");
    const bytes = await response.body();
    if (!bytes.byteLength || bytes.byteLength > 4_900_000) {
      throw new Error("OFFICIAL_FILE_DOWNLOAD_FAILED");
    }
    return bytes;
  }
  const recordIndex = file.recordIndex;
  if (!recordIndex || !/^\d+$/.test(recordIndex)) throw new Error("DOM_UNRECOGNIZED");
  const iconClass = {
    ARUBA_XML: "aru-xml",
    ARUBA_P7M: "aru-p7m",
    ARUBA_PDF: "aru-pdf",
    SDI_NOTIFICATION: "aru-sdi",
  }[file.kind];
  const tool = page
    .locator(
      `.aruba-grid-fatture-inviate .locked-grid-border-left .x-gridrow[data-recordindex="${recordIndex}"] .x-gridcell:nth-child(2) .${iconClass}`,
    )
    .locator(
      "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' x-tool ')][1]",
    );
  if ((await tool.count()) !== 1 || !(await tool.isVisible())) {
    throw new Error("DOM_UNRECOGNIZED");
  }
  let download: Download | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await dismissArubaCookieBanner(page);
    const pendingDownload = page.waitForEvent("download", { timeout: 6_000 }).catch(() => null);
    try {
      await tool.click({ timeout: 5_000 });
      download = await pendingDownload;
      if (download) break;
    } catch (error) {
      await pendingDownload;
      if (attempt === 0 && (await dismissArubaCookieBanner(page))) continue;
      throw error;
    }
    throw new Error("OFFICIAL_FILE_DOWNLOAD_FAILED");
  }
  if (!download) throw new Error("OFFICIAL_FILE_DOWNLOAD_FAILED");
  const stream = await download.createReadStream();
  if (!stream) throw new Error("OFFICIAL_FILE_DOWNLOAD_FAILED");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 4_900_000) {
      stream.destroy();
      throw new Error("OFFICIAL_FILE_DOWNLOAD_FAILED");
    }
    chunks.push(bytes);
  }
  if (!size || (await download.failure())) throw new Error("OFFICIAL_FILE_DOWNLOAD_FAILED");
  return Buffer.concat(chunks, size);
}

async function assertDateFilterInactive(page: Page) {
  const synthetic = page.locator("[data-aruba-filter-from]:visible");
  const production = page.locator('[data-reference="arubacombobox-filterDate"]:visible input');
  const candidates = (await synthetic.count()) ? synthetic : production;
  if ((await candidates.count()) !== 1) throw new Error("DOM_UNRECOGNIZED");
  if ((await candidates.first().inputValue()).trim()) throw new Error("ARUBA_FILTER_ACTIVE");
}

async function armProductionGridReload(page: Page) {
  await page.evaluate(() => {
    const runtime = window as typeof window & {
      __arubaReadGridReload?: {
        observer: MutationObserver;
        observed: boolean;
        lastMutationAt: number;
      };
    };
    runtime.__arubaReadGridReload?.observer.disconnect();
    const state = {
      observer: null as unknown as MutationObserver,
      observed: false,
      lastMutationAt: 0,
    };
    const touchesGrid = (node: Node) => {
      const element = node instanceof Element ? node : node.parentElement;
      return Boolean(
        element?.closest(".aruba-grid-fatture-inviate") ||
        element?.matches(".aruba-grid-fatture-inviate") ||
        element?.querySelector(".aruba-grid-fatture-inviate"),
      );
    };
    state.observer = new MutationObserver((mutations) => {
      if (
        mutations.some(
          (mutation) =>
            touchesGrid(mutation.target) ||
            [...mutation.addedNodes, ...mutation.removedNodes].some(touchesGrid),
        )
      ) {
        state.observed = true;
        state.lastMutationAt = performance.now();
      }
    });
    state.observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    runtime.__arubaReadGridReload = state;
  });
}

async function waitForProductionGridReload(page: Page) {
  try {
    await page.waitForFunction((nextSelector) => {
      const runtime = window as typeof window & {
        __arubaReadGridReload?: {
          observed: boolean;
          lastMutationAt: number;
        };
      };
      const state = runtime.__arubaReadGridReload;
      if (!state?.observed || performance.now() - state.lastMutationAt < 500) return false;
      const next = [...document.querySelectorAll<HTMLElement>(nextSelector)].filter(
        (element) => element.getClientRects().length > 0,
      );
      return next.length === 1;
    }, PRODUCTION_NEXT_SELECTOR);
  } finally {
    await clearProductionGridReload(page);
  }
}

async function clearProductionGridReload(page: Page) {
  await page.evaluate(() => {
    const runtime = window as typeof window & {
      __arubaReadGridReload?: { observer: MutationObserver };
    };
    runtime.__arubaReadGridReload?.observer.disconnect();
    delete runtime.__arubaReadGridReload;
  });
}

interface ProductionRequestKey {
  method: string;
  url: string;
}

async function armProductionRequestCapture(page: Page) {
  await page.evaluate(() => {
    const runtime = window as typeof window & {
      __arubaReadRequestCapture?: {
        active: boolean;
        requests: Array<{ method: string; url: string }>;
        restore: () => void;
      };
    };
    runtime.__arubaReadRequestCapture?.restore();
    const originalFetch = window.fetch;
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const xhrRequests = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
    const state = {
      active: false,
      requests: [] as Array<{ method: string; url: string }>,
      restore: () => {
        window.fetch = originalFetch;
        XMLHttpRequest.prototype.open = originalOpen;
        XMLHttpRequest.prototype.send = originalSend;
      },
    };
    window.fetch = function (input, init) {
      if (state.active) {
        const request = input instanceof Request ? input : null;
        const url = new URL(request?.url ?? String(input), location.href);
        if (url.origin === location.origin) {
          state.requests.push({
            method: (init?.method ?? request?.method ?? "GET").toUpperCase(),
            url: url.href,
          });
        }
      }
      return Reflect.apply(originalFetch, this, [input, init]);
    };
    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null,
    ) {
      xhrRequests.set(this, {
        method: method.toUpperCase(),
        url: new URL(String(url), location.href).href,
      });
      return Reflect.apply(
        originalOpen,
        this,
        async === undefined ? [method, url] : [method, url, async, username, password],
      );
    } as typeof XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.send = function (...args) {
      const request = xhrRequests.get(this);
      if (state.active && request && new URL(request.url).origin === location.origin) {
        state.requests.push(request);
      }
      return Reflect.apply(originalSend, this, args);
    };
    runtime.__arubaReadRequestCapture = state;
  });
}

async function clickWithProductionRequestCapture(control: Locator) {
  const page = control.page();
  await page.evaluate(() => {
    const runtime = window as typeof window & {
      __arubaReadRequestCapture?: { active: boolean };
    };
    const state = runtime.__arubaReadRequestCapture;
    if (!state) throw new Error("DOM_UNRECOGNIZED");
    state.active = true;
  });
  try {
    await control.click({ timeout: 5_000 });
    await page
      .waitForFunction(
        () => {
          const runtime = window as typeof window & {
            __arubaReadRequestCapture?: { requests: unknown[] };
          };
          return Boolean(runtime.__arubaReadRequestCapture?.requests.length);
        },
        undefined,
        { timeout: 5_000 },
      )
      .catch(() => {
        throw new Error("DOM_UNRECOGNIZED");
      });
  } finally {
    await page.evaluate(() => {
      const runtime = window as typeof window & {
        __arubaReadRequestCapture?: { active: boolean };
      };
      if (runtime.__arubaReadRequestCapture) {
        runtime.__arubaReadRequestCapture.active = false;
      }
    });
  }
}

async function dismissArubaCookieBanner(page: Page) {
  const dialog = page.locator("#CybotCookiebotDialog");
  if (!(await dialog.count()) || !(await dialog.isVisible())) return false;
  const decline = dialog.locator("#CybotCookiebotDialogBodyButtonDecline");
  if ((await decline.count()) !== 1 || !(await decline.isVisible())) {
    throw new Error("DOM_UNRECOGNIZED");
  }
  await decline.click({ timeout: 5_000 });
  await dialog.waitFor({ state: "hidden", timeout: 5_000 });
  return true;
}

async function clickWithArubaCookieRetry(page: Page, control: Locator) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await dismissArubaCookieBanner(page);
    try {
      await control.click({ timeout: 5_000 });
      return;
    } catch (error) {
      if (attempt === 0 && (await dismissArubaCookieBanner(page))) continue;
      throw error;
    }
  }
  throw new Error("DOM_UNRECOGNIZED");
}

async function finishProductionRequestCapture(page: Page): Promise<ProductionRequestKey[]> {
  return page.evaluate(() => {
    const runtime = window as typeof window & {
      __arubaReadRequestCapture?: {
        active: boolean;
        requests: Array<{ method: string; url: string }>;
        restore: () => void;
      };
    };
    const state = runtime.__arubaReadRequestCapture;
    if (!state) return [];
    state.restore();
    delete runtime.__arubaReadRequestCapture;
    return state.requests;
  });
}

function observeProductionDataRequests(page: Page) {
  const observed: Request[] = [];
  const pageOrigin = new URL(page.url()).origin;
  const relevant = (request: Request) =>
    ["xhr", "fetch"].includes(request.resourceType()) &&
    new URL(request.url()).origin === pageOrigin;
  const onRequest = (request: Request) => {
    if (relevant(request)) observed.push(request);
  };
  page.on("request", onRequest);
  return {
    async waitFor(captured: ProductionRequestKey[]) {
      let requests: Request[] | null = null;
      const matchDeadline = Date.now() + 1_000;
      while (!requests && Date.now() < matchDeadline) {
        const remaining = [...observed];
        const matched: Request[] = [];
        for (const key of captured) {
          const index = remaining.findIndex(
            (request) => request.method() === key.method && request.url() === key.url,
          );
          if (index < 0) break;
          matched.push(remaining.splice(index, 1)[0]!);
        }
        if (matched.length === captured.length) requests = matched;
        else await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!requests) throw new Error("DOM_UNRECOGNIZED");
      if (!requests.length) throw new Error("DOM_UNRECOGNIZED");
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(
            requests.map(async (request) => {
              const response = await request.response().catch(() => null);
              if (!response?.ok() || (await response.finished())) {
                throw new Error("DOM_UNRECOGNIZED");
              }
            }),
          ),
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error("DOM_UNRECOGNIZED")), 30_000);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    },
    dispose() {
      page.off("request", onRequest);
    },
  };
}

async function clickAndWaitForProductionGridReload(page: Page, control: Locator) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await dismissArubaCookieBanner(page);
    await armProductionGridReload(page);
    await armProductionRequestCapture(page);
    const dataRequests = observeProductionDataRequests(page);
    try {
      await clickWithProductionRequestCapture(control);
      const captured = await finishProductionRequestCapture(page);
      await dataRequests.waitFor(captured);
      await waitForProductionGridReload(page);
      return;
    } catch (error) {
      if (attempt === 0 && (await dismissArubaCookieBanner(page))) continue;
      throw error;
    } finally {
      await finishProductionRequestCapture(page);
      dataRequests.dispose();
      await clearProductionGridReload(page);
    }
  }
  throw new Error("DOM_UNRECOGNIZED");
}

export async function selectStream(page: Page, stream: string) {
  const selector = page.locator(`[data-aruba-stream="${stream}"]`).first();
  if (await selector.count()) {
    await selector.click();
  } else {
    const { year } = parseStream(stream);
    const yearControl = page.locator(".main-toolbar-info-fiscalyear").first();
    if (!(await yearControl.count()) || !(await yearControl.isVisible())) {
      throw new Error("DOM_UNRECOGNIZED");
    }
    if (!(await yearControl.innerText()).includes(String(year))) {
      await clickWithArubaCookieRetry(page, yearControl.locator("button"));
      const yearOptions = page.locator(".x-menuitem-sub-menu-mainToolbar");
      const exactYears: Locator[] = [];
      for (let index = 0; index < (await yearOptions.count()); index += 1) {
        const option = yearOptions.nth(index);
        if ((await option.isVisible()) && (await option.innerText()).trim() === String(year)) {
          exactYears.push(option);
        }
      }
      if (exactYears.length !== 1) throw new Error("DOM_UNRECOGNIZED");
      await clickAndWaitForProductionGridReload(page, exactYears[0]!);
      await page.waitForFunction(
        ({ selector, value }) =>
          document.querySelector(selector)?.textContent?.includes(value) === true,
        { selector: ".main-toolbar-info-fiscalyear", value: String(year) },
      );
    }
    const sent = page.getByRole("menuitem").filter({ hasText: /^\s*Fatture inviate\s*$/i });
    const visibleSent: Locator[] = [];
    for (let index = 0; index < (await sent.count()); index += 1) {
      if (await sent.nth(index).isVisible()) visibleSent.push(sent.nth(index));
    }
    if (visibleSent.length !== 1) throw new Error("DOM_UNRECOGNIZED");
    const alreadySelected = await visibleSent[0]!.evaluate((element) =>
      element.classList.contains("x-treelist-item-selected"),
    );
    if (alreadySelected) {
      const first = await productionFirstButton(page);
      const firstEnabled = await first.evaluate((element) => {
        const control = element.closest(".x-button");
        return (
          !(element as HTMLButtonElement).disabled &&
          element.getAttribute("aria-disabled") !== "true" &&
          (!control ||
            (!control.classList.contains("x-disabled") &&
              control.getAttribute("aria-disabled") !== "true"))
        );
      });
      if (firstEnabled) await clickAndWaitForProductionGridReload(page, first);
      await productionNextButton(page);
    } else {
      await clickAndWaitForProductionGridReload(page, visibleSent[0]!);
      await productionNextButton(page);
    }
  }
  await assertDateFilterInactive(page);
}

async function advancePage(page: Page, environment: ArubaReadManifest["environment"]) {
  if (environment === "PRODUCTION") return advanceProductionPage(page);
  await page
    .getByRole("button", { name: /Pagina successiva|Successiva/i })
    .first()
    .click();
}

export async function runArubaReadCycle(
  page: Page,
  hub: URL,
  token: string,
  manifest: ArubaReadManifest,
  scanOrdinal = 1,
  browser: "chrome" | "msedge" = "chrome",
) {
  const target = assertAllowedArubaTarget(manifest.panelUrl, manifest.environment);
  if (manifest.environment === "PRODUCTION" || !page.url() || page.url() === "about:blank") {
    await page.goto(target.toString());
  }
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
    await selectStream(page, stream);
    let pageOrdinal = 1;
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
          body: JSON.stringify({ ...inventory, fullScan: true }),
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
          await downloadOfficialFile(page, file, target),
        );
      }
      if (inventory.terminal) break;
      await advancePage(page, manifest.environment);
      pageOrdinal += 1;
    }
  }
  await hubJson(hub, token, "/api/aruba/sync/completa", {
    method: "POST",
    body: JSON.stringify({
      streams: manifest.streams.map((stream) => stream.name),
      scanOrdinal,
      fullScan: true,
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
