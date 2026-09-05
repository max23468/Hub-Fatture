import assert from "node:assert/strict";
import test from "node:test";

import { closePool, getPool } from "./client.server.ts";
import { scheduleDueSyncs } from "./connector-jobs.server.ts";
import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

test("uno stato Aruba incerto conclusivo pianifica una rilettura mirata", async () => {
  const fixture = await temporaryDatabase("aruba_uncertain_scheduling");
  process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
  process.env.APP_BASE_URL = "http://localhost:8080";
  process.env.APP_ENV = "test";
  process.env.DATABASE_URL = fixture.connectionString;
  try {
    await runMigrations({ connectionString: fixture.connectionString });
    await getPool().query(
      `INSERT INTO connections
        (provider, environment, account_reference, encrypted_credentials, status,
         api_paused, inbound_enabled, automatic_authority, credentials_verified_at,
         last_full_sync_at)
       VALUES ('ARUBA', 'DEVELOPMENT', 'synthetic-account', 'encrypted', 'CONNECTED',
               false, true, 'API', now() - interval '2 minutes', now());
       INSERT INTO aruba_sync_runs
        (id, environment, api_environment, account_reference, kind, authority_mode, status,
         window_start, window_end, checkpoint_start, checkpoint_end, lease_expires_at,
         completed_at)
       VALUES ('10000000-0000-4000-8000-000000000201', 'MOCK', 'DEMO',
               'synthetic-account', 'BACKFILL', 'CANONICAL', 'COMPLETED',
               '2026-07-01', '2026-08-01', '2026-07-01', '2026-08-01', now(), now())`,
    );
    const remote = await getPool().query<{ id: string }>(
      `INSERT INTO aruba_remote_documents
        (environment, account_reference, remote_id, document_type, fiscal_year, series,
         fiscal_number, document_date, total_amount, remote_status, remote_status_observed_at,
         metadata_digest, automatic_source, provider_group_id)
       VALUES ('MOCK', 'synthetic-account', 'uncertain-terminal', 'TD01', 2026, 'FPR',
               '20', '2026-08-31', 1000, 'DELIVERED', now(), repeat('a', 64), 'API',
               'provider-group-20')
       RETURNING id::text`,
    );
    await getPool().query(
      `INSERT INTO aruba_document_matches
        (remote_document_id, status, method, matcher_version)
       VALUES ($1, 'UNKNOWN_REMOTE_STATE', 'NONE', 1)`,
      [remote.rows[0]!.id],
    );

    await scheduleDueSyncs();
    assert.deepEqual(
      (await getPool().query("SELECT type FROM jobs WHERE status = 'PENDING'")).rows,
      [{ type: "aruba_refresh_nonterminal" }],
    );
    await getPool().query(`UPDATE jobs SET status = 'COMPLETED', completed_at = now()
      WHERE status = 'PENDING'`);
    await scheduleDueSyncs();
    assert.deepEqual(
      (await getPool().query("SELECT type FROM jobs WHERE status = 'PENDING'")).rows,
      [],
    );
    await getPool().query(`UPDATE jobs SET completed_at = now() - interval '3 minutes'
      WHERE type = 'aruba_refresh_nonterminal'`);
    await scheduleDueSyncs();
    assert.deepEqual(
      (await getPool().query("SELECT type FROM jobs WHERE status = 'PENDING'")).rows,
      [{ type: "aruba_sync_inventory" }],
      "la rilettura mirata non rinvia di quindici minuti il prossimo inventario",
    );
    await getPool()
      .query(`UPDATE jobs SET status = 'COMPLETED', completed_at = now() - interval '9 minutes'
      WHERE type = 'aruba_sync_inventory' AND status = 'PENDING'`);
    await scheduleDueSyncs();
    assert.equal(
      (await getPool().query("SELECT count(*) FROM jobs WHERE status = 'PENDING'")).rows[0].count,
      "0",
      "l’inventario periodico non riparte prima dei dieci minuti",
    );
    await getPool().query(`UPDATE jobs SET completed_at = now() - interval '11 minutes'
      WHERE type = 'aruba_sync_inventory'`);
    await scheduleDueSyncs();
    assert.deepEqual(
      (await getPool().query("SELECT type FROM jobs WHERE status = 'PENDING'")).rows,
      [{ type: "aruba_sync_inventory" }],
    );
    await getPool().query("DELETE FROM jobs WHERE status = 'PENDING'");
    await getPool().query(
      `UPDATE jobs SET status = 'COMPLETED', completed_at = now() - interval '16 minutes'
       WHERE status = 'PENDING';
       INSERT INTO jobs (type, status, run_at, completed_at)
       VALUES ('aruba_sync_inventory', 'COMPLETED', now() - interval '2 hours',
               now() - interval '2 hours')`,
    );
    await scheduleDueSyncs();
    assert.deepEqual(
      (await getPool().query("SELECT type FROM jobs WHERE status = 'PENDING'")).rows,
      [{ type: "aruba_sync_inventory" }],
    );
    await getPool().query(
      `UPDATE jobs SET status = 'COMPLETED', completed_at = now() - interval '16 minutes'
       WHERE status = 'PENDING';
       UPDATE jobs SET completed_at = now() - interval '1 hour'
       WHERE type = 'aruba_refresh_nonterminal'`,
    );
    await scheduleDueSyncs();
    assert.deepEqual(
      (await getPool().query("SELECT type FROM jobs WHERE status = 'PENDING'")).rows,
      [{ type: "aruba_refresh_nonterminal" }],
    );
  } finally {
    await closePool();
    await fixture.drop();
  }
});
