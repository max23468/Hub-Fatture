import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

const response = (value: unknown) => Response.json(value);

test("il readback usa dettaglio e notifiche fino all’esito canonico senza regressioni", async () => {
  const database = await temporaryDatabase("aruba_api_readback");
  const storageRoot = await mkdtemp(path.join(tmpdir(), "hf-aruba-readback-"));
  const originalFetch = globalThis.fetch;
  process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
  process.env.APP_BASE_URL = "http://localhost:8080";
  process.env.APP_ENV = "test";
  process.env.ARUBA_ACCOUNT_REFERENCE = "synthetic-aruba-account";
  process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 51).toString("base64url");
  process.env.DATABASE_URL = database.connectionString;
  process.env.DOCUMENT_STORAGE_ROOT = storageRoot;
  process.env.ARUBA_API_READ_INTERVAL_MS = "5200";
  try {
    await runMigrations({ connectionString: database.connectionString });
    const xml = await readFile("tests/fixtures/fatturapa/accepted-invoice.anonymized.xml");
    await mkdir(path.join(storageRoot, "synthetic"), { recursive: true });
    await writeFile(path.join(storageRoot, "synthetic/source.xml"), xml);
    const { createHash } = await import("node:crypto");
    const { encryptCredential } = await import("../crypto.server.ts");
    const { closePool, getPool } = await import("./client.server.ts");
    const { claimJob, completeJob, yieldJob } = await import("./connector-jobs.server.ts");
    const { runArubaApiReadbackJob } = await import("./aruba-api-readback.server.ts");
    const pool = getPool();
    const sha256 = createHash("sha256").update(xml).digest("hex");

    await pool.query(
      `INSERT INTO users (username, password_hash, can_approve)
       VALUES ('Massimo', 'synthetic', true);
       INSERT INTO fiscal_profiles (version, status, profile_json) VALUES (1, 'MOCK', '{}')`,
    );
    await pool.query(
      `INSERT INTO connections
         (provider, environment, account_reference, encrypted_credentials, status,
          api_paused, inbound_enabled, automatic_authority, credentials_verified_at,
          credentials_rotated_at)
       VALUES ('ARUBA', 'DEVELOPMENT', 'synthetic-aruba-account', $1, 'CONNECTED',
         false, true, 'API', now(), now())`,
      [
        encryptCredential(
          {
            apiEnvironment: "DEMO",
            username: "utente-sintetico",
            password: "password-sintetica",
            expectedTaxId: "00000000000",
          },
          process.env.CREDENTIALS_ENCRYPTION_KEY!,
        ),
      ],
    );
    const document = await pool.query<{ id: string }>(
      `WITH customer AS (
         INSERT INTO customers
           (kind, match_key, display_name, billing_address_json,
            source_confidence, review_required)
         VALUES ('PRIVATE_IT', 'readback-source', 'Cliente sorgente', '{}', 'TAX_ID', false)
         RETURNING id
       ), billing_case AS (
         INSERT INTO billing_cases
           (customer_id, local_order_date, currency, status, customer_snapshot_json)
         SELECT id, '2026-08-10', 'EUR', 'APPROVED', '{}' FROM customer RETURNING id
       ), stored AS (
         INSERT INTO storage_objects (kind, relative_path, sha256, size_bytes, content_type)
         VALUES ('INVOICE_XML', 'synthetic/source.xml', $1, $2, 'application/xml') RETURNING id
       )
       INSERT INTO documents
         (billing_case_id, kind, status, document_type, series, fiscal_year, fiscal_number,
          document_date, fiscal_profile_version, currency, total_amount, source_total_amount,
          difference_amount, projection_sha256, approved_at, xml_sha256,
          immutable_snapshot_json, fiscal_profile_snapshot_json, storage_object_id,
          payment_status, payment_method, recipient_snapshot_json)
       SELECT billing_case.id, 'INVOICE', 'APPROVED', 'TD01', 'FPR', 2026, 7002,
              '2026-08-10', 1, 'EUR', 12345, 12345, 0, repeat('e', 64), now(), $1,
              '{}', '{}', stored.id, 'PAID', 'MP08', '{}'
       FROM billing_case, stored RETURNING id::text`,
      [sha256, xml.length],
    );
    await pool.query(
      `INSERT INTO aruba_batches
         (id, environment, mode, account_reference, manifest_sha256, document_count,
          status, created_by, transport)
       VALUES ('00000000-0000-4000-8000-000000000071', 'MOCK', 'DOCUMENT_ONLY',
         'synthetic-aruba-account', repeat('f', 64), 1, 'ARUBA_ACCEPTED', 1, 'API')`,
    );
    const submission = await pool.query<{ id: string }>(
      `INSERT INTO aruba_submissions
         (batch_id, document_id, attempt_number, environment, mode, manifest_sha256,
          xml_sha256, status, transport, source_filename, provider_filename, accepted_at,
          remote_status_changed_at, next_readback_at)
       VALUES ('00000000-0000-4000-8000-000000000071', $1, 1, 'MOCK', 'DOCUMENT_ONLY',
         repeat('f', 64), $2, 'ARUBA_ACCEPTED', 'API', 'FPR_7002_26.xml',
         'IT00000000000_OUTBOUND.xml', now(), now(), now()) RETURNING id::text`,
      [document.rows[0]!.id, sha256],
    );
    await pool.query(
      `INSERT INTO jobs (type, payload_json, max_attempts, priority)
       VALUES ('aruba_readback_submission', jsonb_build_object(
         'readbackKind', 'submission', 'submissionId', $1::text), 1, 20)`,
      [submission.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO aruba_submission_attempts
         (id, submission_id, operation, attempt_number, request_fingerprint,
          xml_sha256, status, started_at)
       VALUES ('00000000-0000-4000-8000-000000000072', $1, 'READBACK', 1,
         repeat('a', 64), $2, 'RUNNING', now() - interval '3 minutes')`,
      [submission.rows[0]!.id, sha256],
    );

    const busyRunId = "00000000-0000-4000-8000-000000000073";
    const startInventory = () =>
      pool.query(
        `INSERT INTO aruba_sync_runs
         (id, environment, api_environment, account_reference, kind, authority_mode,
          window_start, window_end, checkpoint_start, checkpoint_end, lease_expires_at)
       VALUES ($1, 'MOCK', 'DEMO', 'synthetic-aruba-account', 'INCREMENTAL', 'CANONICAL',
         now() - interval '1 day', now(), now() - interval '1 day', now(),
         now() + interval '3 minutes')`,
        [busyRunId],
      );
    const finishInventory = () =>
      pool.query(
        "UPDATE aruba_sync_runs SET status = 'COMPLETED', completed_at = now() WHERE id = $1",
        [busyRunId],
      );
    let startInventoryDuringRead = false;
    let providerCalls = 0;
    let rateLimitNextDetail = false;
    globalThis.fetch = async (input) => {
      providerCalls += 1;
      const url = new URL(String(input));
      if (url.pathname === "/auth/signin") {
        return response({
          access_token: "access-sintetico",
          refresh_token: "refresh-sintetico",
          token_type: "bearer",
          expires_in: 1_800,
          ".issued": "Wed, 03 Sep 2031 12:00:00 GMT",
          ".expires": "Wed, 03 Sep 2031 12:30:00 GMT",
        });
      }
      if (url.pathname === "/auth/userInfo") {
        return response({
          username: "utente-sintetico",
          pec: "utente-sintetico@pec.example.invalid",
          userDescription: "Impresa sintetica",
          countryCode: "IT",
          vatCode: "00000000000",
          fiscalCode: "00000000000",
          accountStatus: { expired: false, expirationDate: "2032-09-03" },
          usageStatus: { usedSpaceKB: 256, maxSpaceKB: 1_024 },
        });
      }
      if (url.pathname === "/api/v2/invoices-out/detail") {
        if (rateLimitNextDetail) {
          rateLimitNextDetail = false;
          return new Response(null, { status: 429 });
        }
        assert.equal(url.searchParams.get("filename"), "IT00000000000_OUTBOUND.xml");
        return response({
          channelGroup: 1,
          shopName: null,
          invoices: [
            {
              invoiceDate: "2026-08-10T10:00:00.000Z",
              number: "FPR 0001/26",
              documentType: "TD01",
              status: "Presa in carico",
              statusDescription: null,
              totalDocument: "123.45",
              totalVat: "22.26",
              netPayable: "123.45",
            },
          ],
          sdiErrors: [],
          id: "outbound-group",
          sender: {
            description: "Mittente sintetico",
            countryCode: "IT",
            vatCode: "00000000000",
            fiscalCode: null,
          },
          receiver: {
            description: "Destinatario sintetico",
            countryCode: "IT",
            vatCode: null,
            fiscalCode: "RSSMRA80A01H501U",
          },
          invoiceType: "FPR12",
          docType: "out",
          file: xml.toString("base64"),
          filename: "IT00000000000_OUTBOUND.xml",
          username: "utente-sintetico",
          creationDate: "2026-08-10T10:00:00.000Z",
          lastUpdate: "2026-08-10T10:01:00.000Z",
          idSdi: "7002001",
          pdfFile: null,
          pddAvailable: false,
        });
      }
      if (url.pathname === "/api/v2/invoices-out/notifications") {
        if (startInventoryDuringRead) {
          startInventoryDuringRead = false;
          await startInventory();
        }
        return response({
          count: 1,
          notifications: [
            {
              date: "2026-08-10T10:02:00.000Z",
              docType: "RC",
              filename: "IT00000000000_OUTBOUND_RC.xml",
              invoiceId: "outbound-group",
              notificationDate: "",
              number: "FPR 0001/26",
              result: null,
              file: Buffer.from(
                "<RicevutaConsegna><NomeFile>IT00000000000_OUTBOUND.xml</NomeFile></RicevutaConsegna>",
              ).toString("base64"),
            },
          ],
        });
      }
      throw new Error(`Endpoint sintetico inatteso: ${url.pathname}`);
    };

    let job = await claimJob("aruba-readback-worker");
    await startInventory();
    for (const payload of [
      job!.payload,
      { readbackKind: "targeted", lookupType: "filename", lookupValue: "synthetic.xml" },
      {
        readbackKind: "advanced",
        creationStart: "2026-08-10T00:00:00Z",
        creationEnd: "2026-08-11T00:00:00Z",
      },
    ]) {
      const waiting = await runArubaApiReadbackJob({ ...job!, payload });
      assert.equal(waiting.continuationPending, true);
      assert.equal(waiting.continuationDelayMs, 5_000);
    }
    assert.equal(providerCalls, 0);
    assert.equal(
      (await pool.query("SELECT count(*)::integer AS count FROM aruba_submission_attempts")).rows[0]
        .count,
      1,
    );
    await pool.query("DELETE FROM aruba_sync_runs WHERE id = $1", [busyRunId]);

    startInventoryDuringRead = true;
    const deferred = await runArubaApiReadbackJob(job!);
    assert.equal(deferred.continuationPending, true);
    assert.equal(deferred.continuationDelayMs, 5_000);
    assert.equal(await yieldJob(job!, deferred, Number(deferred.continuationDelayMs)), true);
    assert.deepEqual(
      (
        await pool.query("SELECT status, attempts, last_error_code FROM jobs WHERE id = $1", [
          job!.id,
        ])
      ).rows[0],
      { status: "PENDING", attempts: 0, last_error_code: null },
    );
    assert.deepEqual(
      (await pool.query("SELECT status, last_error_code FROM connections WHERE provider = 'ARUBA'"))
        .rows[0],
      { status: "CONNECTED", last_error_code: null },
    );
    assert.equal(
      (
        await pool.query("SELECT status FROM aruba_submissions WHERE id = $1", [
          submission.rows[0]!.id,
        ])
      ).rows[0].status,
      "ARUBA_ACCEPTED",
    );
    assert.deepEqual(
      (
        await pool.query(
          `SELECT status, error_code, completed_at IS NOT NULL AS completed
       FROM aruba_submission_attempts ORDER BY attempt_number DESC LIMIT 1`,
        )
      ).rows[0],
      { status: "CANCELLED", error_code: null, completed: true },
    );
    await finishInventory();
    await pool.query("UPDATE jobs SET run_at = now() WHERE id = $1", [job!.id]);
    job = await claimJob("aruba-readback-worker");
    assert.equal(job?.type, "aruba_readback_submission");
    const result = await runArubaApiReadbackJob(job!);
    assert.ok("status" in result && "terminal" in result);
    assert.equal(result.status, "DELIVERED");
    assert.equal(result.terminal, true);
    assert.equal(await completeJob(job!, result), true);
    const state = await pool.query<{
      status: string;
      provider_sdi_id: string;
      next_readback_at: Date | null;
      attempt_status: string;
      transition: string;
    }>(
      `SELECT submissions.status, submissions.provider_sdi_id,
              submissions.next_readback_at, attempts.status AS attempt_status,
              attempts.response_metadata_json ->> 'transition' AS transition
       FROM aruba_submissions AS submissions
       JOIN aruba_submission_attempts AS attempts ON attempts.submission_id = submissions.id
       WHERE submissions.id = $1 AND attempts.operation = 'READBACK'
       ORDER BY attempts.attempt_number DESC LIMIT 1`,
      [submission.rows[0]!.id],
    );
    assert.equal(state.rows[0]!.status, "DELIVERED");
    assert.equal(state.rows[0]!.provider_sdi_id, "7002001");
    assert.equal(state.rows[0]!.next_readback_at, null);
    assert.equal(state.rows[0]!.attempt_status, "SUCCEEDED");
    assert.equal(state.rows[0]!.transition, "ADVANCE");
    assert.equal(
      (
        await pool.query(
          `SELECT count(*)::integer AS count FROM aruba_submission_attempts
           WHERE id = '00000000-0000-4000-8000-000000000072'
             AND status = 'FAILED' AND error_code = 'CONFLICT_REVISION'`,
        )
      ).rows[0].count,
      1,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM audit_events WHERE action = 'ARUBA_API_READBACK_COMPLETED'",
        )
      ).rows[0].count,
      1,
    );

    await pool.query(
      `UPDATE aruba_api_traffic_limits SET next_allowed_at = now()
       WHERE api_environment = 'DEMO' AND scope = 'INVOICE_READ'`,
    );
    await pool.query(
      `INSERT INTO jobs (type, payload_json, max_attempts, priority)
       VALUES ('aruba_readback_submission', jsonb_build_object(
         'readbackKind', 'targeted', 'lookupType', 'filename',
         'lookupValue', 'IT00000000000_OUTBOUND.xml'), 1, 40)`,
    );
    rateLimitNextDetail = true;
    const limitedJob = await claimJob("aruba-targeted-worker");
    assert.equal(limitedJob?.type, "aruba_readback_submission");
    const limited = await runArubaApiReadbackJob(limitedJob!);
    assert.equal(limited.continuationPending, true);
    assert.ok(Number(limited.continuationDelayMs) >= 64 * 60_000);
    assert.equal(await yieldJob(limitedJob!, limited, Number(limited.continuationDelayMs)), true);
    const limitedState = await pool.query<{ status: string; cooldown: boolean }>(
      `SELECT jobs.status,
              traffic.cooldown_until > now() AS cooldown
       FROM jobs
       JOIN aruba_api_traffic_limits AS traffic
         ON traffic.api_environment = 'DEMO' AND traffic.scope = 'INVOICE_READ'
       WHERE jobs.id = $1`,
      [limitedJob!.id],
    );
    assert.deepEqual(limitedState.rows[0], { status: "PENDING", cooldown: true });
    await closePool();
  } finally {
    globalThis.fetch = originalFetch;
    await import("./client.server.ts").then(({ closePool }) => closePool());
    await database.drop();
    await rm(storageRoot, { recursive: true, force: true });
  }
});
