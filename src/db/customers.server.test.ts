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
      const actionableReviews = await customers.listActionableCustomerReviews();
      assert.deepEqual(
        actionableReviews.map((customer) => customer.display_name),
        ["Profilo da riconciliare"],
      );
      assert.equal(actionableReviews[0]!.target_type, "ORDER");
      assert.deepEqual(actionableReviews[0]!.missing_fields, [
        "Tipo cliente",
        "Via",
        "CAP",
        "Città",
        "Paese",
      ]);
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

      {
        // La preparazione aperta passa all'anagrafica con il codice fiscale già confermato.
        const alignment = await import("./order-automatic-alignment.server.ts");
        const snapshot = {
          displayName: "Mario Rossi",
          reviewRequired: false,
          taxIdentifiers: [{ type: "CODICE_FISCALE", value: "VRDLGU80A01H501X" }],
        };
        const setup = await database.getPool().query<{
          provisional_id: string;
          fiscal_id: string;
          case_id: string;
          other_case_id: string;
        }>(
          `WITH provisional AS (
           INSERT INTO customers
             (kind, match_key, display_name, billing_address_json, source_confidence,
              review_required)
           VALUES ('PRIVATE_IT', 'order:provisional', 'Mario Rossi', '{}', 'AMBIGUOUS', true),
                  ('PRIVATE_IT', 'order:other', 'Mario Rossi', '{}', 'AMBIGUOUS', true)
           RETURNING id, match_key
         ), fiscal AS (
           INSERT INTO customers
             (kind, match_key, display_name, billing_address_json, source_confidence,
              review_required, tax_id_type, tax_id_normalized)
           VALUES ('PRIVATE_IT', 'tax:CODICE_FISCALE::VRDLGU80A01H501X', 'Mario Rossi', '{}',
                   'TAX_ID', false, 'CODICE_FISCALE', 'VRDLGU80A01H501X')
           RETURNING id
         ), source_record AS (
           INSERT INTO customer_source_records
             (customer_id, provider, external_customer_id, raw_snapshot_json)
           SELECT fiscal.id, 'EBAY', 'buyer-ownership', '{}' FROM fiscal
         ), billing AS (
           INSERT INTO billing_cases
             (customer_id, local_order_date, currency, status, customer_snapshot_json,
              customer_corrected_at)
           SELECT provisional.id, '2026-08-08', 'EUR', 'READY', $1::jsonb,
                  CASE WHEN provisional.match_key = 'order:provisional' THEN now() END
           FROM provisional
           RETURNING id, customer_id
         ), inserted_orders AS (
           INSERT INTO orders
             (provider, external_account_id, external_order_id, display_number,
              created_at_source, updated_at_source, local_order_date, currency, gross_amount,
              payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
              raw_snapshot_json, normalized_snapshot_json)
           SELECT 'EBAY', 'ownership', 'order-' || billing.id, 'OWN-' || billing.id, now(),
                  now(), '2026-08-08', 'EUR', 3049, 'PAID', 'FULFILLED', 'GROUPED',
                  billing.customer_id, billing.id, '{}',
                  jsonb_build_object('externalCustomerId',
                    CASE WHEN provisional.match_key = 'order:provisional'
                      THEN 'buyer-ownership' ELSE 'buyer-without-fiscal-code' END)
           FROM billing JOIN provisional ON provisional.id = billing.customer_id
         )
         SELECT (SELECT id::text FROM provisional WHERE match_key = 'order:provisional')
                  AS provisional_id,
                (SELECT id::text FROM fiscal) AS fiscal_id,
                (SELECT billing.id::text FROM billing JOIN provisional
                   ON provisional.id = billing.customer_id
                 WHERE provisional.match_key = 'order:provisional') AS case_id,
                (SELECT billing.id::text FROM billing JOIN provisional
                   ON provisional.id = billing.customer_id
                 WHERE provisional.match_key = 'order:other') AS other_case_id`,
          [JSON.stringify(snapshot)],
        );
        const ids = setup.rows[0]!;

        const realigned = await database.withTransaction((client) =>
          alignment.realignOpenCaseCustomerOwnership(client, "customer-ownership-test"),
        );
        assert.equal(realigned, 1);
        assert.deepEqual(
          (
            await database.getPool().query(
              `SELECT billing_cases.customer_id::text AS case_customer,
                    orders.customer_id::text AS order_customer,
                    billing_cases.customer_snapshot_json AS snapshot,
                    billing_cases.customer_corrected_at IS NOT NULL AS corrected,
                    EXISTS (SELECT 1 FROM customers WHERE id = $2) AS provisional_exists,
                    EXISTS (SELECT 1 FROM audit_events
                      WHERE entity_id = billing_cases.id::text
                        AND action = 'CUSTOMER_CORRECTED'
                        AND metadata_json ->> 'automaticAlignment' = 'CUSTOMER_OWNERSHIP')
                      AS audited
             FROM billing_cases JOIN orders ON orders.billing_case_id = billing_cases.id
             WHERE billing_cases.id = $1`,
              [ids.case_id, ids.provisional_id],
            )
          ).rows[0],
          {
            case_customer: ids.fiscal_id,
            order_customer: ids.fiscal_id,
            snapshot,
            corrected: true,
            provisional_exists: false,
            audited: true,
          },
        );
        assert.notEqual(
          (
            await database
              .getPool()
              .query("SELECT customer_id::text FROM billing_cases WHERE id = $1", [
                ids.other_case_id,
              ])
          ).rows[0].customer_id,
          ids.fiscal_id,
        );
        assert.equal(
          await database.withTransaction((client) =>
            alignment.realignOpenCaseCustomerOwnership(client, "customer-ownership-repeat"),
          ),
          0,
        );
      }
      await database.closePool();
    } finally {
      const database = await import("./client.server.ts");
      await database.closePool();
      await clean.drop();
    }
  },
);
