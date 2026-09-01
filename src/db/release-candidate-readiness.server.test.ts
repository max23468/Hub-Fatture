import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

test("la qualificazione dry-run terminale chiude il gate soltanto con una prova integra", async (context) => {
  const database = await temporaryDatabase("release_candidate_readiness");
  process.env.APP_ENV = "test";
  process.env.APP_BASE_URL = "http://localhost:8080";
  process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
  process.env.DATABASE_URL = database.connectionString;

  const db = await import("./client.server.ts");
  try {
    await runMigrations({ connectionString: database.connectionString });
    const pool = db.getPool();
    const user = await pool.query<{ id: number }>(
      `INSERT INTO users (username, password_hash, can_approve)
       VALUES ('Massimo', 'synthetic', true)
       RETURNING id`,
    );
    await pool.query(
      `INSERT INTO fiscal_profiles (version, status, profile_json)
       VALUES (1, 'MOCK', '{}')`,
    );
    const customer = await pool.query<{ id: string }>(
      `INSERT INTO customers
         (kind, match_key, display_name, billing_address_json, source_confidence,
          review_required)
       VALUES ('PRIVATE_IT', 'release-readiness', 'Cliente sintetico', '{}', 'TAX_ID', false)
       RETURNING id`,
    );
    const billingCase = await pool.query<{ id: string }>(
      `INSERT INTO billing_cases
         (customer_id, local_order_date, currency, status, customer_snapshot_json,
          fiscal_profile_version)
       VALUES ($1, CURRENT_DATE, 'EUR', 'APPROVED', '{}', 1)
       RETURNING id`,
      [customer.rows[0]!.id],
    );
    const xmlSha256 = "a".repeat(64);
    const manifestSha256 = "b".repeat(64);
    const storage = await pool.query<{ id: string }>(
      `INSERT INTO storage_objects
         (kind, relative_path, sha256, size_bytes, content_type)
       VALUES ('INVOICE_XML', 'test/release-readiness.xml', $1, 1, 'application/xml')
       RETURNING id`,
      [xmlSha256],
    );
    const document = await pool.query<{ id: string }>(
      `INSERT INTO documents
         (billing_case_id, kind, status, document_type, series, fiscal_year,
          fiscal_number, document_date, fiscal_profile_version, currency, total_amount,
          source_total_amount, difference_amount, projection_sha256, payment_status,
          payment_method, recipient_snapshot_json, approved_at, xml_sha256,
          immutable_snapshot_json, fiscal_profile_snapshot_json, storage_object_id)
       VALUES
         ($1, 'INVOICE', 'APPROVED', 'TD01', 'FPR', 2026, 1, CURRENT_DATE, 1,
          'EUR', 1000, 1000, 0, $2, 'PAID', 'MP08', '{}', now(), $3, '{}', '{}', $4)
       RETURNING id`,
      [billingCase.rows[0]!.id, "c".repeat(64), xmlSha256, storage.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO connections
         (provider, environment, account_reference, encrypted_credentials, status)
       VALUES
         ('SHOPIFY', 'PRODUCTION', 'shopify-test', 'synthetic', 'CONNECTED'),
         ('EBAY', 'PRODUCTION', 'ebay-test', 'synthetic', 'CONNECTED');
       INSERT INTO sync_cursors (provider, stream)
       VALUES ('SHOPIFY', 'history_import'), ('EBAY', 'history_import')`,
    );

    const batchId = randomUUID();
    await pool.query(
      `INSERT INTO aruba_batches
         (id, environment, mode, transport, account_reference, manifest_sha256,
          document_count, attempt_number, status, requires_reconciliation, created_by)
       VALUES ($1, 'PRODUCTION', 'DOCUMENT_ONLY', 'API', 'aruba-test', $2,
          1, 1, 'DRY_RUN_VALIDATED', false, $3)`,
      [batchId, manifestSha256, user.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO aruba_batch_documents
         (batch_id, document_id, position, document_revision, xml_sha256, filename)
       VALUES ($1, $2, 1, 1, $3, 'invoice.xml')`,
      [batchId, document.rows[0]!.id, xmlSha256],
    );
    const submission = await pool.query<{ id: string }>(
      `INSERT INTO aruba_submissions
         (batch_id, document_id, attempt_number, environment, mode, transport,
          manifest_sha256, xml_sha256, status)
       VALUES ($1, $2, 1, 'PRODUCTION', 'DOCUMENT_ONLY', 'API', $3, $4,
          'DRY_RUN_VALIDATED')
       RETURNING id`,
      [batchId, document.rows[0]!.id, manifestSha256, xmlSha256],
    );
    await pool.query(
      `INSERT INTO aruba_dry_run_qualifications
         (id, batch_id, environment, account_reference, manifest_sha256, status,
          expires_at, consumed_at, completed_at, created_by)
       VALUES ($1, $2, 'PRODUCTION', 'aruba-test', $3, 'SUCCEEDED',
          now() + interval '1 hour', now(), now(), $4)`,
      [randomUUID(), batchId, manifestSha256, user.rows[0]!.id],
    );
    const attemptId = randomUUID();
    await pool.query(
      `INSERT INTO aruba_submission_attempts
         (id, submission_id, operation, attempt_number, request_fingerprint,
          xml_sha256, status, completed_at)
       VALUES ($1, $2, 'DRY_RUN', 1, $3, $4, 'SUCCEEDED', now())`,
      [attemptId, submission.rows[0]!.id, "d".repeat(64), xmlSha256],
    );
    const job = await pool.query<{ id: string }>(
      `INSERT INTO jobs (type, payload_json, status, completed_at)
       VALUES ('aruba_dry_run_submission', jsonb_build_object('submissionId', $1::text),
         'COMPLETED', now())
       RETURNING id`,
      [submission.rows[0]!.id],
    );

    const readiness = await import("./release-candidate-readiness.server.ts");
    assert.deepEqual(await readiness.releaseCandidateReadinessState(pool), {
      unsafeApprovedDocuments: 0,
      completedDryRunQualifications: 1,
      unreconciledHistory: 0,
      pendingHistoryImports: 0,
      openArubaBatches: 0,
    });

    const brokenProofs: Array<[string, string, unknown[]]> = [
      [
        "tentativo dry-run mancante",
        `DELETE FROM aruba_submission_attempts WHERE id = $1`,
        [attemptId],
      ],
      [
        "hash XML divergente",
        `UPDATE aruba_submission_attempts SET xml_sha256 = repeat('e', 64) WHERE id = $1`,
        [attemptId],
      ],
      [
        "marcatura di invio presente",
        `UPDATE aruba_submissions SET submitted_at = now() WHERE id = $1`,
        [submission.rows[0]!.id],
      ],
      [
        "job ancora attivo",
        `UPDATE jobs SET status = 'PENDING', completed_at = NULL WHERE id = $1`,
        [job.rows[0]!.id],
      ],
      [
        "stato remoto incerto",
        `UPDATE aruba_batches
         SET status = 'UNKNOWN_REMOTE_STATE', requires_reconciliation = true
         WHERE id = $1`,
        [batchId],
      ],
    ];
    for (const [label, mutation, parameters] of brokenProofs) {
      await context.test(label, async () => {
        const transaction = await pool.connect();
        try {
          await transaction.query("BEGIN");
          await transaction.query(mutation, parameters);
          assert.deepEqual(await readiness.releaseCandidateReadinessState(transaction), {
            unsafeApprovedDocuments: 1,
            completedDryRunQualifications: 0,
            unreconciledHistory: 0,
            pendingHistoryImports: 0,
            openArubaBatches: 1,
          });
        } finally {
          await transaction.query("ROLLBACK");
          transaction.release();
        }
      });
    }
  } finally {
    await db.closePool();
    await database.drop();
  }
});
