import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://hub_fatture:hub_fatture_test@127.0.0.1:5433/hub_fatture_test";

async function expectPlainLanguage(page: Page) {
  await expect(page.locator("body")).not.toContainText(
    /\b(?:trigger|fixture|sandbox)\b|sorgente|normalizzat/i,
  );
}

// Lo schema viene azzerato all'avvio del server, i dati a ogni worker: un retry riparte
// da database vuoto invece di trovare gli account già creati e saltare il flusso di setup.
test.beforeAll(async () => {
  if (!new URL(databaseUrl).pathname.endsWith("_test")) throw new Error("Database E2E non isolato");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query(
    "TRUNCATE users, sessions, login_attempts, audit_events, settings, customers, billing_cases, orders RESTART IDENTITY CASCADE",
  );
  await client.query(
    `INSERT INTO settings (key, value_json) VALUES ('draft_trigger', '"PAID"')
     ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, version = 1`,
  );
  await client.end();
});

// I test condividono gli account creati dal primo: in serie un retry li ripete tutti dall'inizio.
test.describe.configure({ mode: "serial" });

test("configura i due account e accede con entrambi", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/setup");
  await page.getByLabel("Codice di configurazione").fill("synthetic-bootstrap-token-for-tests");
  await page.getByLabel("Password per matteo").fill("password-matteo");
  await page.getByLabel("Password per codex").fill("password-codex");
  await page.getByRole("button", { name: "Crea gli account" }).click();

  await page.getByLabel("Nome utente").fill("matteo");
  await page.getByLabel("Password").fill("password-matteo");
  await page.getByRole("button", { name: "Accedi" }).click();

  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByText("Ordini importati")).toBeVisible();
  await expect(page.locator(".summary-card")).toHaveCount(5);
  const skipLink = page.getByRole("link", { name: "Vai al contenuto principale" });
  await skipLink.focus();
  await expect(skipLink).toBeVisible();
  await expectPlainLanguage(page);

  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const lightBackground = await background();

  await page.getByLabel("Apri il menu di matteo").click();
  await page.getByRole("button", { name: "Scuro" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  // I token risolvono con `light-dark()`: l'attributo da solo non prova che il tema cambi.
  expect(await background()).not.toBe(lightBackground);

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await background()).not.toBe(lightBackground);
  await page.getByLabel("Apri il menu di matteo").click();
  await expect(page.locator(".profile-menu__identity")).toHaveText("matteo");
  await page.getByRole("button", { name: "Esci" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/setup");
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel("Nome utente").fill("codex");
  await page.getByLabel("Password").fill("password-codex");
  await page.getByRole("button", { name: "Accedi" }).click();
  await page.getByLabel("Apri il menu di codex").click();
  await expect(page.locator(".profile-menu__identity")).toHaveText("codex");

  await page.getByRole("link", { name: "Ordini", exact: true }).click();
  await page.getByRole("button", { name: "Carica ordini di esempio" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Ordini di esempio caricati. Nuovi: 3; aggiornati: 0; meno recenti ignorati: 0.",
  );
  await expectPlainLanguage(page);
  await expect(page.getByRole("row")).toHaveCount(4);
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
  await expect(page.getByRole("status")).toContainText("Ordine di test");
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
  await page.getByRole("link", { name: `Apri ${archivedPreparation}` }).click();
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

  await page.getByRole("link", { name: "Impostazioni" }).click();
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
  await expect(page.getByRole("cell", { name: "codex", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Preparazione fattura \d{6}$/ })).toBeVisible();

  await page.setViewportSize({ width: 320, height: 720 });
  await page.getByRole("link", { name: "Ordini", exact: true }).click();
  await expect(page.locator("tbody tr").first()).toBeVisible();
  const viewportFits = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  expect(viewportFits).toBe(true);
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
    form: { username: "matteo", password: "password-matteo" },
    headers,
  });
  expect(login.status()).toBeGreaterThanOrEqual(400);
  expect(login.status()).toBeLessThan(500);
});

test("gli errori delle azioni restano codici stabili, non 500", async ({ request }) => {
  const headers = { origin: "http://127.0.0.1:4173" };
  expect((await request.post("/logout", { form: { csrf: "x" } })).status()).toBe(403);
  expect((await request.post("/login", { headers, data: { username: "matteo" } })).status()).toBe(
    415,
  );

  await request.post("/login", {
    headers,
    form: { username: "matteo", password: "password-matteo" },
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
});
