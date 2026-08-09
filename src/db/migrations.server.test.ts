import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import pg from "pg";

import { runMigrations } from "./migrations.server.ts";

import { temporaryDatabase, withClient } from "./database-fixture.ts";

test(
  "installazione vuota, checksum e upgrade preservano lo snapshot",
  { timeout: 30_000 },
  async () => {
    const clean = await temporaryDatabase("clean");
    const upgrade = await temporaryDatabase("upgrade");
    try {
      assert.deepEqual(await runMigrations({ connectionString: clean.connectionString }), [
        "001_foundations.sql",
        "002_auth_audit.sql",
        "003_login_ip.sql",
        "004_reset_password_hashes.sql",
        "005_order_domain.sql",
        "006_billing_case_customer_snapshot.sql",
        "007_order_source_revisions.sql",
        "008_invoiced_order_status.sql",
        "009_unprefixed_billing_case_number.sql",
        "010_order_domain_hardening.sql",
        "011_unbounded_billing_case_number.sql",
        "012_login_rate_limit_audit_index.sql",
      ]);
      const cleanClient = new pg.Client({ connectionString: clean.connectionString });
      await cleanClient.connect();
      assert.equal(
        (await cleanClient.query("SELECT count(*) FROM schema_migrations")).rows[0].count,
        "12",
      );
      await cleanClient.end();

      const changed = await mkdtemp(path.join(os.tmpdir(), "hf-migrations-changed-"));
      await cp("migrations", changed, { recursive: true });
      await writeFile(
        path.join(changed, "001_foundations.sql"),
        `${await readFile(path.join(changed, "001_foundations.sql"), "utf8")}\n-- modifica vietata\n`,
      );
      await assert.rejects(
        runMigrations({ connectionString: clean.connectionString, directory: changed }),
        /Migrazione applicata modificata/,
      );
      await rm(path.join(changed, "001_foundations.sql"));
      await assert.rejects(
        runMigrations({ connectionString: clean.connectionString, directory: changed }),
        /Migrazione applicata rimossa/,
      );

      const inserted = await mkdtemp(path.join(os.tmpdir(), "hf-migrations-inserted-"));
      await cp("migrations", inserted, { recursive: true });
      await writeFile(path.join(inserted, "001_inserted.sql"), "SELECT 1;\n");
      await assert.rejects(
        runMigrations({ connectionString: clean.connectionString, directory: inserted }),
        /Migrazione fuori ordine/,
      );

      const firstOnly = await mkdtemp(path.join(os.tmpdir(), "hf-migrations-first-"));
      await cp("migrations/001_foundations.sql", path.join(firstOnly, "001_foundations.sql"));
      await runMigrations({ connectionString: upgrade.connectionString, directory: firstOnly });
      await withClient(upgrade.connectionString, async (client) => {
        await client.query(
          "INSERT INTO users (username, password_hash) VALUES ('matteo', 'synthetic')",
        );
      });
      await runMigrations({ connectionString: upgrade.connectionString });
      await withClient(upgrade.connectionString, async (client) => {
        // Il cambio di formato degli hash rimuove gli account invece di conservare un percorso
        // di verifica legacy: senza questo l'installazione esistente resterebbe esclusa.
        assert.equal((await client.query("SELECT count(*) FROM users")).rows[0].count, "0");
        assert.equal(
          (await client.query("SELECT to_regclass('audit_events') AS table_name")).rows[0]
            .table_name,
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
        const customerId = (
          await client.query(
            `INSERT INTO customers
               (kind, match_key, display_name, billing_address_json, source_confidence, review_required)
             VALUES ('UNKNOWN', 'test-high-id', 'Test', '{}'::jsonb, 'AMBIGUOUS', true)
             RETURNING id`,
          )
        ).rows[0].id;
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
      await upgrade.drop();
    }
  },
);
