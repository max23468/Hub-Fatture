import assert from "node:assert/strict";
import test from "node:test";

import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

test(
  "i controlli operativi restano stabili, deduplicati e si chiudono con la causa",
  { timeout: 30_000 },
  async () => {
    const clean = await temporaryDatabase("operational_controls");
    try {
      await runMigrations({ connectionString: clean.connectionString });
      process.env.APP_ENV = "test";
      process.env.APP_BASE_URL = "http://localhost:8080";
      process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
      process.env.DATABASE_URL = clean.connectionString;

      const database = await import("./client.server.ts");
      const controls = await import("./operational-controls.server.ts");
      const customer = await database.getPool().query<{ id: string }>(
        `INSERT INTO customers
           (kind, match_key, display_name, billing_address_json,
            source_confidence, review_required)
         VALUES ('UNKNOWN', 'control-stability', 'Cliente da verificare', '{}',
                 'AMBIGUOUS', true)
         RETURNING id::text`,
      );

      const first = await controls.listOperationalControls({ origin: "CUSTOMERS" });
      assert.equal(first.rows.length, 1);
      assert.equal(first.total, 1);
      assert.equal(first.rows[0]!.id, `CUSTOMER_IDENTITY:${customer.rows[0]!.id}`);
      assert.equal(first.rows[0]!.state, "OPEN");

      const repeated = await controls.listOperationalControls({ origin: "CUSTOMERS" });
      assert.equal(repeated.total, 1);
      assert.equal(repeated.rows[0]!.id, first.rows[0]!.id);
      assert.equal(String(repeated.rows[0]!.opened_at), String(first.rows[0]!.opened_at));
      assert.equal(
        (
          await database
            .getPool()
            .query("SELECT count(*) FROM operational_controls WHERE source_type = 'CUSTOMER'")
        ).rows[0].count,
        "1",
      );

      await database
        .getPool()
        .query("UPDATE customers SET review_required = false WHERE id = $1", [
          customer.rows[0]!.id,
        ]);
      await controls.refreshOperationalControls();
      assert.equal((await controls.getOperationalControlSummary()).open, 0);
      assert.equal(
        (
          await database
            .getPool()
            .query("SELECT state FROM operational_controls WHERE id = $1", [first.rows[0]!.id])
        ).rows[0].state,
        "RESOLVED",
      );

      await database
        .getPool()
        .query("UPDATE customers SET review_required = true WHERE id = $1", [customer.rows[0]!.id]);
      const reopened = await controls.listOperationalControls({ origin: "CUSTOMERS" });
      assert.equal(reopened.total, 1);
      assert.equal(reopened.rows[0]!.id, first.rows[0]!.id);
      assert.equal(reopened.rows[0]!.state, "OPEN");
    } finally {
      const database = await import("./client.server.ts");
      await database.closePool();
      await clean.drop();
    }
  },
);
