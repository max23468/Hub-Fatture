import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

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
       VALUES ('Massimo', $1, true), ('Codex', $2, true)`,
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
          credentials_verified_at, account_info_json, account_info_checked_at)
       VALUES ('ARUBA', 'DEVELOPMENT', 'synthetic-aruba-layout', $1,
         'CONNECTED', false, true, 'API', now(), now(),
         jsonb_build_object(
           'username', 'impresa-sintetica',
           'pec', 'impresa-sintetica@pec.example.invalid',
           'userDescription', 'Impresa Sintetica S.r.l.',
           'countryCode', 'IT',
           'vatCode', '00000000000',
           'fiscalCode', '00000000000',
           'accountStatus', jsonb_build_object('expired', false, 'expirationDate', '2032-09-03'),
           'usageStatus', jsonb_build_object('usedSpaceKB', 256, 'maxSpaceKB', 1024)),
         now())`,
      [encryptedCredentials],
    );
    const profile = JSON.parse(
      await readFile("tests/fixtures/fatturapa/profile.mock.json", "utf8"),
    );
    await client.query(
      `INSERT INTO fiscal_profiles (version, status, profile_json)
       VALUES (1, 'MOCK', $1)`,
      [profile],
    );
    const monitoredDocument = await client.query<{ id: string }>(
      `WITH customer AS (
         INSERT INTO customers
           (kind, match_key, display_name, billing_address_json, source_confidence, review_required)
         VALUES ('PRIVATE_IT', 'aruba-ui-monitoring', 'Cliente monitoraggio Aruba', '{}',
                 'TAX_ID', false)
         RETURNING id
       ), billing_case AS (
         INSERT INTO billing_cases
           (customer_id, local_order_date, currency, status, customer_snapshot_json)
         SELECT id, '2026-09-01', 'EUR', 'APPROVED',
                jsonb_build_object('displayName', 'Cliente monitoraggio Aruba')
         FROM customer
         RETURNING id
       ), storage AS (
         INSERT INTO storage_objects
           (kind, relative_path, sha256, size_bytes, content_type)
         VALUES ('INVOICE_XML', 'e2e/aruba-monitoring.xml', repeat('a', 64), 100,
                 'application/xml')
         RETURNING id
       )
       INSERT INTO documents
         (billing_case_id, kind, status, document_type, series, fiscal_year, fiscal_number,
          document_date, fiscal_profile_version, currency, total_amount, source_total_amount,
          difference_amount, projection_sha256, approved_at, xml_sha256,
          immutable_snapshot_json, fiscal_profile_snapshot_json, storage_object_id)
       SELECT billing_case.id, 'INVOICE', 'APPROVED', 'TD01', 'FPR', 2026, 42,
              '2026-09-01', 1, 'EUR', 12500, 12500, 0, repeat('b', 64), now(),
              repeat('a', 64), '{}', $1, storage.id
       FROM billing_case, storage
       RETURNING id`,
      [profile],
    );
    const documentId = monitoredDocument.rows[0]!.id;
    await client.query(
      `INSERT INTO aruba_batches
         (id, environment, mode, account_reference, manifest_sha256, document_count,
          status, requires_reconciliation, created_by)
       VALUES ('50000000-0000-4000-8000-000000000001', 'MOCK', 'DOCUMENT_ONLY',
               'synthetic-aruba-layout', repeat('c', 64), 1, 'SUBMITTED', false, 1)`,
    );
    await client.query(
      `INSERT INTO aruba_batch_documents
         (batch_id, document_id, position, document_revision, xml_sha256, filename)
       VALUES ('50000000-0000-4000-8000-000000000001', $1, 1, 1, repeat('a', 64),
               'IT00000000000_UI.xml')`,
      [documentId],
    );
    const submission = await client.query<{ id: string }>(
      `INSERT INTO aruba_submissions
         (batch_id, document_id, attempt_number, environment, mode, manifest_sha256,
          xml_sha256, status, transport, source_filename, provider_filename, provider_sdi_id,
          accepted_at, submitted_at, remote_status_changed_at, last_checked_at)
       VALUES ('50000000-0000-4000-8000-000000000001', $1, 1, 'MOCK', 'DOCUMENT_ONLY',
               repeat('c', 64), repeat('a', 64), 'SDI_PROCESSING', 'API',
               'IT00000000000_UI.xml', 'IT00000000000_UI.xml', 'SDI-UI-42',
               now() - interval '4 minutes', now() - interval '3 minutes',
               now() - interval '1 minute', now())
       RETURNING id`,
      [documentId],
    );
    const notificationStorage = await client.query<{ id: string }>(
      `INSERT INTO storage_objects
         (kind, relative_path, sha256, size_bytes, content_type)
       VALUES ('SDI_NOTIFICATION', 'e2e/aruba-processing.xml', repeat('d', 64), 100,
               'application/xml')
       RETURNING id`,
    );
    await client.query(
      `INSERT INTO sdi_notifications
         (submission_id, remote_notification_id, type, status, received_at, storage_object_id)
       VALUES ($1, 'SDI-UI-NOTIFICATION', 'SDI_PROCESSING', 'SDI_PROCESSING',
               now() - interval '1 minute', $2)`,
      [submission.rows[0]!.id, notificationStorage.rows[0]!.id],
    );
  });
});

test("le credenziali Aruba collegate restano compatte e modificabili in sicurezza", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
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

  const section = page.locator("#aruba");
  const connection = page.locator("#aruba-api");
  const connectionManagement = connection.locator(".aruba-connection-management");
  const accountDetails = page.locator("#aruba-account .aruba-account-details");
  const synchronization = page.locator("#aruba-synchronization");
  const synchronizationDetails = synchronization.locator(".aruba-connection-details");
  const form = connection.locator(".aruba-api-credentials-form");
  const edit = connection.getByRole("button", { name: "Aggiorna credenziali" });
  await expect(form).toHaveCount(0);
  await expect(edit).toBeHidden();
  await connectionManagement.locator(":scope > summary").click();
  await expect(edit).toBeVisible();
  await expect(accountDetails.getByText("impresa-sintetica", { exact: true })).toBeHidden();
  await accountDetails.locator("summary").click();
  await expect(accountDetails.getByText("impresa-sintetica", { exact: true })).toBeVisible();
  await accountDetails.locator("summary").click();
  const saveControls = synchronization.getByRole("button", { name: "Salva controlli API" });
  const syncNow = synchronization.getByRole("button", { name: "Sincronizza ora" });
  await expect(syncNow).toBeVisible();
  await expect(saveControls).toBeHidden();
  await expect(synchronization.locator(".aruba-api-facts")).toBeHidden();
  await synchronizationDetails.locator("summary").click();
  await expect(saveControls).toBeVisible();
  const desktopButtons = await synchronization
    .locator(".aruba-api-controls__actions .button, .aruba-api-sync-action .button")
    .evaluateAll((buttons) =>
      buttons.map((button) => {
        const bounds = button.getBoundingClientRect();
        return { height: bounds.height };
      }),
    );
  expect(Math.abs(desktopButtons[0]!.height - desktopButtons[1]!.height)).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileButtons = await synchronization
    .locator(".aruba-api-controls__actions .button, .aruba-api-sync-action .button")
    .evaluateAll((buttons) =>
      buttons.map((button) => {
        const bounds = button.getBoundingClientRect();
        return { height: bounds.height, width: bounds.width };
      }),
    );
  expect(Math.abs(mobileButtons[0]!.height - mobileButtons[1]!.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(mobileButtons[0]!.width - mobileButtons[1]!.width)).toBeLessThanOrEqual(1);
  await synchronizationDetails.locator("summary").click();
  await page.setViewportSize({ width: 1280, height: 720 });

  await edit.click();
  const username = connection.getByLabel("Nome utente del pannello Aruba");
  const password = connection.getByLabel("Password del pannello Aruba");
  const taxId = connection.getByLabel("P.IVA o codice fiscale dell’attività");
  await expect(username).toHaveValue("utente-pannello-sintetico");
  await expect(taxId).toHaveValue("00000000000");
  await expect(password).toHaveValue("");
  await expect(username).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(username).toHaveValue("utente-pannello-sintetico");
  await expect(taxId).toHaveValue("00000000000");
  await expect(password).toHaveValue("");
  const mobileOverflow = await section.evaluate((element) =>
    Array.from(element.querySelectorAll<HTMLElement>("*"))
      .filter((node) => node.scrollWidth > node.clientWidth + 1)
      .map((node) => ({
        className: node.className,
        clientWidth: node.clientWidth,
        scrollWidth: node.scrollWidth,
        tagName: node.tagName,
      })),
  );
  expect(mobileOverflow).toEqual([]);

  await username.fill("modifica-da-annullare");
  await taxId.fill("11111111111");
  await connection.getByRole("button", { name: "Annulla" }).click();
  await expect(form).toHaveCount(0);
  await edit.click();
  await expect(username).toHaveValue("utente-pannello-sintetico");
  await expect(taxId).toHaveValue("00000000000");
  await expect(password).toHaveValue("");
  expect(consoleProblems).toEqual([]);

  await connection.getByRole("button", { name: "Annulla" }).click();
  await connectionManagement.locator(":scope > summary").click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Comprimi navigazione" }).click();
  await expect(connection.locator(".aruba-connection-facts")).toHaveCount(0);
  await expect(connection.getByText("Ambiente Aruba", { exact: true })).toBeVisible();
  await expect(section.locator("#aruba-service, #aruba-recovery")).toHaveCount(0);
  await expect(synchronizationDetails).not.toHaveAttribute("open", "");
  const viewports = [
    { width: 1440, height: 1000 },
    { width: 1024, height: 900 },
    { width: 768, height: 900 },
    { width: 390, height: 844 },
  ];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.mouse.move(viewport.width - 10, 10);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(section.locator(".aruba-section-card")).toHaveCount(3);
    const layout = await section.evaluate((element) => ({
      clientWidth: element.clientWidth,
      fits: element.scrollWidth <= element.clientWidth,
      scrollWidth: element.scrollWidth,
      cardFits: Array.from(element.querySelectorAll<HTMLElement>(".aruba-section-card")).every(
        (card) => card.scrollWidth <= card.clientWidth,
      ),
      cardOverflowing: Array.from(element.querySelectorAll<HTMLElement>(".aruba-section-card"))
        .filter((card) => card.scrollWidth > card.clientWidth)
        .map((card) => ({
          clientWidth: card.clientWidth,
          id: card.id,
          scrollWidth: card.scrollWidth,
        })),
      buttonHeights: Array.from(element.querySelectorAll<HTMLElement>("button"))
        .filter((button) => button.getClientRects().length > 0)
        .map((button) => button.getBoundingClientRect().height),
      overflowing: Array.from(element.querySelectorAll<HTMLElement>("*"))
        .filter((node) => node.scrollWidth > node.clientWidth + 1)
        .map((node) => ({
          className: node.className,
          clientWidth: node.clientWidth,
          scrollWidth: node.scrollWidth,
          tagName: node.tagName,
        })),
      protruding: Array.from(element.querySelectorAll<HTMLElement>("*"))
        .filter(
          (node) => node.getBoundingClientRect().right > element.getBoundingClientRect().right + 1,
        )
        .map((node) => ({
          className: node.className,
          right: node.getBoundingClientRect().right,
          tagName: node.tagName,
        })),
    }));
    expect(layout.fits, JSON.stringify({ viewport, ...layout })).toBe(true);
    expect(layout.cardFits, JSON.stringify({ viewport, ...layout })).toBe(true);
    expect(layout.overflowing, JSON.stringify({ viewport, ...layout })).toEqual([]);
    expect(layout.buttonHeights.every((height) => height >= 44)).toBe(true);
    await section.screenshot({
      path: `/tmp/hub-fatture-phase-f-settings-${viewport.width}.png`,
    });
  }

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/documenti?vista=inventario-aruba");
  await page.evaluate(() => window.scrollTo({ left: 0, top: 0 }));
  await page.mouse.move(1430, 10);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const advancedSearch = page.locator(".remote-advanced-search");
  await expect(page.getByRole("heading", { name: "Verifica su Aruba" })).toBeVisible();
  await advancedSearch.locator("summary").click();
  await expect(advancedSearch.locator("fieldset")).toHaveCount(3);
  await expect(advancedSearch.getByRole("group", { name: "Intervallo Aruba" })).toBeVisible();
  expect(
    await page
      .locator(".remote-documents-panel")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await page.locator(".remote-documents-panel").screenshot({
    path: "/tmp/hub-fatture-phase-f-search-1440.png",
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo({ left: 0, top: 0 }));
  await page.mouse.move(380, 10);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  expect(
    await page
      .locator(".remote-documents-panel")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await page.locator(".remote-documents-panel").screenshot({
    path: "/tmp/hub-fatture-phase-f-search-390.png",
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/documenti");
  await page.mouse.move(1430, 10);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const arubaDetails = page.getByText("Stato e cronologia Aruba", { exact: true });
  await expect(arubaDetails).toBeVisible();
  await arubaDetails.click();
  await expect(page.getByRole("heading", { name: "In lavorazione SdI" })).toBeVisible();
  await expect(page.getByText("IT00000000000_UI.xml", { exact: true })).toBeVisible();
  await expect(page.getByText("SDI-UI-42", { exact: true })).toBeVisible();
  await expect(page.locator(".document-aruba-timeline li")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Aggiorna stato Aruba" })).toBeVisible();
  await page.locator(".document-row__tools").screenshot({
    path: "/tmp/hub-fatture-phase-f-timeline-1440.png",
  });
  await page.close();
});
