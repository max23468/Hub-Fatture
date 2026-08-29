import { expect, test } from "@playwright/test";

import { encryptCredential, hashPassword } from "../../src/crypto.server.ts";
import { withResetE2eDatabase } from "./database.ts";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://hub_fatture:hub_fatture_test@127.0.0.1:5433/hub_fatture_test";
const credentialsEncryptionKey = Buffer.alloc(32, 9).toString("base64url");

test.beforeAll(async () => {
  await withResetE2eDatabase(databaseUrl, async (client) => {
    const [ownerHash, agentHash] = await Promise.all([
      hashPassword("password-massimo"),
      hashPassword("password-codex"),
    ]);
    await client.query(
      `INSERT INTO users (username, password_hash, can_approve)
       VALUES ('Massimo', $1, true), ('Codex', $2, false)`,
      [ownerHash, agentHash],
    );
    const encryptedCredentials = encryptCredential(
      {
        apiEnvironment: "DEMO",
        username: "utente-pannello-sintetico",
        password: "password-pannello-sintetica",
        expectedTaxId: "00000000000",
      },
      credentialsEncryptionKey,
    );
    await client.query(
      `INSERT INTO connections
         (provider, environment, account_reference, encrypted_credentials, status,
          api_paused, inbound_enabled, automatic_authority, last_checked_at,
          credentials_verified_at)
       VALUES ('ARUBA', 'DEVELOPMENT', 'synthetic-aruba-layout', $1,
         'CONNECTED', false, true, 'API', now(), now())`,
      [encryptedCredentials],
    );
  });
});

test("le credenziali Aruba collegate restano compatte e modificabili in sicurezza", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto("/login");
  await page.getByLabel("Nome utente").fill("Massimo");
  await page.getByLabel("Password").fill("password-massimo");
  await page.getByRole("button", { name: "Accedi" }).click();
  await page.waitForURL("/");
  await page.waitForLoadState("networkidle");
  const consoleProblems: string[] = [];
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) consoleProblems.push(message.text());
  });
  await page.getByRole("link", { name: "Impostazioni" }).click();
  await page.waitForURL(/\/impostazioni/);

  const section = page.locator("#aruba-api");
  const form = section.locator(".aruba-api-credentials-form");
  const edit = section.getByRole("button", { name: "Aggiorna credenziali" });
  await expect(form).toHaveCount(0);
  await expect(edit).toBeVisible();
  const controlActions = section.locator(".aruba-api-controls__actions .button");
  await expect(controlActions).toHaveCount(2);
  await expect(controlActions.nth(0)).toHaveText("Salva controlli API");
  await expect(controlActions.nth(1)).toHaveText("Sincronizza ora");
  const desktopButtons = await controlActions.evaluateAll((buttons) =>
    buttons.map((button) => {
      const bounds = button.getBoundingClientRect();
      return { height: bounds.height, top: bounds.top };
    }),
  );
  expect(Math.abs(desktopButtons[0]!.height - desktopButtons[1]!.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(desktopButtons[0]!.top - desktopButtons[1]!.top)).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileButtons = await controlActions.evaluateAll((buttons) =>
    buttons.map((button) => {
      const bounds = button.getBoundingClientRect();
      return { height: bounds.height, width: bounds.width };
    }),
  );
  expect(Math.abs(mobileButtons[0]!.height - mobileButtons[1]!.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(mobileButtons[0]!.width - mobileButtons[1]!.width)).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1280, height: 720 });

  await edit.click();
  const username = section.getByLabel("Nome utente del pannello Aruba");
  const password = section.getByLabel("Password del pannello Aruba");
  const taxId = section.getByLabel("P.IVA o codice fiscale dell’attività");
  await expect(username).toHaveValue("utente-pannello-sintetico");
  await expect(taxId).toHaveValue("00000000000");
  await expect(password).toHaveValue("");
  await expect(username).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(username).toHaveValue("utente-pannello-sintetico");
  await expect(taxId).toHaveValue("00000000000");
  await expect(password).toHaveValue("");
  expect(await section.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true,
  );

  await username.fill("modifica-da-annullare");
  await taxId.fill("11111111111");
  await section.getByRole("button", { name: "Annulla" }).click();
  await expect(form).toHaveCount(0);
  await edit.click();
  await expect(username).toHaveValue("utente-pannello-sintetico");
  await expect(taxId).toHaveValue("00000000000");
  await expect(password).toHaveValue("");
  expect(consoleProblems).toEqual([]);
  await page.close();
});
