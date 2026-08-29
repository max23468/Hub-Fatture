import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

import { chromium, type BrowserContext, type Locator, type Page } from "@playwright/test";

import {
  ARUBA_IMPORT_MAX_BYTES,
  ARUBA_UPLOAD_MAX_BYTES,
  arubaManifestSchema,
  assertAllowedArubaDownload,
  assertAllowedArubaNavigation,
  assertAllowedArubaTarget,
  assertAllowedHubUrl,
  type ArubaManifest,
  type ArubaManifestDocument,
  type HelperEvent,
} from "../src/aruba.ts";

const HELPER_VERSION = "0.0.0";
const HELPER_HEARTBEAT_INTERVAL_MS = 60_000;

export interface HelperOptions {
  hubUrl: string;
  token: string;
  profileDirectory: string;
  browser: "chrome" | "msedge" | "chromium";
  headless?: boolean;
  mockScenario?: "valid" | "invalid" | "login" | "login-auto" | "unexpected" | "uncertain";
  closeAfterStop?: boolean;
}

async function responseBytes(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.ok) throw new Error(`Hub Fatture ha risposto ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Risposta troppo grande");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Risposta vuota");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("Risposta troppo grande");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}

async function hubFetch(
  hub: URL,
  token: string,
  pathname: string,
  init: RequestInit = {},
  maxBytes = 1024 * 1024,
) {
  const url = new URL(pathname, hub);
  if (url.origin !== hub.origin) throw new Error("Endpoint Hub Fatture non autorizzato");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(url, {
    ...init,
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  return responseBytes(response, maxBytes);
}

async function event(hub: URL, token: string, value: HelperEvent) {
  await hubFetch(hub, token, "/api/aruba/helper/eventi", {
    method: "POST",
    body: JSON.stringify(value),
  });
}

async function manifest(hub: URL, token: string): Promise<ArubaManifest> {
  const bytes = await hubFetch(hub, token, "/api/aruba/helper/manifest");
  return arubaManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
}

async function downloadDocuments(hub: URL, token: string, value: ArubaManifest, root: string) {
  const files = new Map<string, string>();
  for (const document of value.documents) {
    const bytes = await hubFetch(
      hub,
      token,
      `/api/aruba/helper/documenti/${document.id}/xml`,
      {},
      ARUBA_UPLOAD_MAX_BYTES,
    );
    const digest = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== document.sizeBytes || digest !== document.sha256) {
      throw new Error("XML diverso dal manifest");
    }
    const filePath = path.join(root, document.filename);
    await writeFile(filePath, bytes, { mode: 0o600, flag: "wx" });
    files.set(document.id, filePath);
  }
  return files;
}

async function waitWithHeartbeat<T>(operation: Promise<T>, heartbeat?: () => Promise<void>) {
  if (!heartbeat) return operation;
  const settled = operation.then(
    (value) => ({ state: "DONE" as const, value }),
    (error: unknown) => ({ state: "FAILED" as const, error }),
  );
  await heartbeat();
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      settled,
      new Promise<{ state: "HEARTBEAT" }>((resolve) => {
        timer = setTimeout(() => resolve({ state: "HEARTBEAT" }), HELPER_HEARTBEAT_INTERVAL_MS);
      }),
    ]);
    clearTimeout(timer);
    if (result.state === "DONE") return result.value;
    if (result.state === "FAILED") throw result.error;
    await heartbeat();
  }
}

async function waitForAuthentication(page: Page, heartbeat?: () => Promise<void>) {
  const authentication = page.locator(
    '[data-aruba-state="login-required"], input[type="password"], input[autocomplete="current-password"], input[name*="otp" i], iframe[title*="captcha" i]',
  );
  if ((await authentication.count()) === 0) return;
  process.stdout.write("Autenticazione richiesta: completa login, OTP o CAPTCHA nel browser.\n");
  await waitWithHeartbeat(
    authentication.first().waitFor({ state: "hidden", timeout: 15 * 60_000 }),
    heartbeat,
  );
  await page.waitForLoadState("domcontentloaded");
}

export async function waitForUploadedDocument(
  page: Page,
  filename: string,
  heartbeat?: () => Promise<void>,
) {
  const uploadedDocument = page.locator("tr", { hasText: filename }).first();
  const securityChallenge = page
    .locator(
      '[data-aruba-state="security-challenge-required"], input[name*="otp" i], input[aria-label*="codice ricevuto per SMS" i]',
    )
    .or(
      page.getByText(
        /Vuoi disattivare la protezione OTP su Carica Fatture|Inserisci il codice ricevuto per SMS/i,
      ),
    )
    .first();
  let state: "READY" | "SECURITY_CHALLENGE";
  try {
    state = await Promise.race([
      securityChallenge
        .waitFor({ state: "visible", timeout: 10_000 })
        .then(() => "SECURITY_CHALLENGE" as const),
      uploadedDocument.waitFor({ state: "visible", timeout: 10_000 }).then(() => "READY" as const),
    ]);
  } catch {
    throw new Error("DOM_UNRECOGNIZED");
  }
  if (state === "READY") return;
  process.stdout.write(
    "Verifica di sicurezza Aruba richiesta: completala personalmente nel browser.\n",
  );
  await waitWithHeartbeat(
    uploadedDocument.waitFor({ state: "visible", timeout: 15 * 60_000 }),
    heartbeat,
  ).catch(() => {
    throw new Error("DOM_UNRECOGNIZED");
  });
}

function assertPageOrigin(page: Page, target: URL) {
  assertNavigationUrl(page.url(), target);
}

function assertNavigationUrl(url: string, target: URL) {
  try {
    assertAllowedArubaNavigation(url, target);
  } catch {
    throw new Error("DOM_UNRECOGNIZED");
  }
}

function assertDownloadUrl(url: string, target: URL) {
  try {
    assertAllowedArubaDownload(url, target);
  } catch {
    throw new Error("DOM_UNRECOGNIZED");
  }
}

export async function assertAccount(page: Page, accountReference: string) {
  const expectedAccount = accountReference.replace(/\s+/g, " ").trim();
  const candidates = page
    .locator(
      '[data-aruba-account], .main-toolbar-info-user, [aria-current="true"], [aria-selected="true"], [data-active="true"]',
      { hasText: expectedAccount },
    )
    .or(page.getByRole("button", { name: expectedAccount, exact: true }));
  const count = await candidates.count();
  if (!count || count > 20) throw new Error("DOM_UNRECOGNIZED");
  const visibleExact = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible())) continue;
    const declaredAccount = await candidate.getAttribute("data-aruba-account");
    const observedAccount = (
      declaredAccount === null ? await candidate.innerText() : declaredAccount
    )
      .replace(/\s+/g, " ")
      .trim();
    if (observedAccount === expectedAccount) visibleExact.push(candidate);
  }
  if (visibleExact.length !== 1) throw new Error("DOM_UNRECOGNIZED");
}

async function uploadInput(page: Page) {
  const labelled = page.getByLabel(/Seleziona documenti|Carica fattur[ae]/i).first();
  if (await labelled.count()) return labelled;
  const input = page.locator('input[type="file"]').first();
  if (await input.count()) return input;
  throw new Error("DOM_UNRECOGNIZED");
}

async function visibleDocumentRow(page: Page, filename: string, required: boolean) {
  const rows = page.locator("tr", { hasText: filename });
  if (required) {
    await page
      .waitForFunction(
        (expectedFilename) =>
          [...document.querySelectorAll("tr")].some(
            (row) =>
              row.textContent?.includes(expectedFilename) &&
              row instanceof HTMLElement &&
              row.offsetParent !== null,
          ),
        filename,
        { timeout: 10_000 },
      )
      .catch(() => {
        throw new Error("DOM_UNRECOGNIZED");
      });
  }
  const count = await rows.count();
  if (count > 300) throw new Error("DOM_UNRECOGNIZED");
  const visible: Locator[] = [];
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    if (await row.isVisible()) visible.push(row);
  }
  if (visible.length > 1 || (required && visible.length !== 1)) {
    throw new Error("DOM_UNRECOGNIZED");
  }
  return visible[0] ?? null;
}

type VisibleIdentityDocument = Pick<
  ArubaManifestDocument,
  "fiscalNumber" | "documentDate" | "totalAmount"
>;

async function visibleDocumentIdentity(row: Locator, document: VisibleIdentityDocument) {
  const text = (await row.innerText()).slice(0, 1000);
  const identity = await row.evaluate((element) => ({
    number: element.getAttribute("data-fiscal-number"),
    date: element.getAttribute("data-document-date"),
    total: element.getAttribute("data-total-cents"),
    remoteId: element.getAttribute("data-remote-id"),
  }));
  const total = (document.totalAmount / 100).toFixed(2);
  const [year, month, day] = document.documentDate.split("-");
  const panelDate = `${day}/${month}/${year}`;
  const visibleIdentity =
    text.includes(document.fiscalNumber) &&
    (text.includes(document.documentDate) || text.includes(panelDate)) &&
    (text.includes(total) || text.includes(total.replace(".", ",")));
  const structuredIdentity =
    identity.number === document.fiscalNumber &&
    identity.date === document.documentDate &&
    identity.total === String(document.totalAmount);
  if (!structuredIdentity && !visibleIdentity) throw new Error("DOM_UNRECOGNIZED");
  return { text, remoteId: identity.remoteId };
}

export async function validateVisibleDocuments(
  page: Page,
  value: {
    documents: Array<
      Pick<
        ArubaManifestDocument,
        "id" | "filename" | "fiscalNumber" | "documentDate" | "totalAmount"
      >
    >;
  },
) {
  const table = page.locator("table", { hasText: value.documents[0]!.filename }).first();
  await table.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {
    throw new Error("DOM_UNRECOGNIZED");
  });
  const expectedFilenames = new Set(value.documents.map((document) => document.filename));
  const rows = table.locator("tbody tr");
  const rowCount = await rows.count();
  if (rowCount > 300) throw new Error("DOM_UNRECOGNIZED");
  const visibleRows = await Promise.all(
    Array.from({ length: rowCount }, (_, index) =>
      rows
        .nth(index)
        .innerText()
        .then((text) => text.slice(0, 500)),
    ),
  );
  if (
    visibleRows.some(
      (text) =>
        /\.xml\b/i.test(text) &&
        ![...expectedFilenames].some((filename) => text.includes(filename)),
    )
  ) {
    throw new Error("DOM_UNRECOGNIZED");
  }
  const results: Array<{ id: string; status: "VALID" | "INVALID"; message?: string }> = [];
  for (const document of value.documents) {
    const row = await visibleDocumentRow(page, document.filename, true);
    if (!row) throw new Error("DOM_UNRECOGNIZED");
    const { text } = await visibleDocumentIdentity(row, document);
    results.push(
      /Dettagli errori|\berror[ei]\b/i.test(text)
        ? { id: document.id, status: "INVALID", message: "Dettagli errori visibili" }
        : { id: document.id, status: "VALID" },
    );
  }
  return results;
}

export async function removeUploads(
  page: Page,
  value: { documents: Array<Pick<ArubaManifestDocument, "filename">> },
) {
  const clearPage = page.getByRole("button", { name: /^Svuota pagina$/i });
  if ((await clearPage.count()) === 1 && (await clearPage.isVisible())) {
    await clearPage.click();
    for (const document of value.documents) {
      await page
        .locator("tr", { hasText: document.filename })
        .waitFor({ state: "hidden", timeout: 10_000 })
        .catch(() => {
          throw new Error("DOM_UNRECOGNIZED");
        });
    }
    return;
  }
  for (const document of value.documents) {
    const row = await visibleDocumentRow(page, document.filename, true);
    if (!row) throw new Error("DOM_UNRECOGNIZED");
    const remove = row.getByRole("button", { name: /Rimuovi|Elimina/i }).first();
    if (!(await remove.count())) throw new Error("DOM_UNRECOGNIZED");
    await remove.click();
    await row.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {
      throw new Error("DOM_UNRECOGNIZED");
    });
  }
}

export async function finalSendButton(page: Page, documentCount: number) {
  const batch = page.getByRole("button", { name: /^Invia tutte$/i });
  if ((await batch.count()) === 1 && (await batch.isVisible()) && (await batch.isEnabled())) {
    return batch;
  }
  if (documentCount !== 1) throw new Error("DOM_UNRECOGNIZED");
  const individual = page.getByRole("button", { name: /^Invia$/i });
  if (
    (await individual.count()) !== 1 ||
    !(await individual.isVisible()) ||
    !(await individual.isEnabled())
  ) {
    throw new Error("DOM_UNRECOGNIZED");
  }
  return individual;
}

type ReadbackDocument = Extract<HelperEvent, { type: "READBACK" }>["documents"][number];

async function readback(
  page: Page,
  value: ArubaManifest,
  target: URL,
): Promise<ReadbackDocument[]> {
  const destination = page
    .getByRole("link", { name: /Fatture inviate|Documenti inviati|Inviate/i })
    .first();
  if (await destination.count()) {
    const href = await destination.getAttribute("href");
    if (!href) throw new Error("DOM_UNRECOGNIZED");
    assertNavigationUrl(new URL(href, page.url()).toString(), target);
    await destination.click();
    await page.waitForLoadState("domcontentloaded");
    assertPageOrigin(page, target);
    await assertAccount(page, value.accountReference);
  }
  const search = page.getByRole("textbox", { name: /Cerca|Ricerca/i }).first();
  const results: ReadbackDocument[] = [];
  for (const document of value.documents) {
    if (await search.count()) await search.fill(document.filename);
    const row = await visibleDocumentRow(page, document.filename, false);
    if (!row) {
      results.push({ id: document.id, status: "NOT_FOUND" as const });
      continue;
    }
    const identity = await visibleDocumentIdentity(row, document);
    const { text } = identity;
    const status: ReadbackDocument["status"] = /Consegnat[ao]/i.test(text)
      ? "DELIVERED"
      : /Mancata consegna|Non consegnat[ao]/i.test(text)
        ? "NOT_DELIVERED"
        : /Scartat[ao]|Rifiutat[ao]/i.test(text)
          ? "REJECTED"
          : /Inviat[ao]/i.test(text)
            ? "SUBMITTED"
            : /Caricat[ao]|Validat[ao]/i.test(text)
              ? "UPLOADED"
              : /Rimoss[ao]|Eliminat[ao]/i.test(text)
                ? "REMOVED"
                : "NOT_FOUND";
    const remoteId =
      identity.remoteId ??
      /(?:ID|Identificativo)(?:\s+Aruba|\s+remoto)?\s*[:#]\s*([A-Za-z0-9._/-]{3,200})/i.exec(
        text,
      )?.[1];
    results.push({ id: document.id, status, ...(remoteId ? { remoteId } : {}) });
  }
  return results;
}

async function waitForVisibleOutcome(page: Page, value: ArubaManifest) {
  await page.waitForFunction(
    (filenames) => {
      if (
        [...document.querySelectorAll('[data-aruba-state], [role="status"], p')].some((element) =>
          element.textContent?.slice(0, 500).includes("Stato non disponibile"),
        )
      ) {
        return true;
      }
      const rows = [...document.querySelectorAll("tr")];
      if (rows.length > 300) return false;
      return filenames.every((filename) =>
        rows.some(
          (row) =>
            row.textContent?.includes(filename) &&
            /Inviat|Consegnat|Mancata consegna|Non consegnat|Scartat|Rifiutat/i.test(
              row.textContent,
            ),
        ),
      );
    },
    value.documents.map((document) => document.filename),
    { timeout: 15_000 },
  );
}

const officialFileLinks = [
  ["ARUBA_XML", /Scarica XML/i],
  ["ARUBA_P7M", /Scarica P7M/i],
  ["ARUBA_PDF", /Scarica PDF/i],
  ["SDI_NOTIFICATION", /Scarica notifica/i],
] as const;

async function importVisibleOfficialFiles(
  page: Page,
  hub: URL,
  token: string,
  value: ArubaManifest,
  target: URL,
) {
  assertPageOrigin(page, target);
  for (const document of value.documents) {
    const row = await visibleDocumentRow(page, document.filename, false);
    if (!row) continue;
    for (const [kind, label] of officialFileLinks) {
      const links = row.getByRole("link", { name: label });
      const count = Math.min(await links.count(), 10);
      for (let index = 0; index < count; index += 1) {
        const link = links.nth(index);
        const href = await link.getAttribute("href");
        if (!href) throw new Error("DOM_UNRECOGNIZED");
        assertDownloadUrl(new URL(href, page.url()).toString(), target);
        const downloadPromise = page.waitForEvent("download", { timeout: 10_000 });
        await link.click();
        const download = await downloadPromise;
        assertDownloadUrl(download.url(), target);
        const downloadedPath = await download.path();
        if (!downloadedPath) throw new Error("DOWNLOAD_FAILED");
        const downloadedSize = (await stat(downloadedPath)).size;
        if (!downloadedSize || downloadedSize > ARUBA_IMPORT_MAX_BYTES) {
          throw new Error("DOWNLOAD_FAILED");
        }
        const bytes = await readFile(downloadedPath);
        await hubFetch(hub, token, `/api/aruba/helper/documenti/${document.id}/file`, {
          method: "POST",
          body: bytes,
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Aruba-File-Kind": kind,
          },
        });
      }
    }
  }
}

function launchOptions(options: HelperOptions, environment: ArubaManifest["environment"]) {
  if (options.browser === "chromium") {
    if (environment !== "MOCK") throw new Error("Chromium è ammesso soltanto nei test sintetici");
    return { headless: options.headless ?? true };
  }
  return { channel: options.browser, headless: options.headless ?? false };
}

async function keepAssistedBrowserOpen(context: BrowserContext, page: Page) {
  process.stdout.write(
    "Validazione completata. Arresto prima di Invia: il controllo resta al titolare.\n",
  );
  await Promise.race([
    page.waitForEvent("close"),
    context.waitForEvent("close"),
    new Promise<void>((resolve) => process.once("SIGINT", resolve)),
  ]);
}

export async function runHelper(
  options: HelperOptions,
): Promise<"ASSISTED_STOP" | "SUBMITTED" | "READBACK"> {
  const hub = assertAllowedHubUrl(options.hubUrl);
  const value = await manifest(hub, options.token);
  const target = assertAllowedArubaTarget(value.panelUrl, value.environment);
  if (options.mockScenario && value.environment === "MOCK") {
    target.searchParams.set("scenario", options.mockScenario);
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), "hub-fatture-aruba-"));
  let context: BrowserContext | undefined;
  let helperStarted = false;
  let uploadStarted = false;
  let finalStateKnown = false;
  try {
    await mkdir(options.profileDirectory, { recursive: true, mode: 0o700 });
    context = await chromium.launchPersistentContext(
      options.profileDirectory,
      launchOptions(options, value.environment),
    );
    const page = context.pages()[0] ?? (await context.newPage());
    await event(hub, options.token, { type: "HELPER_STARTED", browser: options.browser });
    helperStarted = true;
    await page.goto(target.toString(), { waitUntil: "domcontentloaded" });
    assertPageOrigin(page, target);
    const heartbeat = () => event(hub, options.token, { type: "HELPER_HEARTBEAT" });
    await waitForAuthentication(page, heartbeat);
    assertPageOrigin(page, target);
    await assertAccount(page, value.accountReference);
    if (await page.locator('[data-aruba-state="unexpected"]').count())
      throw new Error("DOM_UNRECOGNIZED");
    if (value.operation === "READBACK") {
      const documents = await readback(page, value, target);
      await importVisibleOfficialFiles(page, hub, options.token, value, target);
      await event(hub, options.token, {
        type: "READBACK",
        documents,
      });
      finalStateKnown = true;
      return "READBACK";
    }
    const files = await downloadDocuments(hub, options.token, value, temporary);
    assertPageOrigin(page, target);
    await (await uploadInput(page)).setInputFiles([...files.values()]);
    uploadStarted = true;
    await waitForUploadedDocument(page, value.documents[0]!.filename, heartbeat);
    assertPageOrigin(page, target);
    const results = await validateVisibleDocuments(page, value);
    await event(hub, options.token, { type: "VALIDATION", documents: results });
    if (results.some((result) => result.status === "INVALID")) {
      await removeUploads(page, value);
      await event(hub, options.token, {
        type: "READBACK",
        documents: value.documents.map((document) => ({ id: document.id, status: "REMOVED" })),
      });
      finalStateKnown = true;
      throw new Error("VALIDATION_FAILED");
    }
    const send = await finalSendButton(page, value.documents.length);
    if (value.mode !== "AUTOMATIC_AFTER_APPROVAL") {
      await event(hub, options.token, { type: "ASSISTED_STOP" });
      finalStateKnown = true;
      if (!options.closeAfterStop) await keepAssistedBrowserOpen(context, page);
      return "ASSISTED_STOP";
    }
    assertPageOrigin(page, target);
    await assertAccount(page, value.accountReference);
    if ((await validateVisibleDocuments(page, value)).some((result) => result.status !== "VALID")) {
      throw new Error("VALIDATION_FAILED");
    }
    await hubFetch(hub, options.token, "/api/aruba/helper/verifica-invio", {
      method: "POST",
      body: JSON.stringify({ manifestSha256: value.manifestSha256 }),
    });
    assertPageOrigin(page, target);
    await send.click();
    await waitForVisibleOutcome(page, value);
    if (await page.getByText("Stato non disponibile", { exact: true }).count()) {
      await event(hub, options.token, {
        type: "RECONCILIATION_REQUIRED",
        reason: "UNKNOWN_RESULT",
      });
      await event(hub, options.token, {
        type: "READBACK",
        documents: value.documents.map((document) => ({ id: document.id, status: "NOT_FOUND" })),
      });
      finalStateKnown = true;
      throw new Error("RECONCILIATION_REQUIRED");
    }
    const documents = await readback(page, value, target);
    if (
      documents.some(
        (document) =>
          document.status === "NOT_FOUND" ||
          document.status === "UPLOADED" ||
          document.status === "REMOVED" ||
          !document.remoteId,
      )
    ) {
      throw new Error("DOM_UNRECOGNIZED");
    }
    const remoteIds = Object.fromEntries(
      documents.map((document) => [document.id, document.remoteId!]),
    );
    await event(hub, options.token, { type: "SUBMITTED", remoteIds });
    await importVisibleOfficialFiles(page, hub, options.token, value, target);
    await event(hub, options.token, {
      type: "READBACK",
      documents,
    });
    finalStateKnown = true;
    return "SUBMITTED";
  } catch (error) {
    if (uploadStarted && !finalStateKnown) {
      await event(hub, options.token, {
        type: "RECONCILIATION_REQUIRED",
        reason:
          error instanceof Error && error.message === "DOM_UNRECOGNIZED"
            ? "DOM_UNRECOGNIZED"
            : "UNKNOWN_RESULT",
      }).catch(() => undefined);
    } else if (helperStarted && value.operation === "UPLOAD" && !finalStateKnown) {
      await event(hub, options.token, {
        type: "READBACK",
        documents: value.documents.map((document) => ({ id: document.id, status: "REMOVED" })),
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    await context?.close().catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }
}

async function secretPrompt(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  process.stdout.write(prompt);
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  let value = "";
  try {
    for await (const [chunk] of onKeypress(process.stdin)) {
      const key = String(chunk);
      if (key === "\r" || key === "\n") break;
      if (key === "\u0003") throw new Error("Interrotto");
      if (key === "\u007f") value = value.slice(0, -1);
      else value += key;
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdout.write("\n");
  }
  return value;
}

async function* onKeypress(stream: NodeJS.ReadStream) {
  const queue: Array<[string, unknown]> = [];
  let resolve: (() => void) | undefined;
  const listener = (chunk: string, key: unknown) => {
    queue.push([chunk, key]);
    resolve?.();
  };
  stream.on("keypress", listener);
  try {
    while (true) {
      if (!queue.length) await new Promise<void>((done) => (resolve = done));
      resolve = undefined;
      yield queue.shift()!;
    }
  } finally {
    stream.off("keypress", listener);
  }
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const hubUrl = option("--hub");
  const browser = option("--browser") as HelperOptions["browser"] | undefined;
  if (!hubUrl || !browser || !["chrome", "msedge"].includes(browser)) {
    throw new Error(
      "Uso: npm run aruba:helper -- --hub https://hub.example --browser chrome|msedge",
    );
  }
  const token = await secretPrompt("Codice di avvio helper: ");
  const profileDirectory = path.resolve(
    option("--profile") ?? path.join(os.homedir(), ".hub-fatture", "aruba-browser"),
  );
  process.stdout.write(
    `Helper Aruba ${HELPER_VERSION}. Nessuna credenziale verrà letta o salvata.\n`,
  );
  await runHelper({ hubUrl, token, browser, profileDirectory });
}
