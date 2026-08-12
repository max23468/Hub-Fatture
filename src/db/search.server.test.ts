import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runMigrations } from "./migrations.server.ts";
import { temporaryDatabase } from "./database-fixture.ts";

test(
  "la ricerca globale trova ordini, fatture e clienti senza interpretare i caratteri SQL",
  { timeout: 30_000 },
  async () => {
    const clean = await temporaryDatabase("global_search");
    try {
      await runMigrations({ connectionString: clean.connectionString });
      process.env.APP_ENV = "test";
      process.env.APP_BASE_URL = "http://localhost:8080";
      process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
      process.env.DATABASE_URL = clean.connectionString;

      const database = await import("./client.server.ts");
      const orders = await import("./orders.server.ts");
      const search = await import("./search.server.ts");
      const profile = JSON.parse(
        await readFile("tests/fixtures/fatturapa/profile.mock.json", "utf8"),
      );
      await database
        .getPool()
        .query(
          "INSERT INTO fiscal_profiles (version, status, profile_json) VALUES (1, 'MOCK', $1)",
          [profile],
        );
      const fixture = JSON.parse(
        await readFile("tests/fixtures/orders/normalized.mock.json", "utf8"),
      );
      await orders.importOrders(fixture, { id: 1, requestId: "test-global-search" });

      const orderResult = await search.searchGlobal("S-1001");
      assert.equal(orderResult.orders.length, 1);
      assert.equal(orderResult.orders[0]!.provider, "SHOPIFY");
      assert.match(orderResult.orders[0]!.href, /^\/ordini\/\d+$/);

      const customer = (
        await database.getPool().query(
          `SELECT customers.id, customers.display_name, customers.email,
              order_tax_identifiers.normalized_value AS tax_id
       FROM customers
       JOIN orders ON orders.customer_id = customers.id
       JOIN order_tax_identifiers ON order_tax_identifiers.order_id = orders.id
       WHERE customers.email IS NOT NULL
       ORDER BY customers.id LIMIT 1`,
        )
      ).rows[0];
      const byName = await search.searchGlobal(customer.display_name);
      assert.ok(byName.customers.some((item) => item.id === String(customer.id)));
      const byEmail = await search.searchGlobal(customer.email);
      assert.ok(byEmail.customers.some((item) => item.id === String(customer.id)));
      const byTaxId = await search.searchGlobal(customer.tax_id);
      assert.ok(byTaxId.customers.some((item) => item.id === String(customer.id)));

      const caseRow = (
        await database.getPool().query(
          `SELECT billing_cases.id, billing_cases.public_number, billing_cases.customer_id,
              billing_cases.customer_snapshot_json
       FROM billing_cases ORDER BY billing_cases.id LIMIT 1`,
        )
      ).rows[0];
      await database.getPool().query(
        `INSERT INTO documents
        (billing_case_id, kind, status, document_type, series, document_date,
         fiscal_profile_version, currency, total_amount, source_total_amount,
         difference_amount, draft_version, projection_sha256, payment_status,
         payment_method, recipient_snapshot_json, origin)
       SELECT $1, 'INVOICE', 'DRAFT', 'TD01', 'FPR', CURRENT_DATE,
              fiscal_profiles.version, 'EUR', 1000, 1000, 0, 1, repeat('0', 64),
              'PAID', 'MP08', $2, 'HUB'
       FROM fiscal_profiles LIMIT 1`,
        [caseRow.id, caseRow.customer_snapshot_json],
      );
      const byPreparation = await search.searchGlobal(caseRow.public_number);
      assert.equal(byPreparation.documents.length, 1);
      assert.equal(byPreparation.documents[0]!.caseNumber, caseRow.public_number);

      const storage = await database.getPool().query<{ id: string }>(
        `INSERT INTO storage_objects
           (kind, relative_path, sha256, size_bytes, content_type)
         VALUES ('INVOICE_XML', 'global-search.xml', $1, 1, 'application/xml')
         RETURNING id`,
        ["1".repeat(64)],
      );
      await database.getPool().query(
        `UPDATE documents
         SET status = 'APPROVED', fiscal_year = 2026, fiscal_number = 1,
             approved_at = now(), xml_sha256 = $2, immutable_snapshot_json = $3,
             fiscal_profile_snapshot_json = $4, storage_object_id = $5
         WHERE billing_case_id = $1`,
        [caseRow.id, "2".repeat(64), caseRow.customer_snapshot_json, profile, storage.rows[0]!.id],
      );
      const byFiscalNumber = await search.searchGlobal("FPR 0001/26");
      assert.equal(byFiscalNumber.documents.length, 1);
      assert.equal(byFiscalNumber.documents[0]!.fiscalLabel, "FPR 0001/26");

      const detail = await search.getCustomer(String(caseRow.customer_id));
      assert.equal(detail?.id, String(caseRow.customer_id));
      assert.ok(detail?.orders.length);
      assert.equal(Number(detail?.order_count), detail?.orders.length);
      assert.equal(detail?.documents.length, 1);
      assert.equal(detail?.document_count, "1");
      assert.equal(detail?.documents[0]!.fiscalLabel, "FPR 0001/26");

      assert.deepEqual(await search.searchGlobal("%_"), search.emptyGlobalSearch("%_"));
      assert.deepEqual(await search.searchGlobal("a"), search.emptyGlobalSearch("a"));
      assert.equal(await search.getCustomer("non-valido"), null);
    } finally {
      const database = await import("./client.server.ts");
      await database.closePool();
      await clean.drop();
    }
  },
);
