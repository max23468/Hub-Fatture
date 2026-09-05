import { expect, type Locator, type Page } from "@playwright/test";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { withResetE2eDatabase } from "../database.ts";

export const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://hub_fatture:hub_fatture_test@127.0.0.1:5433/hub_fatture_test";
export const appBaseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4173";
export const storageRoot = path.resolve("storage/e2e-documents");
export const credentialsEncryptionKey = Buffer.alloc(32, 9).toString("base64url");

export async function refreshOperationalControlsProjection() {
  process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
  process.env.APP_BASE_URL = appBaseUrl;
  process.env.APP_ENV = "test";
  process.env.CREDENTIALS_ENCRYPTION_KEY = credentialsEncryptionKey;
  process.env.DATABASE_URL = databaseUrl;
  const [controls, database] = await Promise.all([
    import("../../../src/db/operational-controls.server.ts"),
    import("../../../src/db/client.server.ts"),
  ]);
  try {
    await controls.refreshOperationalControls();
  } finally {
    await database.closePool();
  }
}

export async function expectPlainLanguage(page: Page) {
  await expect(page.locator("body")).not.toContainText(
    /\b(?:trigger|fixture|sandbox)\b|sorgente|normalizzat/i,
  );
}

export async function expectViewportFits(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

export async function expectPreparationOrderReference(page: Page) {
  const reference = page
    .locator(".orders-table--preparations tbody tr")
    .first()
    .locator("td")
    .first()
    .locator("small");
  await expect(reference).toBeVisible();
  const values = (await reference.innerText()).split(" · ");
  expect(values.length).toBeGreaterThan(0);
  for (const value of values) {
    expect(value.endsWith(" Shopify") || value.endsWith(" eBay")).toBe(true);
  }
}

export async function expectDesktopContentOutsideSidebar(page: Page) {
  const shell = await page.evaluate(() => {
    const sidebar = document.querySelector<HTMLElement>(".sidebar")!.getBoundingClientRect();
    const main = document.querySelector<HTMLElement>(".app-main")!.getBoundingClientRect();
    const content = document.querySelector<HTMLElement>(".controls-page")!.getBoundingClientRect();
    return {
      contentLeft: content.left,
      mainLeft: main.left,
      scrollX: window.scrollX,
      sidebarRight: sidebar.right,
    };
  });
  expect(shell.scrollX).toBe(0);
  expect(shell.mainLeft).toBeCloseTo(shell.sidebarRight, 3);
  expect(shell.contentLeft).toBeGreaterThan(shell.sidebarRight);
}

export async function waitForUiMotionToSettle(locator: Locator) {
  await locator.evaluate(async (element) => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    await Promise.all(
      element.getAnimations({ subtree: true }).map(async (animation) => {
        try {
          await animation.finished;
        } catch {
          // Una transizione sostituita da un nuovo stato è già conclusa per la misura corrente.
        }
      }),
    );
  });
}

export async function expectVisibleFieldsetTitlesInside(page: Page) {
  const positions = await page
    .locator(
      ".preparation-disclosure fieldset:visible, .preparation-approval__form fieldset:visible",
    )
    .evaluateAll((fieldsets) =>
      // Il gruppo che disabilita la conferma usa display:contents e non disegna un riquadro.
      fieldsets
        .filter((fieldset) => getComputedStyle(fieldset).display !== "contents")
        .map((fieldset) => {
          const legend = fieldset.querySelector(":scope > legend");
          if (!(legend instanceof HTMLElement)) return null;
          const box = fieldset.getBoundingClientRect();
          const title = legend.getBoundingClientRect();
          return {
            label: legend.textContent?.trim() ?? "",
            inside:
              title.top >= box.top + 12 &&
              title.left >= box.left + 12 &&
              title.right <= box.right - 12 &&
              title.bottom < box.bottom,
            wrapped: legend.scrollWidth <= legend.clientWidth,
          };
        }),
    );
  expect(positions.length).toBeGreaterThan(0);
  for (const position of positions) {
    expect(position, "Ogni riquadro deve avere un titolo diretto").not.toBeNull();
    expect(position!.inside, `Il titolo “${position!.label}” deve restare dentro il box`).toBe(
      true,
    );
    expect(position!.wrapped, `Il titolo “${position!.label}” non deve fuoriuscire`).toBe(true);
  }
}

export async function expectApprovalLabelsReadable(page: Page) {
  const labels = await page
    .locator(".preparation-approval__form .facts dt:visible")
    .evaluateAll((terms) =>
      terms.map((term) => {
        const range = document.createRange();
        range.selectNodeContents(term);
        return {
          label: term.textContent?.trim() ?? "",
          lines: range.getClientRects().length,
        };
      }),
    );
  expect(labels.length).toBeGreaterThan(0);
  for (const label of labels) {
    expect(label.lines, `L’etichetta “${label.label}” deve restare su una riga`).toBe(1);
  }
}

export async function resetReadinessState() {
  await rm(storageRoot, { recursive: true, force: true });
  await withResetE2eDatabase(databaseUrl, async (client) => {
    const profile = JSON.parse(
      await readFile("tests/fixtures/fatturapa/profile.mock.json", "utf8"),
    );
    await client.query(
      "INSERT INTO fiscal_profiles (version, status, profile_json) VALUES (1, 'MOCK', $1)",
      [profile],
    );
    await client.query(
      `INSERT INTO settings (key, value_json) VALUES
         ('draft_trigger', '"PAID"'),
         ('aruba_mode', '"DOCUMENT_ONLY"'),
         ('shopify_payment_fee_mode', '"DEDUCT"'),
         ('customer_email_mode', '"AUTOMATIC"')
       ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, version = 1`,
    );
  });
}
