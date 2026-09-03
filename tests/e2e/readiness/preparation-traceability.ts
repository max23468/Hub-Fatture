import { expect, test } from "@playwright/test";
import pg from "pg";

import {
  databaseUrl,
  expectViewportFits,
  resetReadinessState,
  waitForUiMotionToSettle,
} from "./support.ts";

test("una fattura riconciliata rimanda alla preparazione originaria", async ({ page }) => {
  await resetReadinessState();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/setup");
  await page.getByLabel("Codice di configurazione").fill("synthetic-bootstrap-token-for-tests");
  await page.getByLabel("Password per Massimo").fill("password-massimo");
  await page.getByLabel("Password per Codex").fill("password-codex");
  await page.getByRole("button", { name: "Crea gli account" }).click();
  await page.getByLabel("Nome utente").fill("Massimo");
  await page.getByLabel("Password").fill("password-massimo");
  await page.getByRole("button", { name: "Accedi" }).click();

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`
      WITH customer AS (
        INSERT INTO customers
          (kind, match_key, display_name, billing_address_json,
           source_confidence, review_required)
        VALUES ('PRIVATE_IT', 'e2e-traceability', 'Cliente dimostrativo', '{}',
                'TAX_ID', false)
        RETURNING id
      ), source_case AS (
        INSERT INTO billing_cases
          (customer_id, local_order_date, currency, status, customer_snapshot_json,
           fiscal_profile_version)
        SELECT id, '2026-08-20', 'EUR', 'CLOSED',
               '{"displayName":"Cliente dimostrativo","reviewRequired":false}', 1
        FROM customer RETURNING id, customer_id
      ), archive_case AS (
        INSERT INTO billing_cases
          (customer_id, local_order_date, currency, status, customer_snapshot_json,
           fiscal_profile_version)
        SELECT customer_id, '2026-08-21', 'EUR', 'CLOSED',
               '{"displayName":"Cliente dimostrativo","reviewRequired":false}', 1
        FROM source_case RETURNING id
      ), inserted_order AS (
        INSERT INTO orders
          (provider, external_account_id, external_order_id, display_number,
           created_at_source, updated_at_source, local_order_date, currency, gross_amount,
           payment_status, fulfillment_status, trigger_status, customer_id,
           raw_snapshot_json, normalized_snapshot_json)
        SELECT 'SHOPIFY', 'e2e-traceability', 'order', '#QA-4037', now(), now(),
               '2026-08-20', 'EUR', 19715, 'PAID', 'FULFILLED', 'INVOICED',
               customer_id, '{}', '{}'
        FROM source_case RETURNING id
      ), stored AS (
        INSERT INTO storage_objects
          (kind, relative_path, sha256, size_bytes, content_type)
        VALUES ('ARUBA_XML', 'e2e/traceability.xml', repeat('a', 64), 100,
                'application/xml')
        RETURNING id
      ), issued AS (
        INSERT INTO documents
          (billing_case_id, source_billing_case_id, kind, status, document_type, series,
           fiscal_year, fiscal_number, document_date, fiscal_profile_version, currency,
           total_amount, source_total_amount, difference_amount, projection_sha256,
           approved_at, xml_sha256, immutable_snapshot_json, fiscal_profile_snapshot_json,
           storage_object_id, payment_method, recipient_snapshot_json, origin)
        SELECT archive_case.id, source_case.id, 'INVOICE', 'APPROVED', 'TD01', 'FPR',
               2026, 1667, '2026-08-20', 1, 'EUR', 19715, 19715, 0, repeat('b', 64),
               now(), repeat('b', 64), '{}', '{}', stored.id, 'MP08',
               '{"displayName":"Cliente dimostrativo"}', 'ARUBA_HISTORY'
        FROM archive_case, source_case, stored RETURNING id
      )
      INSERT INTO document_orders (document_id, document_kind, order_id, amount)
      SELECT issued.id, 'INVOICE', inserted_order.id, 19715 FROM issued, inserted_order;
    `);
  } finally {
    await client.end();
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/documenti?vista=fatture&q=000001");
  await page.waitForLoadState("networkidle");
  await expect(page).toHaveTitle("Documenti · Hub Fatture");
  await expect(page.getByRole("link", { name: "Preparazione originaria 000001" })).toBeVisible();
  await expect(page.getByText("FPR 1667/26", { exact: true })).toBeVisible();
  pageErrors.length = 0;

  await page.getByRole("link", { name: "Preparazione originaria 000001" }).click();
  await expect(page).toHaveURL(/\/ordini\/preparazione\/1$/);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "Fatture collegate" })).toBeVisible();
  await expect(page.getByText("FPR 1667/26 · 197,15 €", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Shopify #QA-4037" })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  const linkedInvoices = page.getByRole("heading", { name: "Fatture collegate" });
  await expect(linkedInvoices).toBeVisible();
  await waitForUiMotionToSettle(linkedInvoices);
  await expectViewportFits(page);
  expect(pageErrors).toEqual([]);
});
