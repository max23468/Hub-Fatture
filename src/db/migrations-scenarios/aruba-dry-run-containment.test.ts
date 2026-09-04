import {
  ARUBA_REMOTE_IDENTITY_AND_DRY_RUN_CONTAINMENT,
  assert,
  cp,
  mkdtemp,
  migrationsFrom,
  os,
  path,
  removeMigrationsFrom,
  rm,
  runMigrations,
  temporaryDatabase,
  test,
  withClient,
} from "./support.ts";

test("la migrazione confina i dry-run Production e separa l’identità remota", async () => {
  const database = await temporaryDatabase("aruba_dry_run_containment_upgrade");
  const beforeContainment = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-aruba-containment-"),
  );
  try {
    await cp("migrations", beforeContainment, { recursive: true });
    await removeMigrationsFrom(beforeContainment, ARUBA_REMOTE_IDENTITY_AND_DRY_RUN_CONTAINMENT);
    await runMigrations({
      connectionString: database.connectionString,
      directory: beforeContainment,
    });

    await withClient(database.connectionString, async (client) => {
      const user = await client.query<{ id: number }>(
        `INSERT INTO users (username, password_hash, can_approve)
         VALUES ('Massimo', 'synthetic', true) RETURNING id`,
      );
      await client.query(
        "INSERT INTO fiscal_profiles (version, status, profile_json) VALUES (1, 'MOCK', '{}')",
      );
      const customer = await client.query<{ id: string }>(
        `INSERT INTO customers
           (kind, match_key, display_name, billing_address_json, source_confidence, review_required)
         VALUES ('PRIVATE_IT', 'containment', 'Cliente sintetico', '{}', 'TAX_ID', false)
         RETURNING id`,
      );
      const billingCase = await client.query<{ id: string }>(
        `INSERT INTO billing_cases
           (customer_id, local_order_date, currency, status, customer_snapshot_json)
         VALUES ($1, CURRENT_DATE, 'EUR', 'APPROVED', '{}') RETURNING id`,
        [customer.rows[0]!.id],
      );
      const storage = await client.query<{ id: string }>(
        `INSERT INTO storage_objects (kind, relative_path, sha256, size_bytes, content_type)
         VALUES ('INVOICE_XML', 'test/containment.xml', $1, 1, 'application/xml') RETURNING id`,
        ["1".repeat(64)],
      );
      const document = await client.query<{ id: string }>(
        `INSERT INTO documents
           (billing_case_id, kind, status, document_type, series, fiscal_year, fiscal_number,
            document_date, fiscal_profile_version, currency, total_amount, source_total_amount,
            difference_amount, projection_sha256, payment_status, payment_method,
            recipient_snapshot_json, approved_at, xml_sha256, immutable_snapshot_json,
            fiscal_profile_snapshot_json, storage_object_id)
         VALUES ($1, 'INVOICE', 'APPROVED', 'TD01', 'FPR', 2026, 1, CURRENT_DATE, 1,
           'EUR', 1000, 1000, 0, $2, 'PAID', 'MP08', '{}', now(), $3, '{}', '{}', $4)
         RETURNING id`,
        [billingCase.rows[0]!.id, "2".repeat(64), "1".repeat(64), storage.rows[0]!.id],
      );
      const batchId = "73000000-0000-4000-8000-000000000001";
      await client.query(
        `INSERT INTO aruba_batches
           (id, environment, mode, transport, account_reference, manifest_sha256,
            document_count, attempt_number, status, created_by)
         VALUES ($1, 'PRODUCTION', 'DOCUMENT_ONLY', 'API', 'aruba-test', $2,
           1, 1, 'DRY_RUN_PENDING', $3)`,
        [batchId, "3".repeat(64), user.rows[0]!.id],
      );
      const submission = await client.query<{ id: string }>(
        `INSERT INTO aruba_submissions
           (batch_id, document_id, attempt_number, environment, mode, transport,
            manifest_sha256, xml_sha256, status)
         VALUES ($1, $2, 1, 'PRODUCTION', 'DOCUMENT_ONLY', 'API', $3, $4,
           'DRY_RUN_PENDING') RETURNING id`,
        [batchId, document.rows[0]!.id, "3".repeat(64), "1".repeat(64)],
      );
      await client.query(
        `INSERT INTO aruba_submission_attempts
           (id, submission_id, operation, attempt_number, request_fingerprint,
            xml_sha256, status, provider_reference, completed_at)
         VALUES ($1, $2, 'DRY_RUN', 1, $3, $4, 'SUCCEEDED',
           'IT00000000000_DRY_RUN.xml.p7m', now())`,
        [
          "73000000-0000-4000-8000-000000000002",
          submission.rows[0]!.id,
          "4".repeat(64),
          "1".repeat(64),
        ],
      );
      await client.query(
        `INSERT INTO aruba_dry_run_qualifications
           (id, batch_id, environment, account_reference, manifest_sha256, status,
            expires_at, consumed_at, created_by)
         VALUES ($1, $2, 'PRODUCTION', 'aruba-test', $3, 'CONSUMED',
           now() + interval '1 hour', now(), $4)`,
        ["73000000-0000-4000-8000-000000000003", batchId, "3".repeat(64), user.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO jobs (type, payload_json, status)
         VALUES ('aruba_dry_run_submission', jsonb_build_object('submissionId', $1::text), 'PENDING')`,
        [submission.rows[0]!.id],
      );
    });

    assert.deepEqual(
      await runMigrations({ connectionString: database.connectionString }),
      migrationsFrom(ARUBA_REMOTE_IDENTITY_AND_DRY_RUN_CONTAINMENT),
    );
    await withClient(database.connectionString, async (client) => {
      const state = await client.query(
        `SELECT submissions.status AS submission_status, batches.status AS batch_status,
                batches.requires_reconciliation, qualifications.status AS qualification_status,
                submissions.provider_filename, submissions.next_readback_at IS NOT NULL AS due_readback,
                jobs.status AS job_status, jobs.last_error_code
         FROM aruba_submissions AS submissions
         JOIN aruba_batches AS batches ON batches.id = submissions.batch_id
         JOIN aruba_dry_run_qualifications AS qualifications ON qualifications.batch_id = batches.id
         JOIN jobs ON jobs.payload_json ->> 'submissionId' = submissions.id::text`,
      );
      assert.deepEqual(state.rows[0], {
        submission_status: "UNKNOWN_REMOTE_STATE",
        batch_status: "UNKNOWN_REMOTE_STATE",
        requires_reconciliation: true,
        qualification_status: "UNKNOWN_REMOTE_STATE",
        provider_filename: "IT00000000000_DRY_RUN.xml.p7m",
        due_readback: true,
        job_status: "FAILED",
        last_error_code: "ARUBA_SEND_NOT_AUTHORIZED",
      });
      const indexes = await client.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
         WHERE indexname IN ('aruba_remote_documents_fiscal_identity_idx',
           'aruba_remote_documents_xml_idx')`,
      );
      assert.equal(indexes.rows.length, 2);
      assert.equal(
        indexes.rows.some(({ indexdef }) => indexdef.includes("UNIQUE INDEX")),
        false,
      );
    });
  } finally {
    await rm(beforeContainment, { recursive: true, force: true });
    await database.drop();
  }
});
