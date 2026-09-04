import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

function tokenResponse() {
  return Response.json({
    access_token: "access-sintetico",
    refresh_token: "refresh-sintetico",
    token_type: "bearer",
    expires_in: 1_800,
    ".issued": "Wed, 03 Sep 2031 12:00:00 GMT",
    ".expires": "Wed, 03 Sep 2031 12:30:00 GMT",
  });
}

function accountResponse() {
  return Response.json({
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

test("l’invio outbound resta fail-closed e riconcilia ogni esito senza rete reale", async () => {
  const database = await temporaryDatabase("aruba_api_send");
  const storageRoot = await mkdtemp(join(tmpdir(), "hf-aruba-send-"));
  const originalFetch = globalThis.fetch;
  process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
  process.env.APP_BASE_URL = "http://localhost:8080";
  process.env.APP_ENV = "test";
  process.env.ARUBA_ACCOUNT_REFERENCE = "synthetic-aruba-account";
  process.env.ARUBA_ACCOUNT_IDENTITY = "synthetic-aruba-account";
  process.env.ARUBA_SUBMISSION_ENABLED = "true";
  process.env.ARUBA_API_READ_INTERVAL_MS = "5200";
  process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 41).toString("base64url");
  process.env.DATABASE_URL = database.connectionString;
  process.env.DOCUMENT_STORAGE_ROOT = storageRoot;

  try {
    await runMigrations({ connectionString: database.connectionString });
    const { encryptCredential } = await import("../crypto.server.ts");
    const { getConfig } = await import("../config.server.ts");
    const { closePool, getPool, withTransaction } = await import("./client.server.ts");
    const { claimJob, completeJob, yieldJob } = await import("./connector-jobs.server.ts");
    const connection = await import("./aruba-api-connection.server.ts");
    const outbound = await import("./aruba-api-outbound.server.ts");
    const pool = getPool();

    await pool.query(
      "INSERT INTO users (username, password_hash, can_approve) VALUES ('Massimo', 'synthetic', true)",
    );
    await pool.query(
      "INSERT INTO fiscal_profiles (version, status, profile_json) VALUES (1, 'MOCK', '{}')",
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
    await pool.query(
      `INSERT INTO settings (key, value_json) VALUES
         ('aruba_mode', '"AUTOMATIC_AFTER_APPROVAL"'::jsonb)
       ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json`,
    );
    await pool.query(
      `INSERT INTO aruba_sync_runs
        (id, environment, api_environment, account_reference, kind, authority_mode, status,
         window_start, window_end, checkpoint_start, checkpoint_end, lease_expires_at,
         completed_at, full_scan_completed_at)
       VALUES ('00000000-0000-4000-8000-000000000070', 'MOCK', 'DEMO',
         'synthetic-aruba-account', 'FULL', 'CANONICAL', 'COMPLETED',
         now() - interval '48 hours', now(), now() - interval '48 hours', now(),
         now() - interval '1 minute', now(), now())`,
    );

    let sendCalls = 0;
    const sendAttempts = new Map<string, number>();
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/signin") return tokenResponse();
      if (url.pathname === "/auth/userInfo") return accountResponse();
      assert.equal(url.origin, "https://demows.fatturazioneelettronica.aruba.it");
      assert.equal(url.pathname, "/services/invoice/upload");
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      assert.deepEqual(Object.keys(body).sort(), ["dataFile", "dryRun", "skipExtraSchema"]);
      assert.equal(body.skipExtraSchema, false);
      const xml = Buffer.from(String(body.dataFile), "base64").toString("utf8");
      const marker = /<Numero>FPR ([A-Z]+)<\/Numero>/.exec(xml)?.[1];
      assert.ok(marker);
      await pool.query(
        "UPDATE aruba_api_traffic_limits SET next_allowed_at = now() WHERE scope = 'SEND'",
      );
      assert.equal(body.dryRun, false);
      sendCalls += 1;
      const attempt = (sendAttempts.get(marker) ?? 0) + 1;
      sendAttempts.set(marker, attempt);
      if (marker === "LEASEPERSA" && attempt === 1) {
        const reclaimed = await pool.query(
          `UPDATE jobs SET locked_by = 'worker-reclaimed', claim_token = gen_random_uuid(),
             lease_expires_at = now() + interval '2 minutes'
           WHERE type = 'aruba_send_submission' AND status = 'RUNNING'`,
        );
        assert.equal(reclaimed.rowCount, 1);
        return new Response(null, { status: 401 });
      }
      if (marker === "AMBIGUO") throw new TypeError("trasporto interrotto dopo la richiesta");
      const code =
        marker === "RIFIUTO"
          ? "0096"
          : marker === "DUPLICATO"
            ? "0034"
            : marker === "RIPROVA" && attempt === 1
              ? "0095"
              : "0000";
      return Response.json({
        errorCode: code,
        errorDescription:
          code === "0000" ? "Operazione effettuata" : `Esito remoto non sanificato ${code}`,
        uploadFileName: code === "0000" ? `ARUBA-${marker}.xml.p7m` : null,
      });
    };

    async function createApprovedDocument(marker: string, fiscalNumber: number) {
      const relativePath = `aruba-send/${marker.toLowerCase()}.xml`;
      const validFixture = await readFile(
        new URL("../../tests/fixtures/fatturapa/accepted-invoice.anonymized.xml", import.meta.url),
        "utf8",
      );
      const xml = Buffer.from(
        marker === "INVALIDO"
          ? "<FatturaElettronica />"
          : validFixture.replace("<Numero>FPR 0001/26</Numero>", `<Numero>FPR ${marker}</Numero>`),
      );
      const sha256 = createHash("sha256").update(xml).digest("hex");
      await mkdir(join(storageRoot, "aruba-send"), { recursive: true });
      await writeFile(join(storageRoot, relativePath), xml);
      const inserted = await pool.query<{ id: string }>(
        `WITH customer AS (
           INSERT INTO customers
             (kind, match_key, display_name, billing_address_json,
              source_confidence, review_required)
           VALUES ('PRIVATE_IT', $1, $2, '{}', 'TAX_ID', false)
           RETURNING id
         ), billing_case AS (
           INSERT INTO billing_cases
             (customer_id, local_order_date, currency, status, customer_snapshot_json)
           SELECT id, '2026-09-03', 'EUR', 'APPROVED', jsonb_build_object('displayName', $2::text)
           FROM customer RETURNING id
         ), stored AS (
           INSERT INTO storage_objects (kind, relative_path, sha256, size_bytes, content_type)
           VALUES ('INVOICE_XML', $3, $4, $5, 'application/xml') RETURNING id
         )
         INSERT INTO documents
           (billing_case_id, kind, status, document_type, series, fiscal_year, fiscal_number,
            document_date, fiscal_profile_version, currency, total_amount, source_total_amount,
            difference_amount, projection_sha256, approved_at, xml_sha256,
            immutable_snapshot_json, fiscal_profile_snapshot_json, storage_object_id,
            payment_status, payment_method, recipient_snapshot_json)
         SELECT billing_case.id, 'INVOICE', 'APPROVED', 'TD01', 'FPR', 2026, $6,
                '2026-09-03', 1, 'EUR', 10000, 10000, 0, repeat('c', 64), now(), $4,
                '{}', '{}', stored.id, 'PAID', 'MP08', '{}'
         FROM billing_case, stored RETURNING id`,
        [
          `send-${marker.toLowerCase()}`,
          `Cliente ${marker}`,
          relativePath,
          sha256,
          xml.length,
          fiscalNumber,
        ],
      );
      return {
        id: inserted.rows[0]!.id,
        revision: 1,
        sha256,
        filename: `FPR_${String(fiscalNumber).padStart(4, "0")}_26.xml`,
        sizeBytes: xml.length,
        fiscalNumber: `FPR ${String(fiscalNumber).padStart(4, "0")}/26`,
        documentDate: "2026-09-03",
        totalAmount: 10000,
      };
    }

    async function createBatch(markers: string[], startNumber: number) {
      const documents = await Promise.all(
        markers.map((marker, index) => createApprovedDocument(marker, startNumber + index)),
      );
      const batchId = await withTransaction((client) =>
        outbound.createArubaApiBatch(client, documents, {
          id: 1,
          canApprove: true,
          requestId: `test-batch-${startNumber}`,
        }),
      );
      return { batchId, documents };
    }

    async function runNext(expectedType: "aruba_send_submission") {
      await pool.query(
        `UPDATE jobs SET run_at = CASE WHEN type = $1 THEN now()
           ELSE now() + interval '1 day' END
         WHERE status = 'PENDING'`,
        [expectedType],
      );
      const job = await claimJob(`worker-${expectedType}`);
      assert.ok(job);
      assert.equal(job.type, expectedType);
      const result = await outbound.runArubaApiOutboundJob(job);
      return { job, result };
    }

    async function completeNext(expectedType: "aruba_send_submission") {
      const executed = await runNext(expectedType);
      assert.equal(await completeJob(executed.job, executed.result), true);
      return executed.result;
    }

    const massBatch = await createBatch(["ACCETTATO", "RIFIUTO"], 1001);
    assert.equal((await completeNext("aruba_send_submission")).accepted, true);
    assert.equal((await completeNext("aruba_send_submission")).accepted, false);
    const massStatuses = await pool.query<{
      status: string;
      error_message_sanitized: string | null;
    }>(
      `SELECT status, error_message_sanitized FROM aruba_submissions
       WHERE source_filename IN ('FPR_1001_26.xml', 'FPR_1002_26.xml') ORDER BY id`,
    );
    assert.deepEqual(massStatuses.rows, [
      { status: "ARUBA_ACCEPTED", error_message_sanitized: null },
      { status: "SEND_FAILED", error_message_sanitized: "Trasmissione Aruba rifiutata" },
    ]);

    await withTransaction((client) =>
      outbound.createArubaApiBatch(client, [massBatch.documents[0]!], {
        id: 1,
        canApprove: true,
        requestId: "test-duplicate-local-submission",
      }),
    );
    const callsBeforeLocalDuplicate = sendCalls;
    const localDuplicate = await completeNext("aruba_send_submission");
    assert.equal(localDuplicate.errorCode, "ARUBA_SEND_NOT_AUTHORIZED");
    assert.equal(sendCalls, callsBeforeLocalDuplicate);

    await createBatch(["DUPLICATO"], 1003);
    const duplicate = await completeNext("aruba_send_submission");
    assert.equal(duplicate.unknownRemoteState, true);

    await createBatch(["AMBIGUO"], 1004);
    const ambiguous = await completeNext("aruba_send_submission");
    assert.equal(ambiguous.unknownRemoteState, true);

    await createBatch(["RIPROVA"], 1005);
    const firstRetry = await runNext("aruba_send_submission");
    assert.equal(firstRetry.result.continuationPending, true);
    assert.equal(await yieldJob(firstRetry.job, firstRetry.result, 0), true);
    assert.equal((await completeNext("aruba_send_submission")).accepted, true);
    assert.equal(sendAttempts.get("RIPROVA"), 2);

    await createBatch(["INVALIDO"], 1006);
    const callsBeforeInvalidXml = sendCalls;
    const invalidXml = await completeNext("aruba_send_submission");
    assert.equal(invalidXml.errorCode, "UNKNOWN");
    assert.equal(sendCalls, callsBeforeInvalidXml);

    await createBatch(["INVENTARIO"], 1007);
    await pool.query(
      `UPDATE aruba_sync_runs SET completed_at = now() - interval '5 hours',
         full_scan_completed_at = now() - interval '5 hours'
       WHERE id = '00000000-0000-4000-8000-000000000070'`,
    );
    const callsBeforeStaleInventory = sendCalls;
    const staleInventory = await completeNext("aruba_send_submission");
    assert.equal(staleInventory.errorCode, "ARUBA_INVENTORY_BLOCKED");
    assert.equal(sendCalls, callsBeforeStaleInventory);
    await pool.query(
      `UPDATE aruba_sync_runs SET completed_at = now(), full_scan_completed_at = now()
       WHERE id = '00000000-0000-4000-8000-000000000070'`,
    );

    await createBatch(["BLOCCATO"], 1008);
    getConfig().ARUBA_SUBMISSION_ENABLED = false;
    const callsBeforeBlocked = sendCalls;
    const blocked = await completeNext("aruba_send_submission");
    assert.equal(blocked.errorCode, "ARUBA_SEND_NOT_AUTHORIZED");
    assert.equal(sendCalls, callsBeforeBlocked);
    getConfig().ARUBA_SUBMISSION_ENABLED = true;

    await createBatch(["LEASEPERSA"], 1009);
    const callsBeforeLostLease = sendCalls;
    await assert.rejects(
      () => runNext("aruba_send_submission"),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "CONFLICT_REVISION",
    );
    assert.equal(sendCalls, callsBeforeLostLease + 1);
    assert.equal(sendAttempts.get("LEASEPERSA"), 1);

    await createBatch(["RECOVERY"], 1010);
    const recoveryJob = await claimJob("worker-recovery");
    assert.ok(recoveryJob);
    assert.equal(recoveryJob.type, "aruba_send_submission");
    const recoverySubmissionId = String(recoveryJob.payload.submissionId);
    await pool.query(
      `INSERT INTO aruba_submission_attempts
        (id, submission_id, operation, attempt_number, request_fingerprint,
         xml_sha256, status, started_at)
       SELECT '00000000-0000-4000-8000-000000000071', id, 'SEND', 1, repeat('d', 64),
              xml_sha256, 'RUNNING', now()
       FROM aruba_submissions WHERE id = $1`,
      [recoverySubmissionId],
    );
    const callsBeforeRecovery = sendCalls;
    const recovered = await outbound.runArubaApiOutboundJob(recoveryJob);
    assert.equal(recovered.unknownRemoteState, true);
    assert.equal(sendCalls, callsBeforeRecovery);
    assert.equal(await completeJob(recoveryJob, recovered), true);

    await createBatch(["NUMERODOPPIO"], 1011);
    await pool.query(
      `INSERT INTO aruba_remote_documents
         (environment, account_reference, remote_id, document_type, fiscal_year, series,
          fiscal_number, document_date, total_amount, remote_status,
          remote_status_observed_at, metadata_digest, automatic_source, provider_group_id)
       VALUES ('MOCK', 'synthetic-aruba-account', 'existing-fiscal-number', 'TD01', 2026,
         'FPR', '1011', '2026-09-03', 10000, 'DELIVERED', now(), repeat('e', 64),
         'API', 'existing-fiscal-number')`,
    );
    const callsBeforeDuplicateNumber = sendCalls;
    const duplicateNumber = await completeNext("aruba_send_submission");
    assert.equal(duplicateNumber.errorCode, "ARUBA_SEND_NOT_AUTHORIZED");
    assert.equal(sendCalls, callsBeforeDuplicateNumber);

    const uncertain = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM aruba_submissions
       WHERE status = 'UNKNOWN_REMOTE_STATE' AND next_readback_at IS NOT NULL`,
    );
    assert.equal(uncertain.rows[0]!.count, 3);
    const unknownAudits = await pool.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM audit_events WHERE action = 'ARUBA_API_SEND_UNKNOWN'",
    );
    assert.equal(unknownAudits.rows[0]!.count, 3);
    assert.equal(sendCalls, 7);

    connection.invalidateConfiguredArubaApiSession();
    await closePool();
  } finally {
    globalThis.fetch = originalFetch;
    await import("./client.server.ts").then(({ closePool }) => closePool());
    await database.drop();
    await rm(storageRoot, { recursive: true, force: true });
  }
});
