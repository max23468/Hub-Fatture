import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { chromium, type BrowserContext, type Page } from "playwright";

import {
  assertAllowedArubaDownload,
  assertAllowedArubaNavigation,
  assertAllowedArubaTarget,
  assertAllowedHubUrl,
} from "../src/aruba.ts";
import {
  inventoryPageSchema,
  normalizedMatchText,
  type RemoteInventoryDocument,
} from "../src/aruba-inbound.ts";

export interface ArubaReadManifest {
  operation: "READ_SYNC";
  sessionId: string;
  environment: "MOCK" | "PRODUCTION";
  accountReference: string;
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

async function waitForLogin(page: Page, heartbeat: () => Promise<void>) {
  const login = page.locator('[data-aruba-state="login-required"], input[type="password"]');
  if (await login.count()) {
    process.stdout.write("Completa personalmente l’accesso Aruba nel browser.\n");
    const deadline = Date.now() + 15 * 60_000;
    while ((await login.first().isVisible()) && Date.now() < deadline) {
      await heartbeat();
      await login
        .first()
        .waitFor({ state: "hidden", timeout: 60_000 })
        .catch(() => undefined);
    }
    if (await login.first().isVisible()) throw new Error("ARUBA_AUTHENTICATION_REQUIRED");
  }
}

async function assertAccount(page: Page, expected: string) {
  const account = page.locator("[data-aruba-account]").first();
  if (!(await account.count()) || !(await account.isVisible())) throw new Error("DOM_UNRECOGNIZED");
  const declared = await account.getAttribute("data-aruba-account");
  if (declared !== expected) throw new Error("ACCOUNT_MISMATCH");
}

function integer(value: string | null): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error("DOM_UNRECOGNIZED");
  return parsed;
}

async function readVisiblePage(
  page: Page,
  stream: string,
  scanOrdinal: number,
  pageOrdinal: number,
) {
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

async function selectStream(page: Page, stream: string, overlapFrom?: string | null) {
  const selector = page.locator(`[data-aruba-stream="${stream}"]`).first();
  if (await selector.count()) {
    await selector.click();
    if (overlapFrom) {
      const from = page.locator('[data-aruba-filter-from], input[name="dataDa"]').first();
      if (!(await from.count())) throw new Error("DOM_UNRECOGNIZED");
      await from.fill(overlapFrom.slice(0, 10));
      const apply = page.getByRole("button", { name: /Applica|Cerca|Filtra/i }).first();
      if (await apply.count()) await apply.click();
    }
    return;
  }
  const [kind, year] = stream.split(":");
  const link = page.getByRole("link", {
    name: new RegExp(`${kind === "invoices" ? "Fatture" : "Note di credito"}.*${year}`, "i"),
  });
  if (!(await link.count())) throw new Error("DOM_UNRECOGNIZED");
  await link.first().click();
  if (overlapFrom) {
    const from = page.locator('[data-aruba-filter-from], input[name="dataDa"]').first();
    if (!(await from.count())) throw new Error("DOM_UNRECOGNIZED");
    await from.fill(overlapFrom.slice(0, 10));
    const apply = page.getByRole("button", { name: /Applica|Cerca|Filtra/i }).first();
    if (await apply.count()) await apply.click();
  }
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
  assertAllowedArubaNavigation(page.url(), target);
  const heartbeat = async () => {
    await hubJson(hub, token, "/api/aruba/sync/heartbeat", {
      method: "POST",
      body: JSON.stringify({ helperVersion: "0.1.0", browser }),
    });
  };
  await heartbeat();
  await waitForLogin(page, heartbeat);
  await assertAccount(page, manifest.accountReference);
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
      const { inventory, files } = await readVisiblePage(page, stream, scanOrdinal, pageOrdinal);
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
    .filter((remote) =>
      searches.some(
        (search) =>
          search.documentType === remote.documentType &&
          search.amount === remote.totalAmount &&
          remote.orderReferences.some(
            (reference) =>
              normalizedMatchText(reference) === normalizedMatchText(search.displayNumber),
          ),
      ),
    )
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
