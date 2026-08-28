import assert from "node:assert/strict";
import test from "node:test";

import { closePool, getPool } from "./client.server.ts";
import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

test("l’anteprima di riconciliazione resta read-only e distingue la prova API disponibile", async () => {
  const database = await temporaryDatabase("aruba_reconciliation_preview");
  process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-preview";
  process.env.APP_BASE_URL = "http://localhost:8080";
  process.env.APP_ENV = "test";
  process.env.DATABASE_URL = database.connectionString;
  try {
    await runMigrations({ connectionString: database.connectionString });
    await getPool().query(
      `INSERT INTO aruba_sync_runs
        (id, environment, api_environment, account_reference, kind, authority_mode, status,
         window_start, window_end, checkpoint_start, checkpoint_end, lease_expires_at)
       VALUES ('30000000-0000-4000-8000-000000000001', 'MOCK', 'DEMO',
         'synthetic-preview-account', 'BACKFILL', 'SHADOW', 'RUNNING',
         '2026-01-01', '2026-02-01', '2026-01-01', '2026-01-03', now())`,
    );
    await getPool().query(
      `INSERT INTO aruba_remote_documents
        (environment, account_reference, remote_id, document_type, fiscal_year, document_date,
         total_amount, remote_status, remote_status_observed_at, metadata_digest)
       VALUES
        ('MOCK', 'synthetic-preview-account', 'ambiguous-ready', 'TD01', 2026,
          '2026-01-10', 1000, 'DELIVERED', now(), repeat('1', 64)),
        ('MOCK', 'synthetic-preview-account', 'unmatched-pending', 'TD01', 2026,
          '2026-01-11', 2000, 'DELIVERED', now(), repeat('2', 64)),
        ('MOCK', 'synthetic-preview-account', 'ambiguous-multiple', 'TD01', 2026,
          '2026-01-12', 3000, 'DELIVERED', now(), repeat('3', 64))`,
    );
    await getPool().query(
      `INSERT INTO aruba_document_matches
        (remote_document_id, status, method, matcher_version, candidates_json)
       SELECT id,
         CASE remote_id WHEN 'unmatched-pending' THEN 'UNMATCHED' ELSE 'AMBIGUOUS' END,
         'NONE', 3, '[{"probe":true}]'::jsonb
       FROM aruba_remote_documents`,
    );
    await getPool().query(
      `INSERT INTO aruba_api_shadow_documents
        (sync_run_id, provider_group_id, remote_key, document_type, fiscal_year, document_date,
         total_amount, remote_status, xml_sha256)
       VALUES
        ('30000000-0000-4000-8000-000000000001', 'group-ready', 'api-ready', 'TD01',
          2026, '2026-01-10', 1000, 'DELIVERED', repeat('a', 64)),
        ('30000000-0000-4000-8000-000000000001', 'group-multiple-1', 'api-multiple-1',
          'TD01', 2026, '2026-01-12', 3000, 'DELIVERED', repeat('b', 64)),
        ('30000000-0000-4000-8000-000000000001', 'group-multiple-2', 'api-multiple-2',
          'TD01', 2026, '2026-01-12', 3000, 'DELIVERED', repeat('c', 64))`,
    );
    const { getArubaApiReconciliationPreview } =
      await import("./aruba-api-reconciliation-preview.server.ts");
    assert.deepEqual(await getArubaApiReconciliationPreview(), {
      backfillStatus: "RUNNING",
      backfillComplete: false,
      unresolvedDocuments: 3,
      ambiguousDocuments: 2,
      exactApiSignature: 1,
      officialEvidenceAvailable: 2,
      readyForTargetedReconciliation: 1,
      multipleApiSignatures: 1,
      notYetCovered: 1,
    });
    assert.equal(
      (await getPool().query("SELECT count(*)::int AS count FROM aruba_document_matches")).rows[0]
        .count,
      3,
    );
  } finally {
    await closePool();
    await database.drop();
  }
});
