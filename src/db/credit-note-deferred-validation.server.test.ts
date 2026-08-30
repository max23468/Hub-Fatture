import assert from "node:assert/strict";
import test from "node:test";

import { temporaryDatabase, withClient } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

test("la validazione differita ignora una nota transitoria eliminata ma blocca quella persistente", async () => {
  const database = await temporaryDatabase("credit_note_deferred_validation");
  try {
    await runMigrations({ connectionString: database.connectionString });
    await withClient(database.connectionString, async (client) => {
      await client.query(
        `INSERT INTO customers
          (kind, match_key, display_name, billing_address_json, source_confidence,
           review_required)
         VALUES ('UNKNOWN', 'credit-note-trigger-customer', 'Cliente sintetico', '{}',
           'AMBIGUOUS', true);
         INSERT INTO fiscal_profiles (version, status, profile_json)
         VALUES (1, 'MOCK', '{}');
         INSERT INTO billing_cases
          (customer_id, local_order_date, currency, status, customer_snapshot_json,
           fiscal_profile_version)
         SELECT id, '2026-07-01', 'EUR', 'CLOSED', '{}', 1
         FROM customers WHERE match_key = 'credit-note-trigger-customer'`,
      );

      await client.query("BEGIN");
      const transient = await client.query<{ id: string }>(
        `INSERT INTO documents
          (billing_case_id, kind, status, document_type, series, document_date,
           fiscal_profile_version, currency, total_amount, source_total_amount,
           difference_amount, projection_sha256, payment_method)
         SELECT id, 'CREDIT_NOTE', 'DRAFT', 'TD04', 'SYN', '2026-07-01', 1, 'EUR',
           100, 100, 0, repeat('0', 64), 'MP05'
         FROM billing_cases RETURNING id`,
      );
      await client.query("DELETE FROM documents WHERE id = $1", [transient.rows[0]!.id]);
      await client.query("COMMIT");
      assert.equal(
        (await client.query("SELECT count(*)::integer AS count FROM documents")).rows[0].count,
        0,
      );

      await client.query("BEGIN");
      await client.query(
        `INSERT INTO documents
          (billing_case_id, kind, status, document_type, series, document_date,
           fiscal_profile_version, currency, total_amount, source_total_amount,
           difference_amount, projection_sha256, payment_method)
         SELECT id, 'CREDIT_NOTE', 'DRAFT', 'TD04', 'SYN', '2026-07-01', 1, 'EUR',
           100, 100, 0, repeat('0', 64), 'MP05'
         FROM billing_cases`,
      );
      await assert.rejects(
        client.query("COMMIT"),
        /Il totale della nota non coincide con i rimborsi collegati/,
      );
      await client.query("ROLLBACK");
    });
  } finally {
    await database.drop();
  }
});
