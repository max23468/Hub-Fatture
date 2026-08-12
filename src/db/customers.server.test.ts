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

      const orders = await import("./orders.server.ts");
      const customers = await import("./customers.server.ts");
      const database = await import("./client.server.ts");
      const fixture = JSON.parse(
        await readFile("tests/fixtures/orders/normalized.mock.json", "utf8"),
      );
      await orders.importOrders(fixture, { id: 1, requestId: "test-customer-directory" });

      assert.deepEqual(await customers.customerDirectorySummary(), {
        total: 2,
        needs_review: 1,
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
        (await customers.listCustomers({ needsReview: true })).rows.map((row) => row.display_name),
        ["Cliente da verificare"],
      );
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
      await clean.drop();
    }
  },
);
