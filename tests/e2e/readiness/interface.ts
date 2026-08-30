import { expect, test } from "@playwright/test";
import assert from "node:assert/strict";
import pg from "pg";

import { databaseUrl, expectViewportFits } from "./support.ts";

test("il menu mobile anima e rende raggiungibili tutte le sezioni", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto("/setup");
  const setupHeading = page.getByRole("heading", {
    name: "Configura gli accessi",
  });
  if (await setupHeading.isVisible()) {
    await page.getByLabel("Codice di configurazione").fill("synthetic-bootstrap-token-for-tests");
    await page.getByLabel("Password per Massimo").fill("password-massimo");
    await page.getByLabel("Password per Codex").fill("password-codex");
    await page.getByRole("button", { name: "Crea gli account" }).click();
  }

  await page.goto("/login");
  await page.getByLabel("Nome utente").fill("Massimo");
  await page.getByLabel("Password").fill("password-massimo");
  await page.getByRole("button", { name: "Accedi" }).click();

  const trigger = page.getByRole("button", {
    name: "Apri il menu di navigazione",
  });
  const menu = page.getByRole("dialog", { name: "Navigazione principale" });
  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("link")).toHaveCount(6);
  await expect(menu.getByRole("link", { name: "Dashboard", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(
    await menu.evaluate((element) =>
      getComputedStyle(element)
        .transitionDuration.split(",")
        .some((duration) => Number.parseFloat(duration) > 0),
    ),
  ).toBe(true);
  await expectViewportFits(page);

  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await menu.getByRole("link", { name: "Attività", exact: true }).click();
  await expect(page).toHaveURL(/\/attivita$/);
  await expect(menu).not.toBeVisible();
});

test("la qualifica Production richiede un consenso esplicito prima del dry run", async ({
  page,
}) => {
  const database = await import("../../../src/db/client.server.ts");
  const batch = (
    await database.getPool().query<{
      environment: string;
      id: string;
      status: string;
    }>(
      `SELECT id, environment, status
       FROM aruba_batches
       WHERE mode = 'DOCUMENT_ONLY' AND transport = 'API' AND document_count = 1
       ORDER BY created_at DESC LIMIT 1`,
    )
  ).rows[0]!;

  await database
    .getPool()
    .query(
      "UPDATE aruba_batches SET environment = 'PRODUCTION', status = 'DOCUMENT_ONLY' WHERE id = $1",
      [batch.id],
    );

  try {
    await page.goto("/login");
    await page.getByLabel("Nome utente").fill("Massimo");
    await page.getByLabel("Password").fill("password-massimo");
    await page.getByRole("button", { name: "Accedi" }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.goto("/documenti");

    const dryRunConfirmation = page.getByRole("checkbox", {
      name: /Confermo una sola chiamata Aruba con dryRun=true/,
    });
    const dryRunAuthorization = page.getByRole("button", {
      name: "Autorizza una verifica Production",
    });
    await expect(dryRunConfirmation).toBeVisible();
    await expect(dryRunConfirmation).toBeEnabled();
    await expect(dryRunConfirmation).toHaveAttribute("aria-checked", "false");
    await expect(dryRunAuthorization).toBeVisible();
    await expect(dryRunAuthorization).toBeDisabled();

    await dryRunConfirmation.press("Space");

    await expect(dryRunConfirmation).toHaveAttribute("aria-checked", "true");
    await expect(dryRunAuthorization).toBeEnabled();
    await expect(page.locator('input[name="confirmDryRunQualification"]')).toHaveValue("yes");
  } finally {
    await database
      .getPool()
      .query("UPDATE aruba_batches SET environment = $2, status = $3 WHERE id = $1", [
        batch.id,
        batch.environment,
        batch.status,
      ]);
  }
});

test("titoli e metadati identificano le pagine senza renderle indicizzabili", async ({ page }) => {
  await page.goto("/login");
  await expect(page).toHaveTitle("Accedi · Hub Fatture");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    "content",
    "noindex, nofollow, noarchive, nosnippet, noimageindex",
  );
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    "content",
    "Accedi · Hub Fatture",
  );
  await expect(page.locator('meta[name="theme-color"]')).toHaveCount(2);

  await page.getByLabel("Nome utente").fill("mAsSiMo");
  await page.getByLabel("Password").fill("password-massimo");
  await page.getByRole("button", { name: "Accedi" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();

  const pages = [
    ["/", "Dashboard · Hub Fatture"],
    ["/ordini", "Ordini · Hub Fatture"],
    ["/documenti", "Documenti · Hub Fatture"],
    ["/clienti", "Clienti · Hub Fatture"],
    ["/attivita", "Attività · Hub Fatture"],
    ["/impostazioni", "Impostazioni · Hub Fatture"],
  ] as const;

  for (const [path, title] of pages) {
    await page.goto(path);
    await expect(page).toHaveTitle(title);
    await expect(page.locator('meta[name="description"]')).toHaveCount(1);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      "noindex, nofollow, noarchive, nosnippet, noimageindex",
    );
  }

  await page.goto("/ordini/ordine-inesistente-di-esempio");
  await expect(page).toHaveTitle("La pagina non esiste · Hub Fatture");

  await page.goto("/pagina-inesistente-di-esempio");
  await expect(page).toHaveTitle("La pagina non esiste · Hub Fatture");
});

test("l’archivio Documenti resta leggibile con decine di elementi", async ({ page }) => {
  test.setTimeout(120_000);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const existing = Number(
    (await client.query<{ total: number }>("SELECT count(*)::integer AS total FROM documents"))
      .rows[0]!.total,
  );
  const hasUsers = Number(
    (await client.query<{ total: number }>("SELECT count(*)::integer AS total FROM users")).rows[0]!
      .total,
  );

  try {
    await client.query(
      `INSERT INTO customers
         (kind, match_key, display_name, billing_address_json,
          source_confidence, review_required)
       SELECT 'PRIVATE_IT', 'e2e-document-archive-' || series,
              CASE WHEN series = 55
                   THEN 'Laboratorio Artigianale Internazionale con una denominazione volutamente molto lunga'
                   ELSE 'Cliente archivio E2E ' || lpad(series::text, 2, '0') END,
              '{}', 'TAX_ID', false
       FROM generate_series(1, 55) AS series`,
    );
    await client.query(
      `INSERT INTO billing_cases
         (customer_id, local_order_date, currency, status, customer_snapshot_json)
       SELECT id, '2026-06-01'::date + row_number() OVER (ORDER BY id)::integer,
              'EUR', 'READY', jsonb_build_object('displayName', display_name)
       FROM customers
       WHERE match_key LIKE 'e2e-document-archive-%'`,
    );
    await client.query(
      `INSERT INTO documents
         (billing_case_id, kind, status, document_type, series, document_date,
          fiscal_profile_version, currency, total_amount, source_total_amount,
          difference_amount, projection_sha256)
       SELECT billing_cases.id, 'INVOICE', 'DRAFT', 'TD01', 'FPR',
              billing_cases.local_order_date, 1, 'EUR',
              100000 + 860 * row_number() OVER (ORDER BY billing_cases.id),
              100000 + 860 * row_number() OVER (ORDER BY billing_cases.id), 0, repeat('0', 64)
       FROM billing_cases
       JOIN customers ON customers.id = billing_cases.customer_id
       WHERE customers.match_key LIKE 'e2e-document-archive-%'`,
    );

    await page.setViewportSize({ width: 1440, height: 900 });
    if (!hasUsers) {
      await page.goto("/setup");
      await page.getByLabel("Codice di configurazione").fill("synthetic-bootstrap-token-for-tests");
      await page.getByLabel("Password per Massimo").fill("password-massimo");
      await page.getByLabel("Password per Codex").fill("password-codex");
      await page.getByRole("button", { name: "Crea gli account" }).click();
    } else {
      await page.goto("/login");
    }
    await page.getByLabel("Nome utente").fill("MASSIMO");
    await page.getByLabel("Password").fill("password-massimo");
    await page.getByRole("button", { name: "Accedi" }).click();
    await page.getByRole("link", { name: "Documenti", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Archivio documenti" })).toBeVisible();
    await expect(page.locator(".document-row")).toHaveCount(50);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    const actionMargins = await page.locator(".document-row").evaluateAll((rows) =>
      rows.map((row) => {
        const action = row.querySelector<HTMLElement>(".document-row__action");
        if (!action) return Number.POSITIVE_INFINITY;
        return row.getBoundingClientRect().right - action.getBoundingClientRect().right;
      }),
    );
    expect(Math.min(...actionMargins)).toBeGreaterThanOrEqual(12);
    const priceStateSpacing = await page.locator(".document-row").evaluateAll((rows) =>
      rows.map((row) => {
        const facts = row.querySelector<HTMLElement>(".document-row__facts");
        const amount = row.querySelector<HTMLElement>(
          ".document-row__facts > span:last-child strong",
        );
        const state = row.querySelector<HTMLElement>(".document-row__state");
        if (!facts || !amount || !state) return null;
        return {
          amountOverflow:
            amount.getBoundingClientRect().right - facts.getBoundingClientRect().right,
          visibleGap: state.getBoundingClientRect().left - amount.getBoundingClientRect().right,
        };
      }),
    );
    expect(priceStateSpacing).not.toContain(null);
    expect(
      Math.max(...priceStateSpacing.map((spacing) => spacing?.amountOverflow ?? Infinity)),
    ).toBeLessThanOrEqual(0.5);
    expect(
      Math.min(...priceStateSpacing.map((spacing) => spacing?.visibleGap ?? -Infinity)),
    ).toBeGreaterThanOrEqual(24);
    await page.locator(".document-row__action").first().focus();
    await expect(page.locator(".document-row__action").first()).toBeFocused();

    const filters = page.locator(".document-filters");
    await filters
      .getByLabel("Cerca")
      .fill("Laboratorio Artigianale Internazionale con una denominazione volutamente molto lunga");
    await filters.getByRole("button", { name: "Filtra" }).click();
    await expect(page.locator(".document-row")).toHaveCount(1);
    await expect(page.locator(".document-row__customer")).toContainText(
      "Laboratorio Artigianale Internazionale",
    );
    await page.getByRole("link", { name: "Azzera filtri" }).click();
    await expect(page.locator(".document-row")).toHaveCount(50);

    const expectedSecondPage = existing + 55 - 50;
    await page.getByRole("link", { name: "Pagina successiva" }).click();
    await expect(page.locator(".document-row")).toHaveCount(expectedSecondPage);

    await page.goto("/documenti?vista=da-trasmettere&trasmissione=RECONCILED");
    await expect(page.getByLabel("Stato trasmissione")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Da trasmettere" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/documenti");
    await expect(page.locator(".document-row")).toHaveCount(50);
    const intermediateContainment = await page.evaluate(async () => {
      document.querySelector<HTMLElement>(".document-row")?.scrollIntoView({ block: "center" });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const row = document.querySelector<HTMLElement>(".document-row");
      if (!row) return null;
      const panel = row.closest<HTMLElement>(".document-archive");
      const action = row.querySelector<HTMLElement>(".document-row__action");
      if (!panel || !action) return null;
      const grid = row.querySelector<HTMLElement>(".document-row__grid");
      return {
        actionRight: action.getBoundingClientRect().right,
        panelRight: panel.getBoundingClientRect().right,
        gridHeight: grid?.getBoundingClientRect().height ?? Number.POSITIVE_INFINITY,
        rowHeight: row.getBoundingClientRect().height,
      };
    });
    expect(intermediateContainment).not.toBeNull();
    expect(
      intermediateContainment!.panelRight - intermediateContainment!.actionRight,
    ).toBeGreaterThanOrEqual(12);
    expect(intermediateContainment!.gridHeight).toBeLessThan(190);
    expect(intermediateContainment!.rowHeight).toBeLessThan(240);

    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto("/documenti");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);

    await page.setViewportSize({ width: 320, height: 720 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    const mobileHeaderContainment = await page
      .locator(".document-archive > .document-panel-header")
      .evaluate((header) => {
        const count = header.querySelector<HTMLElement>(":scope > strong");
        if (!count) return null;
        return {
          countLeft: count.getBoundingClientRect().left,
          countRight: count.getBoundingClientRect().right,
          headerLeft: header.getBoundingClientRect().left,
          headerRight: header.getBoundingClientRect().right,
        };
      });
    expect(mobileHeaderContainment).not.toBeNull();
    expect(mobileHeaderContainment!.countLeft).toBeGreaterThanOrEqual(
      mobileHeaderContainment!.headerLeft,
    );
    expect(mobileHeaderContainment!.countRight).toBeLessThanOrEqual(
      mobileHeaderContainment!.headerRight,
    );
    await expect(page.locator(".document-row").first()).toBeVisible();
    expect(
      await page
        .locator(".document-row")
        .first()
        .evaluate((row) => row.getBoundingClientRect().height),
    ).toBeLessThan(380);

    await page.getByLabel("Apri il menu di Massimo").click();
    await page.getByRole("button", { name: "Scuro" }).click({ force: true });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator(".document-archive")).toBeVisible();
  } finally {
    await client.query(
      `DELETE FROM documents
       USING billing_cases, customers
       WHERE documents.billing_case_id = billing_cases.id
         AND billing_cases.customer_id = customers.id
         AND customers.match_key LIKE 'e2e-document-archive-%'`,
    );
    await client.query(
      `DELETE FROM billing_cases
       USING customers
       WHERE billing_cases.customer_id = customers.id
         AND customers.match_key LIKE 'e2e-document-archive-%'`,
    );
    await client.query("DELETE FROM customers WHERE match_key LIKE 'e2e-document-archive-%'");
    await client.end();
  }
});

async function verifyFailedSynchronizationKeepsConnection(page: import("@playwright/test").Page) {
  await page.goto("/setup");
  const setupHeading = page.getByRole("heading", { name: "Configura gli accessi" });
  if (await setupHeading.isVisible()) {
    await page.getByLabel("Codice di configurazione").fill("synthetic-bootstrap-token-for-tests");
    await page.getByLabel("Password per Massimo").fill("password-massimo");
    await page.getByLabel("Password per Codex").fill("password-codex");
    await page.getByRole("button", { name: "Crea gli account" }).click();
  }
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Nome utente").fill("MASSIMO");
  await page.getByLabel("Password").fill("password-massimo");
  await page.getByRole("button", { name: "Accedi" }).click();
  await expect(page).toHaveURL(/\/$/);

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const failed = await client.query(
    `INSERT INTO connections
       (provider, environment, account_reference, encrypted_credentials, status,
        last_synced_at, last_checked_at, last_error_code, last_error_message_sanitized)
     VALUES
       ('SHOPIFY', 'DEVELOPMENT', 'shopify-synthetic', 'encrypted-synthetic', 'ERROR',
        now(), now(), 'PROVIDER_RESPONSE_INVALID',
        'Il canale di vendita ha restituito dati non riconosciuti.')
     ON CONFLICT (provider, environment) DO UPDATE SET
       status = excluded.status,
       last_synced_at = excluded.last_synced_at,
       last_checked_at = excluded.last_checked_at,
       last_error_code = excluded.last_error_code,
       last_error_message_sanitized = excluded.last_error_message_sanitized,
       updated_at = now()`,
  );
  assert.equal(failed.rowCount, 1);

  try {
    await page.reload();

    const dashboardConnection = page.locator(".connection").filter({ hasText: "Shopify" });
    await expect(dashboardConnection).toContainText("Collegato · sincronizzazione non riuscita");
    await expect(dashboardConnection).not.toContainText("Non collegato");

    await page.goto("/impostazioni#connessioni");
    const settingsConnection = page.locator(".connection-panel").filter({ hasText: "Shopify" });
    await expect(settingsConnection.getByText("Collegato", { exact: true })).toBeVisible();
    await expect(settingsConnection).toContainText("Ultimo errore di sincronizzazione");
    await expect(settingsConnection).not.toContainText("Non collegato");
  } finally {
    await client.query(
      `UPDATE connections
       SET status = 'CONNECTED', last_error_code = NULL,
           last_error_message_sanitized = NULL, updated_at = now()
       WHERE provider = 'SHOPIFY' AND environment = 'DEVELOPMENT'`,
    );
    await client.end();
  }
}

test("la Dashboard distingue sincronizzazione fallita e collegamento revocato", async ({
  page,
}) => {
  await verifyFailedSynchronizationKeepsConnection(page);

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const revoked = await client.query(
    `UPDATE connections
     SET status = 'REVOKED', last_synced_at = now(), updated_at = now()
     WHERE provider = 'SHOPIFY' AND environment = 'DEVELOPMENT'`,
  );
  assert.equal(revoked.rowCount, 1);

  try {
    await page.goto("/");

    const shopifyConnection = page.locator(".connection").filter({ hasText: "Shopify" });
    await expect(shopifyConnection).toContainText("Non collegato");
    await expect(page.getByText("Aggiornamenti da completare", { exact: true })).toBeVisible();
    await expect(page.getByText("Tutto sotto controllo", { exact: true })).toHaveCount(0);
  } finally {
    await client.query(
      `UPDATE connections
       SET status = 'CONNECTED', updated_at = now()
       WHERE provider = 'SHOPIFY' AND environment = 'DEVELOPMENT'`,
    );
    await client.end();
  }
});
