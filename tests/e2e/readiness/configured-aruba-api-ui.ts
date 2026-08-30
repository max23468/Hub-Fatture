import { expect, type Locator, type Page } from "@playwright/test";
import pg from "pg";

import { encryptCredential } from "../../../src/crypto.server.ts";
import { credentialsEncryptionKey, databaseUrl } from "./support.ts";

export async function verifyConfiguredArubaApiUi(
  page: Page,
  arubaApiSettings: Locator,
  credentialForm: Locator,
) {
  const arubaApiUiClient = new pg.Client({ connectionString: databaseUrl });
  await arubaApiUiClient.connect();
  const encryptedArubaCredentials = encryptCredential(
    {
      apiEnvironment: "DEMO",
      username: "utente-pannello-sintetico",
      password: "password-pannello-sintetica",
      expectedTaxId: "00000000000",
    },
    credentialsEncryptionKey,
  );
  await arubaApiUiClient.query(
    `INSERT INTO connections
       (provider, environment, account_reference, encrypted_credentials, status,
        api_paused, inbound_enabled, automatic_authority, last_checked_at,
        credentials_verified_at)
     VALUES ('ARUBA', 'DEVELOPMENT', 'synthetic-aruba-layout', $1,
       'PAUSED', true, false, 'API', now(), now())
     ON CONFLICT (provider, environment) DO UPDATE SET
       account_reference = EXCLUDED.account_reference,
       encrypted_credentials = EXCLUDED.encrypted_credentials,
       status = EXCLUDED.status,
       api_paused = EXCLUDED.api_paused,
       inbound_enabled = EXCLUDED.inbound_enabled,
       automatic_authority = EXCLUDED.automatic_authority,
       last_checked_at = EXCLUDED.last_checked_at,
       credentials_verified_at = EXCLUDED.credentials_verified_at`,
    [encryptedArubaCredentials],
  );
  await arubaApiUiClient.query(
    `INSERT INTO aruba_sync_runs
      (id, environment, api_environment, account_reference, kind, authority_mode, status,
       window_start, window_end, checkpoint_start, checkpoint_end, checkpoint_page,
       page_count, request_count, lease_expires_at, started_at)
     VALUES ('30000000-0000-4000-8000-000000000001', 'MOCK', 'DEMO',
       'synthetic-aruba-layout', 'BACKFILL', 'CANONICAL', 'RUNNING',
       now() - interval '10 days', now(), now() - interval '6 days',
       now() - interval '4 days', 2, 12, 36, now() + interval '3 minutes',
       now() - interval '1 hour')`,
  );
  await page.reload();
  await expect(
    arubaApiSettings.getByRole("progressbar", {
      name: "Avanzamento del backfill Aruba",
    }),
  ).toHaveAttribute("value", "40");
  await expect(arubaApiSettings).toContainText("Backfill in corso · 40%");
  await expect(arubaApiSettings).toContainText("finestre da 48 ore rimanenti");
  await expect(credentialForm).toHaveCount(0);
  const editCredentials = arubaApiSettings.getByRole("button", {
    name: "Aggiorna credenziali",
  });
  await expect(editCredentials).toBeVisible();
  await expect(arubaApiSettings).toContainText(
    "Apri il modulo soltanto se devi cambiare i dati di accesso",
  );
  await editCredentials.click();
  await expect(credentialForm).toBeVisible();
  await expect(arubaApiSettings.getByLabel("Nome utente del pannello Aruba")).toHaveValue(
    "utente-pannello-sintetico",
  );
  await expect(arubaApiSettings.getByLabel("P.IVA o codice fiscale dell’attività")).toHaveValue(
    "00000000000",
  );
  await expect(arubaApiSettings.getByLabel("Password del pannello Aruba")).toHaveValue("");
  await expect(arubaApiSettings.getByLabel("Nome utente del pannello Aruba")).toBeFocused();
  const configuredControls = arubaApiSettings.locator(".aruba-api-controls");
  const revokeControls = arubaApiSettings.locator(".aruba-api-revoke");
  await expect(configuredControls).toBeVisible();
  await expect(revokeControls).toBeVisible();
  const configuredControlLayout = await arubaApiSettings.evaluate((section) => {
    const checkboxes = Array.from(
      section.querySelectorAll<HTMLInputElement>("input[type='checkbox']"),
      (checkbox) => checkbox.getBoundingClientRect(),
    );
    const buttons = Array.from(
      section.querySelectorAll<HTMLElement>(
        ".aruba-api-controls .button, .aruba-api-revoke .button",
      ),
      (button) => button.getBoundingClientRect(),
    );
    return {
      checkboxSizes: checkboxes.map(({ width, height }) => ({
        width,
        height,
      })),
      buttonSizes: buttons.map(({ width, height }) => ({ width, height })),
      controlsHeight:
        section.querySelector<HTMLElement>(".aruba-api-controls")?.getBoundingClientRect().height ??
        0,
      revokeHeight:
        section.querySelector<HTMLElement>(".aruba-api-revoke")?.getBoundingClientRect().height ??
        0,
    };
  });
  expect(configuredControlLayout.checkboxSizes).toHaveLength(3);
  for (const checkbox of configuredControlLayout.checkboxSizes) {
    expect(checkbox.width).toBeLessThanOrEqual(20);
    expect(checkbox.height).toBeLessThanOrEqual(20);
  }
  for (const button of configuredControlLayout.buttonSizes) {
    expect(button.width).toBeLessThan(260);
    expect(button.height).toBeLessThanOrEqual(46);
  }
  expect(configuredControlLayout.controlsHeight).toBeLessThan(112);
  expect(configuredControlLayout.revokeHeight).toBeLessThan(96);
  await page.getByLabel("Modalità Aruba").selectOption("AUTOMATIC_AFTER_APPROVAL");
  const settingsResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().includes("/impostazioni"),
  );
  await page.getByRole("button", { name: "Salva integrazione Aruba" }).click();
  expect((await settingsResponse).status()).toBeLessThan(400);
  await expect(page).toHaveURL(/aruba=salvata/);
  await expect(page.getByRole("status")).toContainText("Impostazioni Aruba aggiornate");
  await expect(page.getByLabel("Modalità Aruba")).toHaveValue("AUTOMATIC_AFTER_APPROVAL");
  await expect(page.getByRole("region", { name: "Trasmissioni Aruba del mese" })).toContainText(
    "0 documenti accettati",
  );
  await expect(page.getByText(/le approvazioni creano soltanto il documento/)).toBeVisible();
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  const arubaConnection = page.locator(".connection").filter({ hasText: "Aruba" });
  await expect(arubaConnection).toContainText("Sincronizzazione in pausa");
  await expect(arubaConnection).not.toContainText("Da aggiornare");
  await arubaApiUiClient.query(
    `UPDATE connections SET account_reference = 'synthetic-aruba-account',
       status = 'CONNECTED', api_paused = false, inbound_enabled = true
     WHERE provider = 'ARUBA' AND environment = 'DEVELOPMENT'`,
  );
  await arubaApiUiClient.query(
    `INSERT INTO aruba_sync_runs
       (id, environment, api_environment, account_reference, kind, authority_mode, status,
        window_start, window_end, checkpoint_start, checkpoint_end, checkpoint_page,
        lease_expires_at, started_at, completed_at, full_scan_completed_at)
     VALUES ('30000000-0000-4000-8000-000000000002', 'MOCK', 'DEMO',
       'synthetic-aruba-account', 'FULL', 'CANONICAL', 'COMPLETED', now() - interval '1 day',
       now(), now() - interval '1 day', now(), 1, now(), now() - interval '1 minute',
       now(), now())`,
  );
  await page.reload();
  await expect(arubaConnection).toContainText("Collegato");
  await expect(arubaConnection).not.toContainText("Da aggiornare");
  await page.getByRole("link", { name: "Documenti", exact: true }).click();
  await expect(page.getByRole("button", { name: "Prepara nuovo tentativo" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Genera codice di avvio" })).toHaveCount(0);
}
