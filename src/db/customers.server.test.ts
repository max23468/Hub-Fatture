import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PAGE_SIZE } from "../orders.ts";
import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

test(
  "la directory Clienti riconcilia, cerca e collega le anagrafiche",
  { timeout: 30_000 },
  async () => {
    const clean = await temporaryDatabase("customers");
    try {
      await runMigrations({ connectionString: clean.connectionString });
      process.env.APP_ENV = "test";
      process.env.APP_BASE_URL = "http://localhost:8080";
      process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
      process.env.DATABASE_URL = clean.connectionString;

      const orders = await import("./order-import.server.ts");
      const customers = await import("./customers.server.ts");
      const database = await import("./client.server.ts");
      const fixture = JSON.parse(
        await readFile("tests/fixtures/orders/normalized.mock.json", "utf8"),
      );
      await orders.importOrders(fixture, {
        id: 1,
        requestId: "test-customer-directory",
      });

      assert.deepEqual(await customers.customerDirectorySummary(), {
        total: 2,
        needs_review: 0,
        shopify: 2,
        ebay: 1,
      });

      const directory = await customers.listCustomers({});
      assert.equal(directory.rows.length, 2);
      assert.equal(directory.rows[0].display_name, "Cliente da verificare");
      assert.equal(directory.rows[1].display_name, "Mario Rossi");
      assert.deepEqual(directory.rows[1].providers, ["EBAY", "SHOPIFY"]);
      assert.equal(directory.rows[1].order_count, 2);
      assert.equal(directory.rows[1].preparation_count, 1);

      assert.deepEqual(
        (
          await customers.listCustomers({
            sort: { key: "cliente", direction: "desc" },
          })
        ).rows.map((row) => row.display_name),
        ["Mario Rossi", "Cliente da verificare"],
      );
      assert.deepEqual(
        (
          await customers.listCustomers({
            sort: { key: "ordini", direction: "desc" },
          })
        ).rows.map((row) => row.display_name),
        ["Mario Rossi", "Cliente da verificare"],
      );

      assert.deepEqual((await customers.listCustomers({ needsReview: true })).rows, []);
      assert.deepEqual(
        (await customers.listCustomers({ query: "RSSMRA80A01H501U" })).rows.map(
          (row) => row.display_name,
        ),
        ["Mario Rossi"],
      );
      assert.deepEqual(
        (await customers.listCustomers({ query: "ebay-customer-1" })).rows.map(
          (row) => row.display_name,
        ),
        ["Mario Rossi"],
      );
      assert.deepEqual((await customers.listCustomers({ query: "%" })).rows, []);
      assert.deepEqual((await customers.listCustomers({ query: "non\0valido" })).rows, []);

      const marioId = directory.rows[1].id;
      const mario = await customers.getCustomer(marioId);
      assert.equal(mario?.display_name, "Mario Rossi");
      assert.equal(mario?.order_count, 2);
      assert.equal(mario?.preparation_count, 1);
      assert.equal(mario?.document_count, 0);
      assert.equal(mario?.orders.length, 2);
      assert.equal(mario?.preparations.length, 1);
      assert.deepEqual(
        mario?.sources.map((source) => source.provider),
        ["EBAY", "SHOPIFY"],
      );
      assert.equal(await customers.getCustomer("0"), null);
      assert.equal(await customers.getCustomer("9223372036854775808"), null);
      assert.equal(await customers.getCustomer(undefined), null);

      const inserted = await database.getPool().query<{
        id: string;
        match_key: string;
      }>(
        `INSERT INTO customers
          (kind, match_key, display_name, billing_address_json,
           source_confidence, review_required)
         VALUES
          ('PRIVATE_IT', 'review-orphan', 'Profilo senza collegamenti', '{}', 'AMBIGUOUS', true),
          ('PRIVATE_IT', 'review-closed', 'Profilo storico chiuso', '{}', 'AMBIGUOUS', true),
          ('PRIVATE_IT', 'review-actionable', 'Profilo da riconciliare', '{}', 'AMBIGUOUS', true)
         RETURNING id, match_key`,
      );
      const ids = Object.fromEntries(inserted.rows.map((row) => [row.match_key, row.id]));
      await database.getPool().query(
        `WITH closed_case AS (
           INSERT INTO billing_cases
             (customer_id, local_order_date, currency, status, customer_snapshot_json,
              do_not_transmit_reason)
           VALUES ($1, current_date, 'EUR', 'DO_NOT_TRANSMIT',
                   '{"displayName":"Profilo storico chiuso","reviewRequired":true}',
                   'Documento storico già presente')
           RETURNING id
         )
         INSERT INTO orders
          (provider, external_account_id, external_order_id, display_number,
           created_at_source, updated_at_source, local_order_date, currency, gross_amount,
           payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
           raw_snapshot_json, normalized_snapshot_json)
         VALUES
          ('SHOPIFY', 'review-test', 'closed', '#CLOSED', now(), now(), current_date, 'EUR', 100,
           'PAID', 'FULFILLED', 'LEGACY_BILLING_REVIEW', $1,
           (SELECT id FROM closed_case), '{}', '{"customerReviewRequired":true}'),
          ('SHOPIFY', 'review-test', 'actionable', '#ACTIONABLE', now(), now(), current_date,
           'EUR', 100, 'PAID', 'FULFILLED', 'LEGACY_BILLING_REVIEW', $2, NULL, '{}',
           '{"customerReviewRequired":true}')`,
        [ids["review-closed"], ids["review-actionable"]],
      );
      assert.equal((await customers.customerDirectorySummary()).needs_review, 1);
      assert.deepEqual(
        (await customers.listCustomers({ needsReview: true })).rows.map(
          (customer) => customer.display_name,
        ),
        ["Profilo da riconciliare"],
      );
      assert.equal((await customers.getCustomer(ids["review-closed"]))?.review_required, false);
      assert.equal((await customers.getCustomer(ids["review-actionable"]))?.review_required, true);
      await database
        .getPool()
        .query("DELETE FROM orders WHERE external_account_id = 'review-test'");
      await database
        .getPool()
        .query("DELETE FROM billing_cases WHERE customer_id = $1", [ids["review-closed"]]);
      await database.getPool().query("DELETE FROM customers WHERE match_key LIKE 'review-%'");

      const candidate = structuredClone(fixture[0]);
      candidate.externalOrderId = "customer-identity-cleanup";
      candidate.externalCustomerId = "customer-identity-cleanup";
      candidate.paymentStatus = "PENDING";
      candidate.payments = candidate.payments.map((payment: Record<string, unknown>) => ({
        ...payment,
        status: "PENDING",
      }));
      candidate.customer.displayName = "Cliente Cambio Identità";
      candidate.customer.firstName = "Cliente";
      candidate.customer.lastName = "Cambio Identità";
      candidate.customer.email = "identity-cleanup@example.invalid";
      candidate.customer.taxIdentifiers = [];
      candidate.updatedAt = "2026-08-13T10:00:00Z";
      await orders.importOrders([candidate], {
        id: 1,
        requestId: "identity-before",
      });
      const previousCustomerId = String(
        (
          await database
            .getPool()
            .query("SELECT customer_id FROM orders WHERE external_order_id = $1", [
              candidate.externalOrderId,
            ])
        ).rows[0].customer_id,
      );
      candidate.customer.taxIdentifiers = [
        {
          type: "CODICE_FISCALE",
          value: "CLNMRA80A01H501X",
          sourceField: "synthetic-test",
        },
      ];
      candidate.updatedAt = "2026-08-13T11:00:00Z";
      await orders.importOrders([candidate], {
        id: 1,
        requestId: "identity-after",
      });
      const current = await database.getPool().query(
        `SELECT orders.customer_id,
                (SELECT count(*) FROM customers WHERE id = $2)::integer AS old_customer_count
         FROM orders WHERE external_order_id = $1`,
        [candidate.externalOrderId, previousCustomerId],
      );
      assert.notEqual(String(current.rows[0].customer_id), previousCustomerId);
      assert.equal(current.rows[0].old_customer_count, 0);

      await database.getPool().query(
        `INSERT INTO customers
         (kind, match_key, display_name, billing_address_json,
          source_confidence, review_required)
       SELECT 'UNKNOWN', 'test-page-' || value, 'Cliente pagina ' || value, '{}'::jsonb,
              'AMBIGUOUS', true
       FROM generate_series(1, $1::integer) AS value`,
        [PAGE_SIZE + 1],
      );
      const firstPage = await customers.listCustomers({});
      const secondPage = await customers.listCustomers({ page: 2 });
      assert.equal(firstPage.rows.length, PAGE_SIZE);
      assert.equal(firstPage.hasNext, true);
      assert.ok(secondPage.rows.length > 0);
      assert.equal(
        firstPage.rows.some((row) => secondPage.rows.some((other) => other.id === row.id)),
        false,
      );

      await database.closePool();
    } finally {
      const database = await import("./client.server.ts");
      await database.closePool();
      await clean.drop();
    }
  },
);
