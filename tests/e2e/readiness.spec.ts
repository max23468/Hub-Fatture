import { expect, test } from "@playwright/test";
import pg from "pg";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://hub_fatture:hub_fatture_test@127.0.0.1:5433/hub_fatture_test";

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
  await page.goto("/setup");
  await page.getByLabel("Token di configurazione").fill("synthetic-bootstrap-token-for-tests");
  await page.getByLabel("Password per matteo").fill("password-matteo");
  await page.getByLabel("Password per codex").fill("password-codex");
  await page.getByRole("button", { name: "Crea gli account" }).click();

  await page.getByLabel("Username").fill("matteo");
  await page.getByLabel("Password").fill("password-matteo");
  await page.getByRole("button", { name: "Accedi" }).click();

  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByText("Ordini importati")).toBeVisible();

  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const lightBackground = await background();

  await page.getByLabel("Apri il menu del profilo").click();
  await page.getByRole("button", { name: "Scuro" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  // I token risolvono con `light-dark()`: l'attributo da solo non prova che il tema cambi.
  expect(await background()).not.toBe(lightBackground);

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await background()).not.toBe(lightBackground);
  await page.getByLabel("Apri il menu del profilo").click();
  await expect(page.getByText("matteo", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Esci" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/setup");
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel("Username").fill("codex");
  await page.getByLabel("Password").fill("password-codex");
  await page.getByRole("button", { name: "Accedi" }).click();
  await page.getByLabel("Apri il menu del profilo").click();
  await expect(page.getByText("codex", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Ordini" }).click();
  await page.getByRole("button", { name: "Importa dati sintetici" }).click();
  await expect(page.getByRole("status")).toContainText("3 nuovi ordini");
  await expect(page.getByRole("row")).toHaveCount(4);
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
  await page.getByRole("link", { name: /^S-/ }).click();
  await expect(page.getByRole("heading", { name: /^Preparazione fattura S-/ })).toBeVisible();
  await expect(page.getByText("Preparazione fattura creata")).toBeVisible();
  await expect(page.getByText("BILLING_CASE_CREATED")).toHaveCount(0);

  await page.getByRole("link", { name: /^Shopify/ }).click();
  await expect(page.getByText("Pagato", { exact: true })).toBeVisible();
  await expect(page.getByText("Evaso", { exact: true })).toBeVisible();
  await expect(page.getByText("In preparazione", { exact: true })).toBeVisible();
  await expect(page.getByText("PRIVATE_IT")).toHaveCount(0);

  await page.getByRole("link", { name: "Ordini" }).click();
  await page.getByRole("link", { name: "In attesa" }).click();
  await page.getByRole("link", { name: /#S-1002/ }).click();
  await page.getByRole("button", { name: "Prepara ora" }).click();
  await expect(page.getByRole("heading", { name: /^Preparazione fattura S-/ })).toBeVisible();
  await expect(page.getByText("Preparazione anticipata richiesta")).toBeVisible();

  await page.getByRole("link", { name: "Ordini" }).click();
  await page.getByLabel("Prepara la fattura").selectOption("FULFILLED");
  await page.getByRole("button", { name: "Salva trigger" }).click();
  await expect(page.getByRole("status")).toContainText("Trigger aggiornato");
  await page.getByRole("link", { name: "Da verificare" }).click();
  await expect(page.getByRole("row")).toHaveCount(2);
  await expect(page.getByRole("cell", { name: "Da verificare", exact: true })).toBeVisible();
  await page.getByRole("link", { name: /^S-/ }).click();
  await expect(page.getByRole("status")).toContainText("richiedono una verifica");

  await page.setViewportSize({ width: 320, height: 720 });
  await page.getByRole("link", { name: "Ordini" }).click();
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
