import { expect, test } from "@playwright/test";
import pg from "pg";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://hub_fatture:hub_fatture_test@127.0.0.1:5433/hub_fatture_test";

test.beforeAll(async () => {
  if (!new URL(databaseUrl).pathname.endsWith("_test")) throw new Error("Database E2E non isolato");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query(
    "TRUNCATE users, login_attempts, audit_events, settings RESTART IDENTITY CASCADE",
  );
  await client.end();
});

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
  await expect(page.getByText("Nessun dato è ancora disponibile.")).toBeVisible();

  await page.getByLabel("Apri il menu del profilo").click();
  await page.getByRole("button", { name: "Scuro" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
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
});
