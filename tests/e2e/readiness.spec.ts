import { expect, test, type Page } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";

import { runHelper } from "../../scripts/aruba-helper.ts";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://hub_fatture:hub_fatture_test@127.0.0.1:5433/hub_fatture_test";
const storageRoot = path.resolve("storage/e2e-documents");

async function expectPlainLanguage(page: Page) {
  await expect(page.locator("body")).not.toContainText(
    /\b(?:trigger|fixture|sandbox)\b|sorgente|normalizzat/i,
  );
}

// Lo schema viene azzerato all'avvio del server, i dati a ogni worker: un retry riparte
// da database vuoto invece di trovare gli account già creati e saltare il flusso di setup.
test.beforeAll(async () => {
  if (!new URL(databaseUrl).pathname.endsWith("_test")) throw new Error("Database E2E non isolato");
  await rm(storageRoot, { recursive: true, force: true });
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query(
    "TRUNCATE users, sessions, login_attempts, audit_events, settings, customers, billing_cases, orders, fiscal_profiles RESTART IDENTITY CASCADE",
  );
  const profile = JSON.parse(await readFile("tests/fixtures/fatturapa/profile.mock.json", "utf8"));
  await client.query(
    "INSERT INTO fiscal_profiles (version, status, profile_json) VALUES (1, 'MOCK', $1)",
    [profile],
  );
  await client.query(
    `INSERT INTO settings (key, value_json) VALUES
       ('draft_trigger', '"PAID"'),
       ('aruba_mode', '"ASSISTED"'),
       ('aruba_auth_protection', '"UNKNOWN"'),
       ('customer_email_mode', '"AUTOMATIC"')
     ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, version = 1`,
  );
  await client.end();
});

test.afterAll(async () => {
  await rm(storageRoot, { recursive: true, force: true });
});

// I test condividono gli account creati dal primo: in serie un retry li ripete tutti dall'inizio.
test.describe.configure({ mode: "serial" });

test("configura i due account e accede con entrambi", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/setup");
  await page.getByLabel("Codice di configurazione").fill("synthetic-bootstrap-token-for-tests");
  await page.getByLabel("Password per Massimo").fill("password-massimo");
  await page.getByLabel("Password per Codex").fill("password-codex");
  await page.getByRole("button", { name: "Crea gli account" }).click();

  await page.getByLabel("Nome utente").fill("mAsSiMo");
  await page.getByLabel("Password").fill("password-massimo");
  await page.getByRole("button", { name: "Accedi" }).click();

  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByText("Note di credito da approvare")).toBeVisible();
  await expect(page.locator(".summary-card")).toHaveCount(12);
  await page.getByRole("link", { name: "Documenti", exact: true }).click();
  await expect(page.getByRole("link", { name: "Vai agli ordini" })).toBeVisible();
  await page.getByRole("link", { name: "Attività", exact: true }).click();
  await expect(page.getByRole("link", { name: "Apri la cronologia" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Controlla le connessioni" })).toBeVisible();
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  const skipLink = page.getByRole("link", { name: "Vai al contenuto principale" });
  await skipLink.focus();
  await expect(skipLink).toBeVisible();
  await expectPlainLanguage(page);

  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const lightBackground = await background();

  await page.getByLabel("Apri il menu di Massimo").click();
  await page.getByRole("button", { name: "Scuro" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  // I token risolvono con `light-dark()`: l'attributo da solo non prova che il tema cambi.
  expect(await background()).not.toBe(lightBackground);

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await background()).not.toBe(lightBackground);
  await page.getByLabel("Apri il menu di Massimo").click();
  await expect(page.locator(".profile-menu__identity")).toContainText("Massimo");
  await expect(page.locator(".profile-menu__identity")).toContainText("Titolare");
  await expect(page.locator(".profile-menu__permission")).toContainText(
    "Può approvare, numerare e autorizzare gli invii.",
  );
  expect(
    await page
      .locator(".profile-menu .theme-picker__choice svg")
      .evaluateAll((icons) => icons.map((icon) => icon.getBoundingClientRect().width)),
  ).toEqual([20, 20, 20]);
  await page.getByRole("link", { name: "Profilo e sicurezza" }).click();
  await expect(page).toHaveURL(/\/impostazioni#profilo-sicurezza$/);
  await expect(page.getByRole("heading", { name: "Profilo e sicurezza" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Sezioni delle impostazioni" })).toContainText(
    "E-mail al cliente",
  );
  await expect(page.getByRole("group", { name: "Tema" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Salva impostazione" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Salva integrazione Aruba" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Salva modalità e-mail" })).toBeDisabled();
  await expect(page.getByText("Questa sessione", { exact: true })).toBeVisible();
  await expect(
    page.getByText("016_historical_order_reconciliation.sql", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Disabilitato", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Nessuna ricevuta valida disponibile", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Apri il menu di Massimo").click();
  await page.locator(".profile-menu").getByRole("button", { name: "Esci" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/setup");
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel("Nome utente").fill("CODEX");
  await page.getByLabel("Password").fill("password-codex");
  await page.getByRole("button", { name: "Accedi" }).click();
  await page.getByLabel("Apri il menu di Codex").click();
  await expect(page.locator(".profile-menu__identity")).toContainText("Codex");
  await expect(page.locator(".profile-menu__identity")).toContainText("Operatore");

  await page.getByRole("link", { name: "Ordini", exact: true }).click();
  await page.getByRole("button", { name: "Carica ordini di esempio" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Ordini di esempio caricati. Nuovi: 3; aggiornati: 0; meno recenti ignorati: 0.",
  );
  await expectPlainLanguage(page);
  await expect(page.getByRole("row")).toHaveCount(4);
  await expect(page.getByLabel(/^Data ordine/)).toHaveValue("");
  const controlHeights = await page
    .getByRole("search", { name: "Filtra gli ordini" })
    .locator("input, select, button")
    .evaluateAll((controls) => controls.map((control) => control.getBoundingClientRect().height));
  expect([...new Set(controlHeights)]).toEqual([44]);
  await expect(page.getByRole("navigation", { name: "Navigazione principale" })).not.toContainText(
    "Schede",
  );
  await page.getByLabel(/^Pagamento/).selectOption("PENDING");
  await page.getByRole("button", { name: "Filtra" }).click();
  await expect(page.getByRole("row")).toHaveCount(2);
  await expect(page.getByLabel(/^Pagamento/)).toHaveValue("PENDING");
  await expect(page.getByText("1 filtro attivo")).toBeVisible();
  await expect(page.getByRole("link", { name: "Azzera filtri" })).toBeVisible();

  await page.getByRole("link", { name: "Da fatturare" }).click();
  await expect(page.getByRole("row")).toHaveCount(2);
  await expect(page.getByRole("cell", { name: "2", exact: true })).toBeVisible();
  await page.getByRole("link", { name: /^Apri preparazione fattura \d{6}$/ }).click();
  await expect(page.getByRole("heading", { name: /^Preparazione fattura \d{6}$/ })).toBeVisible();
  await expectPlainLanguage(page);
  await expect(page.getByText("Preparazione fattura creata")).toBeVisible();
  await expect(page.getByText("BILLING_CASE_CREATED")).toHaveCount(0);
  await page.getByLabel(/^Motivo della scelta/).fill("Ordine di test");
  await page.getByRole("button", { name: "Non trasmettere" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Ordine di test" })).toBeVisible();
  const archivedPreparation = await page
    .getByRole("heading", { name: /^Preparazione fattura \d{6}$/ })
    .textContent();
  await page.getByRole("link", { name: "Ordini", exact: true }).click();
  await page.getByRole("link", { name: "Annullati" }).click();
  await expect(page.getByRole("heading", { name: "Preparazioni non trasmesse" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Da non trasmettere", exact: true })).toBeVisible();
  const archivedOrderFilters = page.getByRole("search", { name: "Filtra gli ordini" });
  await archivedOrderFilters.getByLabel("Cerca").fill("ordine-inesistente");
  await archivedOrderFilters.getByRole("button", { name: "Filtra" }).click();
  await expect(page.getByRole("cell", { name: "Da non trasmettere", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Nessun ordine annullato" })).toBeVisible();
  await page
    .getByRole("link", { name: `Apri ${archivedPreparation}` })
    .first()
    .click();
  await page.getByRole("button", { name: "Riattiva preparazione" }).click();
  await expect(page.getByRole("button", { name: "Non trasmettere" })).toBeVisible();

  // Separazione di un ordine e reinserimento dello stesso ordine compatibile.
  await page.getByRole("button", { name: "Separa dalla preparazione" }).first().click();
  await expect(page.getByRole("button", { name: "Separa dalla preparazione" })).toHaveCount(0);
  await page.getByLabel("Aggiungi un ordine compatibile").selectOption({ index: 0 });
  await page.getByRole("button", { name: "Aggiungi", exact: true }).click();
  await expect(page.getByText("Ordine separato dalla preparazione")).toBeVisible();
  await expect(page.getByRole("button", { name: "Separa dalla preparazione" })).toHaveCount(2);

  await page.getByRole("link", { name: /^Shopify/ }).click();
  await expect(page.getByText("Pagato", { exact: true })).toBeVisible();
  await expect(page.getByText("Spedito", { exact: true })).toBeVisible();
  await expect(page.getByText("Fattura in preparazione", { exact: true })).toBeVisible();
  await expectPlainLanguage(page);
  await expect(page.getByText("PRIVATE_IT")).toHaveCount(0);
  await expect(page.locator(".detail-stack > .card")).toHaveCount(2);
  await expect(
    page.locator(".detail-subsection").getByRole("heading", { name: "Pagamenti" }),
  ).toBeVisible();
  await expect(page.locator(".customer-comparison__section")).toHaveCount(2);

  await page.getByRole("link", { name: "Ordini", exact: true }).click();
  await page.getByRole("link", { name: "In attesa" }).click();
  await page.getByRole("link", { name: /#S-1002/ }).click();
  await page.getByRole("button", { name: "Prepara la fattura ora" }).click();
  await expect(page.getByRole("heading", { name: /^Preparazione fattura \d{6}$/ })).toBeVisible();
  await expect(page.getByText("Preparazione anticipata richiesta")).toBeVisible();

  const connectionClient = new pg.Client({ connectionString: databaseUrl });
  await connectionClient.connect();
  await connectionClient.query(
    `INSERT INTO connections
       (provider, environment, account_reference, encrypted_credentials, status, created_at)
     VALUES
       ('SHOPIFY', 'DEVELOPMENT', 'shop.example.invalid', 'synthetic', 'CONNECTED',
        '2026-08-01T10:00:00Z'),
       ('EBAY', 'SANDBOX', 'ebay-synthetic', 'synthetic', 'CONNECTED',
        '2026-08-10T10:00:00Z')
     ON CONFLICT (provider, environment) DO UPDATE SET
       status = 'CONNECTED', created_at = EXCLUDED.created_at`,
  );
  await connectionClient.end();
  await page.getByRole("link", { name: "Impostazioni" }).click();
  await expect(page.getByLabel("Importa ordini Shopify dal")).toHaveAttribute("type", "date");
  await expect(page.getByLabel("Importa ordini Shopify dal")).toHaveValue("2026-07-25");
  await expect(page.getByLabel("Importa ordini eBay dal")).toHaveValue("2026-08-03");
  await page.goto("/impostazioni?historyStart=2026-08-09&historyProvider=EBAY#connessioni");
  await expect(page.getByLabel("Importa ordini Shopify dal")).toHaveValue("2026-07-25");
  await expect(page.getByLabel("Importa ordini eBay dal")).toHaveValue("2026-08-09");
  await expect(page.getByRole("button", { name: "Controlla intervallo" })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Importa storico" })).toHaveCount(2);
  await page.getByLabel("Prepara la fattura").selectOption("FULFILLED");
  await page.getByRole("button", { name: "Salva impostazione" }).click();
  await expect(page.getByRole("status")).toContainText("Impostazione aggiornata");
  await expectPlainLanguage(page);
  await page.getByRole("link", { name: "Ordini", exact: true }).click();
  await page.getByRole("link", { name: "Da verificare" }).click();
  await expect(page.getByRole("row")).toHaveCount(2);
  await expect(page.getByRole("cell", { name: "Da verificare", exact: true })).toBeVisible();
  await page.getByRole("link", { name: /^Apri preparazione fattura \d{6}$/ }).click();

  // Il controllo dichiara il fatto osservato, non una frase generica.
  await expect(page.getByRole("heading", { name: "Cose da controllare" })).toBeVisible();
  await expect(page.getByText("Pagamento non ancora acquisito")).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "controlla i dati indicati come incompleti o modificati",
  );

  // La correzione dei dati cliente si chiude direttamente dall'applicazione.
  await page.getByLabel("Cognome").fill("Rossi Verificato");
  await expect(page.getByRole("group", { name: "Cliente" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Indirizzo di fatturazione" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Dati fiscali" })).toBeVisible();
  await page.getByLabel("Motivo della correzione").fill("Dati confermati dal cliente");
  await page.getByRole("button", { name: "Salva dati cliente" }).click();
  await expect(page.getByText("Anagrafica cliente corretta")).toBeVisible();
  await expect(page.getByText(/^Corretta il /)).toBeVisible();

  await page.getByRole("link", { name: "Attività" }).click();
  await expect(page.getByRole("link", { name: /^Preparazione fattura \d{6}$/ })).toBeVisible();
  await page.getByRole("link", { name: "Cronologia" }).click();
  await page.getByLabel("Tipo di attività").selectOption("CUSTOMER_CORRECTED");
  await page.getByRole("button", { name: "Filtra" }).click();
  // Il filtro applica davvero l'azione scelta e l'audit distingue i due account.
  await expect(page.getByRole("row")).toHaveCount(2);
  await expect(page.getByRole("cell", { name: "Anagrafica cliente corretta" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Codex", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Preparazione fattura \d{6}$/ })).toBeVisible();

  await page.setViewportSize({ width: 320, height: 720 });
  await expect(page.locator(".table-wrap--history tr").first()).toBeVisible();
  expect(
    await page
      .locator(".table-wrap--history tr")
      .first()
      .evaluate((row) => row.getBoundingClientRect().height),
  ).toBeLessThan(240);
  await page.getByRole("link", { name: "Ordini", exact: true }).click();
  await expect(page.locator("tbody tr").first()).toBeVisible();
  await expect(page.locator('.nav-item[aria-current="page"]')).toHaveText("Ordini");
  const mobileNavigation = await page.locator(".nav-item").evaluateAll((items) =>
    items.map((item) => ({
      current: item.getAttribute("aria-current"),
      labelWidth: item.querySelector("span")?.getBoundingClientRect().width ?? 0,
      right: item.getBoundingClientRect().right,
    })),
  );
  expect(mobileNavigation.filter((item) => item.labelWidth > 1)).toHaveLength(1);
  expect(mobileNavigation.find((item) => item.current === "page")?.labelWidth).toBeGreaterThan(1);
  expect(mobileNavigation.every((item) => item.right <= 320)).toBe(true);
  const viewportFits = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  expect(viewportFits).toBe(true);
  await page.goto("/ordini?vista=annullati");
  const activeView = page.locator('.view-nav__item[aria-current="page"]');
  await expect(activeView).toBeVisible();
  expect(
    await activeView.evaluate((item) => item.getBoundingClientRect().left),
  ).toBeGreaterThanOrEqual(0);
  expect(
    await activeView.evaluate((item) => item.getBoundingClientRect().right),
  ).toBeLessThanOrEqual(320);

  await page.getByRole("link", { name: "Impostazioni", exact: true }).click();
  const sectionPicker = page.getByLabel("Vai alla sezione");
  await expect(sectionPicker).toBeVisible();
  await sectionPicker.selectOption("sistema");
  await expect(page.getByRole("heading", { name: "Dettagli tecnici" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByLabel("Apri il menu di Codex").click();
  await page.locator(".profile-menu").getByRole("button", { name: "Esci" }).click();
  await page.getByLabel("Nome utente").fill("MASSIMO");
  await page.getByLabel("Password").fill("password-massimo");
  await page.getByRole("button", { name: "Accedi" }).click();
  await page.getByRole("link", { name: "Ordini", exact: true }).click();
  await page.getByRole("link", { name: "Da fatturare" }).click();
  await page
    .getByRole("link", { name: `Apri ${archivedPreparation}` })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Confronto fiscale" })).toBeVisible();
  await expect(page.getByText("RF14 · N5 · FPR · versione 1")).toBeVisible();
  await expect(page.getByRole("table", { name: "Destinatario" })).toContainText("Origine");
  await expect(page.getByRole("table", { name: "Righe" })).toContainText("Proiezione XML");
  await expect(page.getByRole("table", { name: "Pagamento" })).toContainText("TP02 · MP08");
  await expect(page.getByRole("table", { name: "Dati tecnici e fiscali" })).toContainText(
    "TD01 · FPR12 · FPR",
  );
  await page.getByRole("button", { name: "Salva e valida bozza" }).click();
  await expect(page.getByRole("group", { name: "Conferma finale" })).toContainText(
    "numero fiscale definitivo",
  );
  await page.getByLabel(/Confermo i dati riepilogati e autorizzo l’approvazione/).check();
  const approvalResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().includes("/ordini/preparazione/"),
  );
  await page.getByRole("button", { name: "Approva, numera e prepara per Aruba" }).click();
  if ((await approvalResponse).status() >= 400) {
    await page.getByRole("alert").waitFor();
    throw new Error((await page.getByRole("alert").textContent()) ?? "Approvazione non riuscita");
  }
  await expect(
    page.getByRole("button", { name: "Approva, numera e prepara per Aruba" }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Documenti", exact: true }).click();
  await expect(page.getByRole("cell", { name: "Approvata", exact: true })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Scarica XML" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.xml$/);

  await page.getByRole("button", { name: "Genera codice di avvio" }).click();
  const assistedToken = (await page.locator(".code-block").textContent())?.trim();
  expect(assistedToken).toHaveLength(43);
  const assistedManifestResponse = await fetch("http://127.0.0.1:4173/api/aruba/helper/manifest", {
    headers: { Authorization: `Bearer ${assistedToken}` },
  });
  expect(assistedManifestResponse.ok).toBe(true);
  const assistedManifest = (await assistedManifestResponse.json()) as {
    documents: Array<{ id: string }>;
  };
  const assistedProfile = await mkdtemp(path.join(tmpdir(), "hub-fatture-aruba-assisted-"));
  try {
    expect(
      await runHelper({
        hubUrl: "http://127.0.0.1:4173",
        token: assistedToken!,
        profileDirectory: assistedProfile,
        browser: "chromium",
        headless: true,
        mockScenario: "login-auto",
        closeAfterStop: true,
      }),
    ).toBe("ASSISTED_STOP");
  } finally {
    await rm(assistedProfile, { recursive: true, force: true });
  }
  const revokedResponse = await fetch("http://127.0.0.1:4173/api/aruba/helper/eventi", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${assistedToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "READBACK",
      documents: assistedManifest.documents.map((document) => ({
        id: document.id,
        status: "REMOVED",
      })),
    }),
  });
  expect(revokedResponse.status).toBe(401);
  await page.reload();
  await page.getByRole("button", { name: "Genera codice di avvio" }).click();
  const readbackToken = (await page.locator(".code-block").textContent())?.trim();
  const cleanupResponse = await fetch("http://127.0.0.1:4173/api/aruba/helper/eventi", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${readbackToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "READBACK",
      documents: assistedManifest.documents.map((document) => ({
        id: document.id,
        status: "REMOVED",
      })),
    }),
  });
  expect(cleanupResponse.ok).toBe(true);

  await page.getByRole("link", { name: "Impostazioni" }).click();
  await page.getByLabel("Modalità Aruba").selectOption("AUTOMATIC");
  await page.getByLabel("Protezione dichiarata").selectOption("SMS_PER_UPLOAD");
  const settingsResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().includes("/impostazioni"),
  );
  await page.getByRole("button", { name: "Salva integrazione Aruba" }).click();
  expect((await settingsResponse).status()).toBeLessThan(400);
  await expect(page).toHaveURL(/aruba=salvata/);
  await expect(page.getByRole("status")).toContainText("Impostazioni Aruba aggiornate");
  await expect(page.getByLabel("Modalità Aruba")).toHaveValue("AUTOMATIC");
  await expect(page.getByLabel("Protezione dichiarata")).toHaveValue("SMS_PER_UPLOAD");
  await page.getByRole("link", { name: "Documenti", exact: true }).click();
  await page.getByRole("button", { name: "Prepara nuovo tentativo" }).click();
  await page.getByRole("button", { name: "Genera codice di avvio" }).first().click();
  const retryToken = (await page.locator(".code-block").textContent())?.trim();
  expect(retryToken).toHaveLength(43);
  const retryProfile = await mkdtemp(path.join(tmpdir(), "hub-fatture-aruba-retry-"));
  try {
    expect(
      await runHelper({
        hubUrl: "http://127.0.0.1:4173",
        token: retryToken!,
        profileDirectory: retryProfile,
        browser: "chromium",
        headless: true,
        closeAfterStop: true,
      }),
    ).toBe("ASSISTED_STOP");
  } finally {
    await rm(retryProfile, { recursive: true, force: true });
  }

  process.env.APP_ENV = "test";
  process.env.APP_BASE_URL = "http://127.0.0.1:4173";
  process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
  process.env.DATABASE_URL = databaseUrl;
  process.env.DOCUMENT_STORAGE_ROOT = storageRoot;
  process.env.SMTP_TRANSPORT = "SYNTHETIC";
  const database = await import("../../src/db/client.server.ts");
  const aruba = await import("../../src/db/aruba.server.ts");
  const documents = await import("../../src/db/documents.server.ts");
  const refunds = await import("../../src/db/refunds.server.ts");
  const email = await import("../../src/db/email.server.ts");
  const jobs = await import("../../src/db/connectors.server.ts");
  const orders = await import("../../src/db/orders.server.ts");
  const actorRow = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM users WHERE username = 'Massimo'")
  ).rows[0]!;
  const actor = {
    id: Number(actorRow.id),
    canApprove: true,
    requestId: "m6-e2e-synthetic",
  };
  const historicalFixture = JSON.parse(
    await readFile("tests/fixtures/orders/normalized.mock.json", "utf8"),
  )[0];
  historicalFixture.externalOrderId = "release-candidate-history";
  historicalFixture.displayNumber = "#RC-HISTORY";
  historicalFixture.externalCustomerId = "release-candidate-customer";
  historicalFixture.customer.taxIdentifiers[0].value = "RSSMRA80A01H501E";
  historicalFixture.historical = true;
  await orders.importOrders([historicalFixture], {
    id: actor.id,
    requestId: "release-candidate-history",
  });
  await page.goto("/ordini?vista=verificare");
  await expect(page.getByRole("heading", { name: "Ordini storici da riconciliare" })).toBeVisible();
  await page.getByRole("link", { name: /#RC-HISTORY/ }).click();
  await page.getByLabel("Esito del confronto").selectOption("ALREADY_INVOICED");
  await page
    .getByLabel("Riferimento verificato o motivazione")
    .fill("Documento Aruba FPR 0010/26 verificato");
  await page.getByRole("button", { name: "Registra la riconciliazione" }).click();
  await expect(page.getByText("Storico riconciliato")).toBeVisible();
  await expect(page.getByText("Fatturato", { exact: true })).toBeVisible();
  const invoice = (
    await database.getPool().query<{
      id: string;
      order_id: string;
      filename: string;
    }>(
      `SELECT documents.id, document_orders.order_id, batch_documents.filename
       FROM documents
       JOIN document_orders ON document_orders.document_id = documents.id
         AND document_orders.document_kind = 'INVOICE'
       JOIN LATERAL (
         SELECT aruba_batch_documents.filename
         FROM aruba_batch_documents
         JOIN aruba_batches ON aruba_batches.id = aruba_batch_documents.batch_id
         WHERE aruba_batch_documents.document_id = documents.id
         ORDER BY aruba_batches.created_at DESC LIMIT 1
       ) AS batch_documents ON true
       WHERE documents.kind = 'INVOICE' AND documents.status = 'APPROVED'
       ORDER BY documents.approved_at DESC LIMIT 1`,
    )
  ).rows[0]!;
  const officialPdf = Buffer.from(
    await readFile("tests/fixtures/aruba/official-pdf.synthetic.base64", "utf8"),
    "base64",
  );
  const deliveredNotification = await readFile(
    "tests/fixtures/aruba/notification-delivered.synthetic.xml",
    "utf8",
  );
  await aruba.importOfficialArubaFile(
    invoice.id,
    "ARUBA_XML",
    (await documents.readDocumentXml(invoice.id))!,
    actor,
  );
  await aruba.importOfficialArubaFile(invoice.id, "ARUBA_PDF", officialPdf, actor);
  await aruba.importOfficialArubaFile(
    invoice.id,
    "SDI_NOTIFICATION",
    Buffer.from(deliveredNotification.replace("SYNTHETIC-DOCUMENT.xml", invoice.filename)),
    actor,
  );

  const refundId = (
    await database.getPool().query<{ id: string }>(
      `INSERT INTO refunds
        (provider, external_account_id, external_order_id, external_refund_id,
         order_id, status, amount, completed_at, raw_json)
       SELECT orders.provider, orders.external_account_id, orders.external_order_id,
              'm6-e2e-refund', orders.id, 'COMPLETED', 500, now(), '{}'
       FROM orders WHERE orders.id = $1 RETURNING id`,
      [invoice.order_id],
    )
  ).rows[0]!.id;
  await database.getPool().query(
    `UPDATE settings SET value_json = '"ASSISTED"'::jsonb, version = version + 1
     WHERE key = 'aruba_mode'`,
  );
  const noteId = await refunds.processRefund(refundId);
  expect(noteId).toBeTruthy();
  await page.goto(`/documenti/${noteId}/nota`);
  await expect(page.getByRole("heading", { name: "Comparatore fiscale" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Righe" })).toContainText("rimborso m6-e2e-refund");
  await expect(page.getByRole("table", { name: "Righe" })).toContainText("N5");
  await expect(page.getByRole("table", { name: "Fattura originaria" })).toContainText(
    "DatiFattureCollegate",
  );
  await expect(page.getByText("PDF ufficiale Aruba, dopo l’esito SdI")).toBeVisible();
  await page
    .getByLabel(/Confermo rimborsi, riferimenti alla fattura, totale e numerazione irreversibile/)
    .check();
  await page.getByRole("button", { name: "Approva, numera e prepara per Aruba" }).click();
  await expect(page).toHaveURL(/\/documenti$/);

  const note = (
    await database.getPool().query<{ filename: string; batch_id: string }>(
      `SELECT batch_documents.filename, batch_documents.batch_id
       FROM aruba_batch_documents AS batch_documents
       JOIN aruba_batches AS batches ON batches.id = batch_documents.batch_id
       WHERE batch_documents.document_id = $1
       ORDER BY batches.created_at DESC LIMIT 1`,
      [noteId],
    )
  ).rows[0]!;
  const noteToken = await aruba.issueHelperToken(note.batch_id, actor);
  const noteProfile = await mkdtemp(path.join(tmpdir(), "hub-fatture-m6-td04-"));
  try {
    expect(
      await runHelper({
        hubUrl: "http://127.0.0.1:4173",
        token: noteToken.token,
        profileDirectory: noteProfile,
        browser: "chromium",
        headless: true,
        mockScenario: "valid",
        closeAfterStop: true,
      }),
    ).toBe("ASSISTED_STOP");
  } finally {
    await rm(noteProfile, { recursive: true, force: true });
  }
  await aruba.importOfficialArubaFile(
    noteId!,
    "ARUBA_XML",
    (await documents.readDocumentXml(noteId!))!,
    actor,
  );
  await aruba.importOfficialArubaFile(noteId!, "ARUBA_PDF", officialPdf, actor);
  await aruba.importOfficialArubaFile(
    noteId!,
    "SDI_NOTIFICATION",
    Buffer.from(deliveredNotification.replace("SYNTHETIC-DOCUMENT.xml", note.filename)),
    actor,
  );
  for (;;) {
    const job = await jobs.claimJob("m6-e2e-email");
    if (!job) break;
    expect(job.type).toBe("send_customer_email");
    await email.sendCustomerEmail(job);
    expect(await jobs.completeJob(job)).toBe(true);
  }
  assert.equal(
    (
      await database
        .getPool()
        .query(
          "SELECT status FROM email_deliveries WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1",
          [noteId],
        )
    ).rows[0].status,
    "SENT",
  );
  assert.equal(
    (await database.getPool().query("SELECT status FROM documents WHERE id = $1", [noteId])).rows[0]
      .status,
    "APPROVED",
  );
  await page.reload();
  await expect(
    page.locator(`a[href='/documenti/${noteId}/nota']`).locator("xpath=ancestor::tr"),
  ).toContainText("Inviata");
});

test("le mutazioni senza origine valida non raggiungono l’azione", async ({ request }) => {
  const headers = { origin: "http://attaccante.invalid" };

  // Route risorsa: la guardia applicativa deve rispondere con il codice del registro,
  // non con un 500 generico.
  const logout = await request.post("/logout", { form: { csrf: "assente" }, headers });
  expect(logout.status()).toBe(403);
  expect(await logout.json()).toMatchObject({ code: "REQUEST_ORIGIN_INVALID" });

  // Route documento: React Router rifiuta la richiesta cross-origin prima dell'azione.
  const login = await request.post("/login", {
    form: { username: "massimo", password: "password-massimo" },
    headers,
  });
  expect(login.status()).toBeGreaterThanOrEqual(400);
  expect(login.status()).toBeLessThan(500);
});

test("gli errori delle azioni restano codici stabili, non 500", async ({ request }) => {
  const headers = { origin: "http://127.0.0.1:4173" };
  expect((await request.post("/logout", { form: { csrf: "x" } })).status()).toBe(403);
  expect((await request.post("/login", { headers, data: { username: "Massimo" } })).status()).toBe(
    415,
  );

  await request.post("/login", {
    headers,
    form: { username: "MASSIMO", password: "password-massimo" },
  });
  expect((await request.post("/logout", { headers, form: { csrf: "sbagliato" } })).status()).toBe(
    403,
  );
  expect((await request.post("/logout", { headers, form: { csrf: "x" } })).status()).toBe(403);
});

test("le risposte dichiarano gli header di sicurezza minimi", async ({ request }) => {
  const headers = (await request.get("/login")).headers();
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("same-origin");
  expect(headers["cache-control"]).toBe("no-store, private");

  await request.post("/login", {
    headers: { origin: "http://127.0.0.1:4173" },
    form: { username: "mAsSiMo", password: "password-massimo" },
  });
  const dataHeaders = (await request.get("/ordini.data")).headers();
  expect(dataHeaders["cache-control"]).toBe("no-store, private");
  expect(dataHeaders.vary).toContain("Cookie");
});
