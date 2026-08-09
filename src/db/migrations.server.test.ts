import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import pg from "pg";

import { runMigrations } from "./migrations.server.ts";

import { temporaryDatabase, withClient } from "./database-fixture.ts";

const BASELINE = "001_baseline.sql";
const CONNECTORS = "002_connectors.sql";

test("installazione vuota, checksum e guardie sull'ordine", { timeout: 30_000 }, async () => {
  const clean = await temporaryDatabase("clean");
  try {
    assert.deepEqual(await runMigrations({ connectionString: clean.connectionString }), [
      BASELINE,
      CONNECTORS,
    ]);
    const cleanClient = new pg.Client({ connectionString: clean.connectionString });
    await cleanClient.connect();
    assert.equal(
      (await cleanClient.query("SELECT count(*) FROM schema_migrations")).rows[0].count,
      "2",
    );
    await cleanClient.end();

    const changed = await mkdtemp(path.join(os.tmpdir(), "hf-migrations-changed-"));
    await cp("migrations", changed, { recursive: true });
    await writeFile(
      path.join(changed, BASELINE),
      `${await readFile(path.join(changed, BASELINE), "utf8")}\n-- modifica vietata\n`,
    );
    await assert.rejects(
      runMigrations({ connectionString: clean.connectionString, directory: changed }),
      /Migrazione applicata modificata/,
    );
    await rm(path.join(changed, BASELINE));
    await assert.rejects(
      runMigrations({ connectionString: clean.connectionString, directory: changed }),
      /Migrazione applicata rimossa/,
    );

    // Una migrazione nuova che si ordina prima dell'ultima applicata salterebbe il proprio
    // turno: deve fallire invece di essere applicata fuori sequenza.
    const inserted = await mkdtemp(path.join(os.tmpdir(), "hf-migrations-inserted-"));
    await cp("migrations", inserted, { recursive: true });
    await writeFile(path.join(inserted, "000_inserted.sql"), "SELECT 1;\n");
    await assert.rejects(
      runMigrations({ connectionString: clean.connectionString, directory: inserted }),
      /Migrazione fuori ordine/,
    );

    await withClient(clean.connectionString, async (client) => {
      assert.equal(
        (await client.query("SELECT to_regclass('audit_events') AS table_name")).rows[0].table_name,
        "audit_events",
      );
      assert.equal(
        (await client.query("SELECT to_regclass('orders') AS table_name")).rows[0].table_name,
        "orders",
      );
      assert.equal(
        (
          await client.query(
            "SELECT to_regclass('audit_events_login_rate_scope_idx') AS index_name",
          )
        ).rows[0].index_name,
        "audit_events_login_rate_scope_idx",
      );
      assert.equal(
        (await client.query("SELECT value_json #>> '{}' AS trigger FROM settings")).rows[0].trigger,
        "PAID",
      );
      const customerId = (
        await client.query(
          `INSERT INTO customers
               (kind, match_key, display_name, billing_address_json, source_confidence, review_required)
             VALUES ('UNKNOWN', 'test-high-id', 'Test', '{}'::jsonb, 'AMBIGUOUS', true)
             RETURNING id`,
        )
      ).rows[0].id;
      // Il numero pubblico non tronca oltre le sei cifre: è la ragione per cui la sua
      // definizione era già stata rifatta due volte prima della baseline.
      await client.query("ALTER TABLE billing_cases ALTER COLUMN id RESTART WITH 1000000");
      assert.equal(
        (
          await client.query(
            `INSERT INTO billing_cases
                 (customer_id, local_order_date, currency, status, customer_snapshot_json)
               VALUES ($1, '2026-08-09', 'EUR', 'NEEDS_REVIEW', '{}'::jsonb)
               RETURNING public_number`,
            [customerId],
          )
        ).rows[0].public_number,
        "1000000",
      );
    });
  } finally {
    await clean.drop();
  }
});
