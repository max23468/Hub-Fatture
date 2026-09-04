import assert from "node:assert/strict";
import test from "node:test";

import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

test("monitoraggio Aruba applica priorità, soglie persistenti e controlli canonici", async () => {
  const database = await temporaryDatabase("aruba_monitoring_controls");
  process.env.APP_ENV = "test";
  process.env.APP_BASE_URL = "http://localhost:8080";
  process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
  process.env.DATABASE_URL = database.connectionString;
  try {
    await runMigrations({ connectionString: database.connectionString });
    const { closePool, getPool, withTransaction } = await import("./client.server.ts");
    const { claimJob } = await import("./connector-jobs.server.ts");
    const { scheduleArubaEmissionEffects } = await import("./aruba-emission-effects.server.ts");
    const controls = await import("./operational-controls.server.ts");
    const pool = getPool();

    await pool.query(
      `INSERT INTO users (username, password_hash, can_approve)
       VALUES ('Massimo', 'synthetic', true);
       INSERT INTO fiscal_profiles (version, status, profile_json) VALUES (1, 'MOCK', '{}');
       INSERT INTO connections
         (provider, environment, account_reference, encrypted_credentials, status,
          account_info_json, account_info_checked_at)
       VALUES ('ARUBA', 'DEVELOPMENT', 'synthetic-aruba-account', 'synthetic', 'CONNECTED',
         jsonb_build_object(
           'accountStatus', jsonb_build_object(
             'expired', false, 'expirationDate', (current_date + 15)::text),
           'usageStatus', jsonb_build_object('usedSpaceKB', 850, 'maxSpaceKB', 1000)),
         now());
       INSERT INTO aruba_api_traffic_limits
         (api_environment, scope, cooldown_until, last_rate_limited_at)
       VALUES ('DEMO', 'INVOICE_READ', now() + interval '1 hour', now());`,
    );
    const document = await pool.query<{ id: string; billing_case_id: string }>(
      `WITH customer AS (
         INSERT INTO customers
           (kind, match_key, display_name, billing_address_json,
            source_confidence, review_required)
         VALUES ('PRIVATE_IT', 'aruba-monitoring-control', 'Cliente sintetico', '{}',
                 'TAX_ID', false)
         RETURNING id
       ), billing_case AS (
         INSERT INTO billing_cases
           (customer_id, local_order_date, currency, status, customer_snapshot_json)
         SELECT id, current_date, 'EUR', 'APPROVED', '{}' FROM customer RETURNING id
       ), stored AS (
         INSERT INTO storage_objects
           (kind, relative_path, sha256, size_bytes, content_type)
         VALUES ('INVOICE_XML', 'synthetic/monitoring.xml', repeat('a', 64), 100,
                 'application/xml') RETURNING id
       )
       INSERT INTO documents
         (billing_case_id, kind, status, document_type, series, fiscal_year, fiscal_number,
          document_date, fiscal_profile_version, currency, total_amount, source_total_amount,
          difference_amount, projection_sha256, approved_at, xml_sha256,
          immutable_snapshot_json, fiscal_profile_snapshot_json, storage_object_id,
          payment_status, payment_method, recipient_snapshot_json, customer_email_mode,
          customer_email_choice, customer_email_sender, customer_email_recipient,
          customer_email_subject, customer_email_body)
       SELECT billing_case.id, 'INVOICE', 'APPROVED', 'TD01', 'FPR', 2026, 7001,
              current_date, 1, 'EUR', 1000, 1000, 0, repeat('b', 64), now(), repeat('a', 64),
              '{}', '{}', stored.id, 'PAID', 'MP08', '{}', 'AUTOMATIC', 'SEND',
              'fatture@example.invalid', 'cliente@example.invalid',
              'Documento sintetico', 'Corpo sintetico'
       FROM billing_case, stored RETURNING id::text, billing_case_id::text`,
    );
    await pool.query(
      `INSERT INTO aruba_batches
         (id, environment, mode, account_reference, manifest_sha256, document_count,
          status, created_by, transport)
       VALUES ('00000000-0000-4000-8000-000000000070', 'MOCK', 'DOCUMENT_ONLY',
         'synthetic-aruba-account', repeat('c', 64), 1, 'ARUBA_ACCEPTED', 1, 'API')`,
    );
    await pool.query(
      `INSERT INTO aruba_submissions
         (batch_id, document_id, attempt_number, environment, mode, manifest_sha256,
          xml_sha256, status, transport, source_filename, accepted_at,
          remote_status_changed_at, next_readback_at)
       VALUES ('00000000-0000-4000-8000-000000000070', $1, 1, 'MOCK', 'DOCUMENT_ONLY',
         repeat('c', 64), repeat('a', 64), 'ARUBA_ACCEPTED', 'API', 'FPR_7001_26.xml',
         now() - interval '25 hours', now() - interval '25 hours', now())`,
      [document.rows[0]!.id],
    );

    await controls.refreshOperationalControls();
    const aruba = await controls.readOperationalControls({});
    const byKind = new Map(aruba.rows.map((row) => [row.kind, row]));
    assert.equal(byKind.get("ARUBA_SUBMISSION_OVERDUE")?.primary_action, "Aggiorna stato Aruba");
    assert.equal(byKind.get("ARUBA_SUBMISSION_OVERDUE")?.severity, "IMPORTANT");
    assert.equal(byKind.has("ARUBA_BATCH_RECONCILIATION"), false);
    assert.equal(byKind.get("ARUBA_ACCOUNT_EXPIRATION_NEAR")?.severity, "IMPORTANT");
    assert.equal(byKind.get("ARUBA_ACCOUNT_STORAGE_NEAR")?.severity, "IMPORTANT");
    assert.equal(byKind.get("ARUBA_API_COOLDOWN")?.primary_action, "Attendi la ripresa automatica");

    await pool.query(
      `UPDATE aruba_submissions SET status = 'SUBMITTED',
         remote_status_changed_at = now() - interval '25 hours'`,
    );
    await controls.refreshOperationalControls();
    const submittedOverdue = await controls.readOperationalControls({
      kind: "ARUBA_SUBMISSION_OVERDUE",
    });
    assert.equal(submittedOverdue.total, 1);

    await pool.query(
      `UPDATE aruba_submissions SET status = 'UNKNOWN_REMOTE_STATE',
         remote_status_changed_at = now(), error_code = 'ARUBA_SUBMISSION_UNKNOWN'`,
    );
    await controls.refreshOperationalControls();
    const uncertain = await controls.readOperationalControls({
      kind: "ARUBA_SUBMISSION_REMOTE_UNKNOWN",
    });
    assert.equal(uncertain.total, 1);
    assert.equal(uncertain.rows[0]!.severity, "BLOCKING");
    assert.equal(uncertain.rows[0]!.primary_action, "Rileggi da Aruba");
    assert.equal(
      await withTransaction((client) => scheduleArubaEmissionEffects(client, document.rows[0]!.id)),
      false,
    );

    await pool.query(
      `INSERT INTO jobs (type, payload_json, priority, run_at)
       VALUES
         ('maintenance_retention', '{}', 50, now() - interval '1 minute'),
         ('aruba_readback_submission',
          '{"readbackKind":"submission","submissionId":"1"}', 10,
          now() - interval '1 minute')`,
    );
    const prioritized = await claimJob("monitoring-priority-worker");
    assert.equal(prioritized?.type, "aruba_readback_submission");

    await pool.query(
      `UPDATE aruba_submissions SET status = 'DELIVERED', error_code = NULL;
       UPDATE connections SET account_info_json = jsonb_build_object(
         'accountStatus', jsonb_build_object(
           'expired', false, 'expirationDate', (current_date + 365)::text),
         'usageStatus', jsonb_build_object('usedSpaceKB', 100, 'maxSpaceKB', 1000));
       UPDATE aruba_api_traffic_limits SET cooldown_until = now() - interval '1 minute';`,
    );
    await pool.query(
      `WITH stored AS (
         INSERT INTO storage_objects
           (kind, relative_path, sha256, size_bytes, content_type)
         VALUES ('ARUBA_PDF', 'synthetic/monitoring.pdf', repeat('d', 64), 32,
                 'application/pdf') RETURNING id
       )
       INSERT INTO aruba_files (document_id, submission_id, storage_object_id, kind)
       SELECT $1, submissions.id, stored.id, 'ARUBA_PDF'
       FROM stored, aruba_submissions AS submissions
       WHERE submissions.document_id = $1`,
      [document.rows[0]!.id],
    );
    assert.equal(
      await withTransaction((client) => scheduleArubaEmissionEffects(client, document.rows[0]!.id)),
      true,
    );
    const email = await pool.query<{ deliveries: number; jobs: number }>(
      `SELECT
         (SELECT count(*)::integer FROM email_deliveries WHERE document_id = $1) AS deliveries,
         (SELECT count(*)::integer FROM jobs WHERE type = 'send_customer_email') AS jobs`,
      [document.rows[0]!.id],
    );
    assert.deepEqual(email.rows[0], { deliveries: 1, jobs: 1 });
    await controls.refreshOperationalControls();
    const resolved = await pool.query<{ open: string }>(
      `SELECT count(*) FILTER (WHERE state <> 'RESOLVED')::text AS open
       FROM operational_controls
       WHERE id LIKE 'ARUBA_SUBMISSION:%'
          OR id LIKE 'ARUBA_ACCOUNT_%'
          OR id LIKE 'ARUBA_API_COOLDOWN:%'`,
    );
    assert.equal(resolved.rows[0]!.open, "0");
    await closePool();
  } finally {
    await import("./client.server.ts").then(({ closePool }) => closePool());
    await database.drop();
  }
});
