import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AppError } from "../errors.ts";
import {
  closePool,
  getPool,
  registerJoinedTransactionFile,
  withJoinedTransaction,
} from "./client.server.ts";
import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";
import { signedXml } from "../../tests/p7m-fixture.ts";

function response(value: unknown) {
  return Response.json(value);
}

test("l’inbound API cifra la credenziale e completa un backfill shadow riprendibile", async () => {
  const database = await temporaryDatabase("aruba_api_inbound");
  const originalFetch = globalThis.fetch;
  let pageTwoAttempts = 0;
  let pauseAfterSearch: (() => Promise<void>) | null = null;
  const targetedGroupRequests: string[] = [];
  process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
  process.env.APP_BASE_URL = "http://localhost:8080";
  process.env.APP_ENV = "test";
  process.env.ARUBA_ACCOUNT_REFERENCE = "synthetic-aruba-account";
  process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64url");
  process.env.DATABASE_URL = database.connectionString;
  try {
    await runMigrations({ connectionString: database.connectionString });
    const legacyP7mRunId = "30000000-0000-4000-8000-000000000039";
    const legacyBackfillRunId = "30000000-0000-4000-8000-000000000038";
    await getPool().query(
      `INSERT INTO aruba_sync_runs
        (id, environment, api_environment, account_reference, kind, authority_mode, status,
         window_start, window_end, checkpoint_start, checkpoint_end, lease_expires_at,
         completed_at)
       VALUES
         ($1, 'MOCK', 'DEMO', 'legacy-p7m-account', 'BACKFILL', 'SHADOW', 'COMPLETED',
           '2018-01-01', '2019-01-01', '2018-01-01', '2019-01-01', now(), now()),
         ($2, 'MOCK', 'DEMO', 'legacy-p7m-account', 'FULL', 'SHADOW', 'COMPLETED',
           '2019-01-01', '2019-01-03', '2019-01-01', '2019-01-02', now(), now())`,
      [legacyBackfillRunId, legacyP7mRunId],
    );
    await getPool().query(
      `INSERT INTO aruba_api_shadow_documents
        (sync_run_id, provider_group_id, remote_key, document_type, fiscal_year,
         document_date, total_amount, remote_status, p7m_sha256)
       VALUES ($1, 'legacy-p7m-group', 'legacy-p7m-document', 'TD01', 2019,
         '2019-01-01', 100, 'DELIVERED', repeat('a', 64))`,
      [legacyP7mRunId],
    );
    await getPool().query(
      "DELETE FROM schema_migrations WHERE name = '039_aruba_p7m_parity_normalization.sql'",
    );
    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      "039_aruba_p7m_parity_normalization.sql",
    ]);
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT id, status FROM aruba_sync_runs
           WHERE id IN ($1, $2) ORDER BY id`,
          [legacyBackfillRunId, legacyP7mRunId],
        )
      ).rows,
      [
        { id: legacyBackfillRunId, status: "CANCELLED" },
        { id: legacyP7mRunId, status: "CANCELLED" },
      ],
    );
    await getPool().query("DELETE FROM aruba_sync_runs WHERE id IN ($1, $2)", [
      legacyBackfillRunId,
      legacyP7mRunId,
    ]);
    const shadowInvoiceXml = await readFile(
      "tests/fixtures/fatturapa/accepted-invoice.anonymized.xml",
    );
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/signin") {
        return response({ access_token: "token-sintetico", expires_in: 1800 });
      }
      if (url.pathname === "/auth/userInfo") {
        return response({
          username: "utente-sintetico",
          vatCode: "00000000000",
          fiscalCode: null,
          accountStatus: { expired: false, expirationDate: null },
        });
      }
      if (url.pathname === "/api/v2/invoices-out/detail") {
        const groupId = url.searchParams.get("id");
        targetedGroupRequests.push(groupId ?? "");
        return response({
          channelGroup: 1,
          shopName: null,
          invoices: [
            {
              invoiceDate: "2019-01-01T02:30:00.000Z",
              number: "FPR-TARGET-1",
              documentType: "TD01",
              status: "Presa in carico",
              statusDescription: null,
              totalDocument: "100.00",
              totalVat: "22.00",
              netPayable: "100.00",
            },
          ],
          sdiErrors: [],
          id: groupId,
          sender: {
            description: "Mittente sintetico",
            countryCode: "IT",
            vatCode: "00000000000",
            fiscalCode: null,
          },
          receiver: {
            description: "Destinatario sintetico",
            countryCode: null,
            vatCode: "11111111111",
            fiscalCode: null,
          },
          invoiceType: "FPR12",
          docType: "out",
          file: shadowInvoiceXml.toString("base64"),
          filename: "IT00000000000_TARGET.xml",
          username: "utente-sintetico",
          creationDate: "2019-01-01T02:30:00.000Z",
          lastUpdate: "2019-01-01T02:31:00.000Z",
          idSdi: null,
          pdfFile: null,
          pddAvailable: false,
        });
      }
      if (url.pathname === "/api/v2/invoices-out/notifications") {
        const groupId = url.searchParams.get("id");
        return response({
          count: 1,
          notifications: [
            {
              date: "2019-01-01T02:32:00.000Z",
              docType: "RC",
              filename: "IT00000000000_TARGET_RC.xml",
              invoiceId: groupId,
              notificationDate: "",
              number: "FPR-TARGET-1",
              result: null,
              file: Buffer.from("notifica sintetica").toString("base64"),
            },
          ],
        });
      }
      assert.equal(url.pathname, "/api/v2/invoices-out");
      const pause = pauseAfterSearch;
      pauseAfterSearch = null;
      if (pause) await pause();
      const page = Number(url.searchParams.get("page"));
      if (page === 2 && pageTwoAttempts++ === 0) {
        return new Response(null, { status: 429 });
      }
      const groups = Array.from({ length: page === 1 ? 10 : 1 }, (_, index) => ({
        id: `gruppo-vuoto-sintetico-${page}-${index}`,
        invoices: [],
        invoiceType: "FPR12",
        docType: "out",
        filename: `IT00000000000_VUOTO_${page}_${index}.xml.p7m`,
        idSdi: null,
        pddAvailable: false,
        file: null,
      }));
      return response({
        content: groups,
        first: page === 1,
        last: page === 2,
        number: page,
        numberOfElements: groups.length,
        size: 10,
        totalElements: 11,
        totalPages: 2,
      });
    };
    const api = await import("./aruba-api-inbound.server.ts");
    await assert.rejects(
      api.validatedArubaApiParityFileHash({
        kind: "ARUBA_P7M",
        filename: "non-fiscale.xml.p7m",
        bytes: signedXml(Buffer.from("<DocumentoNonFiscale />")),
        sha256: "0".repeat(64),
        providerGroupId: "gruppo-non-fiscale",
      }),
      (error) => error instanceof AppError && error.code === "ARUBA_INVENTORY_INVALID",
    );
    const historicalNumberingXml = Buffer.from(
      shadowInvoiceXml
        .toString("utf8")
        .replace("<Numero>FPR 0001/26</Numero>", "<Numero>STORICO-2019</Numero>"),
    );
    assert.match(historicalNumberingXml.toString("utf8"), /<Numero>STORICO-2019<\/Numero>/);
    assert.equal(
      await api.validatedArubaApiParityFileHash({
        kind: "ARUBA_P7M",
        filename: "storico-valido.xml.p7m",
        bytes: signedXml(historicalNumberingXml),
        sha256: "0".repeat(64),
        providerGroupId: "gruppo-storico-valido",
      }),
      createHash("sha256").update(historicalNumberingXml).digest("hex"),
    );
    const jobs = await import("./connectors.server.ts");
    const owner = { id: 1, canApprove: true, requestId: "aruba-api-owner-test" };
    const codex = { id: 2, canApprove: false, requestId: "aruba-api-codex-test" };
    await api.saveArubaApiCredentials(
      {
        apiEnvironment: "DEMO",
        username: "utente-sintetico",
        password: "password-sintetica",
        expectedTaxId: "00000000000",
      },
      owner,
    );
    await assert.rejects(
      api.saveArubaApiCredentials(
        {
          apiEnvironment: "DEMO",
          username: "utente-sintetico",
          password: "password-sintetica-ruotata",
          expectedTaxId: "00000000000",
        },
        owner,
      ),
      (error) => error instanceof AppError && error.code === "ARUBA_API_COOLDOWN_ACTIVE",
    );
    const stored = await getPool().query<{
      encrypted_credentials: string;
      status: string;
      api_paused: boolean;
      inbound_enabled: boolean;
      automatic_authority: string;
    }>("SELECT * FROM connections WHERE provider = 'ARUBA'");
    assert.equal(stored.rows[0]!.encrypted_credentials.includes("password-sintetica"), false);
    assert.deepEqual(
      {
        status: stored.rows[0]!.status,
        paused: stored.rows[0]!.api_paused,
        enabled: stored.rows[0]!.inbound_enabled,
        authority: stored.rows[0]!.automatic_authority,
      },
      { status: "PAUSED", paused: true, enabled: false, authority: "BROWSER" },
    );
    assert.equal((await api.getArubaApiConnectionStatus()).configured, true);
    assert.deepEqual(await api.getArubaApiCredentialIdentity(owner), {
      username: "utente-sintetico",
      expectedTaxId: "00000000000",
    });
    await assert.rejects(
      api.getArubaApiCredentialIdentity(codex),
      (error) => error instanceof AppError && error.code === "ARUBA_OPERATION_FORBIDDEN",
    );
    await assert.rejects(
      api.setArubaApiControls({ apiPaused: false, inboundEnabled: true }, codex),
      (error) => error instanceof AppError && error.code === "ARUBA_OPERATION_FORBIDDEN",
    );
    await api.setArubaApiControls({ apiPaused: false, inboundEnabled: true }, owner);
    await getPool().query(
      `INSERT INTO aruba_sync_sessions
        (id, environment, account_reference, device_id, token_hash, status,
         absolute_expires_at, completed_at, full_scan_completed_at, is_full_scan)
       VALUES ('10000000-0000-4000-8000-000000000001', 'MOCK',
         'synthetic-aruba-account', 'synthetic-api-baseline', repeat('a', 64), 'COMPLETED',
         now() + interval '1 hour', now(), now(), true)`,
    );
    const health = await import("./aruba-inventory-health.server.ts");
    assert.equal((await health.getArubaInventoryHealth()).status, "HEALTHY");
    await getPool().query(
      `UPDATE aruba_sync_sessions SET completed_at = now() - interval '31 minutes',
         full_scan_completed_at = now() - interval '31 minutes'`,
    );
    assert.equal((await health.getArubaInventoryHealth()).status, "WARNING");
    await getPool().query(
      `UPDATE aruba_sync_sessions SET completed_at = now() - interval '241 minutes',
         full_scan_completed_at = now() - interval '241 minutes'`,
    );
    const stale = await health.getArubaInventoryHealth();
    assert.equal(stale.status, "BLOCKED");
    assert.equal(stale.blockingReason, "STALE");
    await getPool().query(
      `UPDATE aruba_sync_sessions SET completed_at = now(), full_scan_completed_at = now()`,
    );
    assert.deepEqual(await api.requestArubaApiSync(codex), {
      queued: true,
      jobId: "1",
    });
    await getPool().query("UPDATE jobs SET run_at = now() WHERE id = 1");
    const job = await jobs.claimJob("aruba-api-test-worker");
    assert.equal(job?.type, "aruba_backfill_inventory");
    const runOptions = { rateDelayMs: 0, now: new Date("2019-01-01T01:00:00.000Z") };
    await assert.rejects(
      api.runArubaApiInboundJob(job!, runOptions),
      (error) => error instanceof AppError && error.code === "PROVIDER_RATE_LIMITED",
    );
    assert.equal((await api.getArubaApiConnectionStatus()).limits.cooldownUntil !== null, true);
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT scope, cooldown_until > now() AS cooling_down, rate_limited_count
           FROM aruba_api_traffic_limits ORDER BY scope`,
        )
      ).rows,
      [
        { scope: "INVOICE_READ", cooling_down: true, rate_limited_count: 1 },
        { scope: "NOTIFICATION_READ", cooling_down: true, rate_limited_count: 1 },
      ],
    );
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT status, checkpoint_page, page_count, group_count, request_count
           FROM aruba_sync_runs`,
        )
      ).rows[0],
      {
        status: "RUNNING",
        checkpoint_page: 2,
        page_count: 1,
        group_count: 10,
        request_count: 4,
      },
    );
    await getPool().query("UPDATE aruba_sync_runs SET request_limit = request_count");
    await assert.rejects(
      api.runArubaApiInboundJob(job!, runOptions),
      (error) => error instanceof AppError && error.code === "ARUBA_API_BUDGET_EXHAUSTED",
    );
    assert.equal(
      (await getPool().query("SELECT status FROM aruba_sync_runs")).rows[0].status,
      "INCOMPLETE",
    );
    assert.equal(await jobs.failJob(job!, "ARUBA_API_BUDGET_EXHAUSTED"), false);
    const browserDocument = await getPool().query<{ id: string }>(
      `INSERT INTO aruba_remote_documents
        (environment, account_reference, remote_id, document_type, fiscal_year, series,
         fiscal_number, document_date, total_amount, remote_status, remote_status_observed_at,
         last_full_scan_at, metadata_digest)
       VALUES ('MOCK', 'synthetic-aruba-account', 'browser-parity-2019', 'TD01', 2019,
         'FPR', '1', '2019-01-01', 10000, 'DELIVERED', now(), now(), repeat('b', 64))
       RETURNING id`,
    );
    const browserFile = await getPool().query<{ id: string }>(
      `INSERT INTO storage_objects (kind, relative_path, sha256, size_bytes, content_type)
       VALUES ('ARUBA_XML', 'aruba/parity-2019.xml', repeat('c', 64), 100, 'application/xml')
      RETURNING id`,
    );
    const sharedBrowserFile = await getPool().query<{ id: string }>(
      `INSERT INTO storage_objects (kind, relative_path, sha256, size_bytes, content_type)
       VALUES ('ARUBA_XML', 'aruba/parity-2019-shared.xml', repeat('c', 64), 100,
         'application/xml') RETURNING id`,
    );
    await getPool().query(
      `INSERT INTO aruba_remote_documents
        (environment, account_reference, remote_id, document_type, fiscal_year, series,
         fiscal_number, document_date, total_amount, remote_status, remote_status_observed_at,
         last_full_scan_at, metadata_digest)
       VALUES ('MOCK', 'synthetic-aruba-account', 'browser-session-successiva-2019', 'TD01',
         2019, 'FPR', '2', '2019-01-02', 20000, 'DELIVERED', now(), now(), repeat('f', 64))`,
    );
    await getPool().query(
      `INSERT INTO aruba_files (remote_document_id, storage_object_id, kind)
       VALUES ($1, $2, 'ARUBA_XML'),
         ((SELECT id FROM aruba_remote_documents
           WHERE remote_id = 'browser-session-successiva-2019'), $3, 'ARUBA_XML')`,
      [browserDocument.rows[0]!.id, browserFile.rows[0]!.id, sharedBrowserFile.rows[0]!.id],
    );
    await getPool().query(
      `INSERT INTO aruba_sync_pages
        (sync_session_id, stream, scan_ordinal, page_ordinal, terminal, full_scan,
         row_count, documents_json, payload_digest)
       VALUES
         ('10000000-0000-4000-8000-000000000001', 'invoices:2019', 1, 1,
          true, true, 1, jsonb_build_array(jsonb_build_object(
            'remoteId', 'browser-parity-2019', 'documentType', 'TD01', 'fiscalYear', 2019,
            'series', 'FPR', 'fiscalNumber', '1', 'documentDate', '2019-01-01',
            'totalAmount', 10000, 'status', 'DELIVERED', 'xmlSha256', null
          )), repeat('d', 64)),
         ('10000000-0000-4000-8000-000000000001', 'invoices:2019', 2, 1,
          true, true, 2, jsonb_build_array(jsonb_build_object(
            'remoteId', 'browser-parity-2019', 'documentType', 'TD01', 'fiscalYear', 2019,
            'series', 'FPR', 'fiscalNumber', '1', 'documentDate', '2019-01-01',
            'totalAmount', 10000, 'status', 'DELIVERED', 'xmlSha256', null
          ), jsonb_build_object(
            'remoteId', 'browser-session-successiva-2019', 'documentType', 'TD01',
            'fiscalYear', 2019, 'series', 'FPR', 'fiscalNumber', '2',
            'documentDate', '2019-01-02', 'totalAmount', 20000, 'status', 'DELIVERED',
            'xmlSha256', null
          )), repeat('e', 64))`,
    );
    await getPool().query(
      `INSERT INTO aruba_api_shadow_documents
        (sync_run_id, provider_group_id, remote_key, document_type, fiscal_year,
         series, fiscal_number, document_date, total_amount, remote_status, xml_sha256)
       SELECT id, 'api-parity-group-2019', 'api-parity-2019-2', 'TD01', 2019,
         'FPR', '2', '2019-01-02', 20000, 'DELIVERED', NULL
       FROM aruba_sync_runs WHERE status = 'INCOMPLETE'`,
    );
    await getPool().query(
      `INSERT INTO aruba_api_shadow_documents
        (sync_run_id, provider_group_id, remote_key, document_type, fiscal_year,
         series, fiscal_number, document_date, total_amount, remote_status, xml_sha256)
       SELECT id, 'api-parity-group-2019', 'api-parity-2019', 'TD01', 2019,
         'FPR', '1', '2019-01-01', 10000, 'DELIVERED', NULL
       FROM aruba_sync_runs WHERE status = 'INCOMPLETE'`,
    );
    await getPool().query(
      `INSERT INTO aruba_api_shadow_group_files
        (sync_run_id, provider_group_id, kind, sha256)
       SELECT id, 'api-parity-group-2019', 'ARUBA_XML', repeat('c', 64)
       FROM aruba_sync_runs WHERE status = 'INCOMPLETE'`,
    );
    await getPool().query(
      `INSERT INTO aruba_api_shadow_documents
        (sync_run_id, provider_group_id, remote_key, document_type, fiscal_year,
         series, fiscal_number, document_date, total_amount, remote_status, xml_sha256)
       SELECT id, 'api-history-group-2018', 'api-history-2018', 'TD01', 2018,
         'FPR', '1', '2018-01-01', 5000, 'DELIVERED', repeat('e', 64)
       FROM aruba_sync_runs WHERE status = 'INCOMPLETE'`,
    );
    const continuedJob = await jobs.claimJob("aruba-api-continuation-worker");
    assert.equal(continuedJob?.id, job?.id);
    const result = await api.runArubaApiInboundJob(continuedJob!, runOptions);
    assert.equal(result.mode, "SHADOW");
    assert.equal(result.documents, 0);
    assert.equal(await jobs.completeJob(continuedJob!, result), true);
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT status, authority_mode, page_count, group_count, document_count,
                  request_count, request_limit,
                  continued_from_run_id IS NOT NULL AS continued
           FROM aruba_sync_runs ORDER BY started_at, id`,
        )
      ).rows,
      [
        {
          status: "INCOMPLETE",
          authority_mode: "SHADOW",
          page_count: 1,
          group_count: 10,
          document_count: 0,
          request_count: 4,
          request_limit: 4,
          continued: false,
        },
        {
          status: "COMPLETED",
          authority_mode: "SHADOW",
          page_count: 2,
          group_count: 11,
          document_count: 0,
          request_count: 1,
          request_limit: 10000,
          continued: true,
        },
      ],
    );
    const failedRunId = "30000000-0000-4000-8000-000000000040";
    await getPool().query(
      `INSERT INTO aruba_sync_runs
        (id, environment, api_environment, account_reference, kind, authority_mode, status,
         window_start, window_end, checkpoint_start, checkpoint_end, checkpoint_page,
         page_count, group_count, request_count, request_limit, lease_expires_at,
         last_error_code, last_error_message_sanitized)
       VALUES ($1, 'MOCK', 'DEMO', 'synthetic-aruba-account', 'FULL', 'SHADOW', 'FAILED',
         '2019-01-01', '2019-01-05', '2019-01-03', '2019-01-05', 2,
         1, 10, 12, 10000, now(), 'PROVIDER_RESPONSE_INVALID',
         'Sincronizzazione API Aruba interrotta')`,
      [failedRunId],
    );
    const failedJob = await getPool().query<{ id: string }>(
      `INSERT INTO jobs (type, status, payload_json, run_at)
       VALUES ('aruba_full_inventory', 'PENDING', '{}', now()) RETURNING id`,
    );
    const retriedFailedJob = await jobs.claimJob("aruba-api-failed-continuation-worker");
    assert.equal(retriedFailedJob?.id, failedJob.rows[0]!.id);
    const retriedFailedResult = await api.runArubaApiInboundJob(retriedFailedJob!, runOptions);
    assert.equal(await jobs.completeJob(retriedFailedJob!, retriedFailedResult), true);
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT continued_from_run_id, status, checkpoint_start, checkpoint_page,
                  page_count, group_count, request_count
           FROM aruba_sync_runs WHERE continued_from_run_id = $1`,
          [failedRunId],
        )
      ).rows,
      [
        {
          continued_from_run_id: failedRunId,
          status: "COMPLETED",
          checkpoint_start: new Date("2019-01-03T00:00:00.000Z"),
          checkpoint_page: 1,
          page_count: 2,
          group_count: 11,
          request_count: 1,
        },
      ],
    );
    await getPool().query(
      `DELETE FROM aruba_inbound_parity_dossiers
       WHERE sync_run_id IN (
         SELECT id FROM aruba_sync_runs WHERE continued_from_run_id = $1
       )`,
      [failedRunId],
    );
    await getPool().query("DELETE FROM aruba_sync_runs WHERE continued_from_run_id = $1", [
      failedRunId,
    ]);
    await getPool().query("DELETE FROM aruba_sync_runs WHERE id = $1", [failedRunId]);
    assert.equal((await api.getArubaInboundClosureReadiness()).gates.PARITY_MATCHED, true);
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT status, api_documents, browser_documents, matched_documents,
                  missing_in_api, missing_in_browser, status_mismatches, file_mismatches,
                  summary_json->'populationStreams' AS population_streams,
                  summary_json->'apiFileCoverage' AS api_file_coverage,
                  (summary_json->>'browserBaselineScanOrdinal')::int AS browser_scan_ordinal,
                  (summary_json->>'unresolvedBrowserConflicts')::int AS browser_conflicts
           FROM aruba_inbound_parity_dossiers`,
        )
      ).rows,
      [
        {
          status: "MATCHED",
          api_documents: 2,
          browser_documents: 2,
          matched_documents: 2,
          missing_in_api: 0,
          missing_in_browser: 0,
          status_mismatches: 0,
          file_mismatches: 0,
          population_streams: ["invoices:2019"],
          api_file_coverage: { notifications: 0, p7m: 0, pdf: 0, xml: 2 },
          browser_scan_ordinal: 2,
          browser_conflicts: 0,
        },
      ],
    );
    await getPool().query(
      `UPDATE aruba_api_shadow_documents
       SET notification_hashes = jsonb_build_array(repeat('6', 64))
       WHERE sync_run_id = (
         SELECT id FROM aruba_sync_runs WHERE kind = 'BACKFILL' AND status = 'COMPLETED'
         ORDER BY completed_at DESC LIMIT 1
       )`,
    );
    await getPool().query(
      `UPDATE aruba_api_shadow_documents SET remote_status = 'SDI_PROCESSING',
         notification_hashes = '[]'
       WHERE sync_run_id = (
         SELECT id FROM aruba_sync_runs WHERE kind = 'BACKFILL' AND status = 'COMPLETED'
         ORDER BY completed_at DESC LIMIT 1
       ) AND remote_key = 'api-parity-2019'`,
    );
    assert.equal((await api.getArubaInboundClosureReadiness()).gates.NOTIFICATIONS_VERIFIED, true);
    await getPool().query(
      `UPDATE aruba_api_shadow_documents SET remote_status = 'DELIVERED',
         notification_hashes = '[]'
       WHERE sync_run_id = (
         SELECT id FROM aruba_sync_runs WHERE kind = 'BACKFILL' AND status = 'COMPLETED'
         ORDER BY completed_at DESC LIMIT 1
       )`,
    );
    const pausedRequest = await api.requestArubaApiSync(owner);
    assert.equal(pausedRequest.queued, true);
    await getPool().query("UPDATE jobs SET run_at = now() WHERE id = $1", [pausedRequest.jobId]);
    const pausedJob = await jobs.claimJob("aruba-api-paused-worker");
    assert.equal(pausedJob?.type, "aruba_sync_inventory");
    pauseAfterSearch = async () => {
      await api.setArubaApiControls({ apiPaused: true, inboundEnabled: true }, owner);
    };
    const stopped = await api.runArubaApiInboundJob(pausedJob!, {
      rateDelayMs: 0,
      now: new Date("2019-01-01T02:00:00.000Z"),
    });
    assert.equal(stopped.stopped, true);
    assert.equal(await jobs.completeJob(pausedJob!, stopped), true);
    assert.equal(
      (
        await getPool().query(
          `SELECT status FROM aruba_sync_runs
           WHERE kind = 'INCREMENTAL' ORDER BY started_at DESC LIMIT 1`,
        )
      ).rows[0].status,
      "CANCELLED",
    );
    await api.setArubaApiControls({ apiPaused: false, inboundEnabled: true }, owner);
    const resumedRequest = await api.requestArubaApiSync(owner);
    assert.equal(resumedRequest.queued, true);
    await getPool().query("UPDATE jobs SET run_at = now() WHERE id = $1", [resumedRequest.jobId]);
    const resumedJob = await jobs.claimJob("aruba-api-resumed-worker");
    assert.equal(resumedJob?.type, "aruba_sync_inventory");
    const resumed = await api.runArubaApiInboundJob(resumedJob!, {
      rateDelayMs: 0,
      now: new Date("2019-01-01T03:00:00.000Z"),
    });
    assert.equal(resumed.stopped, undefined);
    assert.equal(await jobs.completeJob(resumedJob!, resumed), true);
    assert.equal(
      (
        await getPool().query(
          `SELECT status FROM aruba_sync_runs
           WHERE kind = 'INCREMENTAL' ORDER BY started_at DESC LIMIT 1`,
        )
      ).rows[0].status,
      "COMPLETED",
    );
    const parityRefresh = await api.requestArubaApiSync(owner);
    assert.equal(parityRefresh.queued, true);
    assert.equal(
      (await getPool().query("SELECT type FROM jobs WHERE id = $1", [parityRefresh.jobId])).rows[0]
        .type,
      "aruba_full_inventory",
    );
    await getPool().query("DELETE FROM jobs WHERE id = $1", [parityRefresh.jobId]);
    assert.equal((await api.getArubaInboundClosureReadiness()).gates.PARITY_MATCHED, false);
    await getPool().query(
      `INSERT INTO aruba_remote_documents
        (environment, account_reference, remote_id, document_type, fiscal_year,
         document_date, total_amount, remote_status, remote_status_observed_at,
         metadata_digest)
       VALUES ('MOCK', 'synthetic-aruba-account', 'browser-aperto-sintetico', 'TD01',
         2019, '2019-01-01', 10000, 'SDI_PROCESSING', now(), repeat('d', 64))`,
    );
    await getPool().query(
      `INSERT INTO aruba_api_shadow_documents
        (sync_run_id, provider_group_id, remote_key, document_type, fiscal_year,
         document_date, total_amount, remote_status)
       SELECT id, 'gruppo-shadow-aperto', 'shadow-aperto-sintetico', 'TD01', 2019,
         '2019-01-01', 10000, 'SDI_PROCESSING'
       FROM aruba_sync_runs
       WHERE kind = 'INCREMENTAL' AND status = 'COMPLETED'
       ORDER BY completed_at DESC LIMIT 1`,
    );
    await getPool().query(
      `UPDATE jobs SET completed_at = now() - interval '16 minutes'
       WHERE status = 'COMPLETED'`,
    );
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT provider_group_id, remote_status
           FROM aruba_api_latest_shadow_documents
           WHERE environment = 'MOCK' AND account_reference = 'synthetic-aruba-account'
             AND remote_status = 'SDI_PROCESSING'`,
        )
      ).rows,
      [{ provider_group_id: "gruppo-shadow-aperto", remote_status: "SDI_PROCESSING" }],
    );
    await jobs.scheduleDueSyncs();
    assert.deepEqual(
      (await getPool().query(`SELECT type FROM jobs WHERE status = 'PENDING' ORDER BY id`)).rows,
      [{ type: "aruba_refresh_nonterminal" }],
    );
    await getPool().query(
      `UPDATE jobs SET run_at = now()
       WHERE type = 'aruba_refresh_nonterminal' AND status = 'PENDING'`,
    );
    const targetedJob = await jobs.claimJob("aruba-api-targeted-worker");
    assert.equal(targetedJob?.type, "aruba_refresh_nonterminal");
    const targeted = await api.runArubaApiInboundJob(targetedJob!, {
      rateDelayMs: 0,
      now: new Date("2019-01-01T04:00:00.000Z"),
    });
    assert.equal(targeted.documents, 1);
    assert.deepEqual(targetedGroupRequests, ["gruppo-shadow-aperto"]);
    assert.equal(await jobs.completeJob(targetedJob!, targeted), true);
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT document_count, file_count, notification_count
           FROM aruba_sync_runs WHERE kind = 'TARGETED'
           ORDER BY started_at DESC LIMIT 1`,
        )
      ).rows[0],
      { document_count: 1, file_count: 2, notification_count: 1 },
    );
    await assert.rejects(
      api.promoteArubaApiAuthority({ fallbackDecision: "KEEP_TRANSITIONAL_FALLBACK" }, codex),
      (error) => error instanceof AppError && error.code === "ARUBA_OPERATION_FORBIDDEN",
    );
    assert.equal((await api.getArubaInboundClosureReadiness()).readyForAuthoritySwitch, false);
    await getPool().query(
      `UPDATE aruba_api_shadow_documents
       SET notification_hashes = jsonb_build_array(repeat('8', 64))
       WHERE sync_run_id = (
         SELECT id FROM aruba_sync_runs
         WHERE kind = 'BACKFILL' AND status = 'COMPLETED'
         ORDER BY completed_at DESC LIMIT 1
       )`,
    );
    await getPool().query("UPDATE aruba_api_traffic_limits SET cooldown_until = NULL");
    const staleApiDossier = await api.getArubaInboundClosureReadiness();
    assert.equal(staleApiDossier.readyForAuthoritySwitch, false);
    assert.equal(staleApiDossier.blockers.includes("PARITY_MATCHED"), true);
    await getPool().query(
      `UPDATE aruba_sync_runs SET status = 'CANCELLED'
       WHERE authority_mode = 'SHADOW' AND status = 'COMPLETED'
         AND kind IN ('INCREMENTAL', 'TARGETED')`,
    );
    const pdfOptionalReadiness = await api.getArubaInboundClosureReadiness();
    assert.deepEqual(pdfOptionalReadiness.blockers, []);
    assert.equal(pdfOptionalReadiness.readyForAuthoritySwitch, true);
    assert.equal(
      (
        await getPool().query(
          `SELECT count(*)::int AS count FROM aruba_api_shadow_documents
           WHERE pdf_sha256 IS NULL`,
        )
      ).rows[0].count > 0,
      true,
    );
    const newerBrowserSessionId = "10000000-0000-4000-8000-000000000002";
    await getPool().query(
      `INSERT INTO aruba_sync_sessions
        (id, environment, account_reference, device_id, token_hash, status,
         absolute_expires_at, completed_at, full_scan_completed_at, is_full_scan)
       VALUES ($1, 'MOCK', 'synthetic-aruba-account', 'newer-browser-baseline', repeat('9', 64),
         'COMPLETED', now() + interval '1 hour', now() + interval '1 minute',
         now() + interval '1 minute', true)`,
      [newerBrowserSessionId],
    );
    await getPool().query(
      `INSERT INTO aruba_sync_pages
        (sync_session_id, stream, scan_ordinal, page_ordinal, terminal, full_scan,
         row_count, documents_json, payload_digest)
       VALUES ($1, 'invoices:2019', 1, 1, true, true, 0, '[]', repeat('9', 64))`,
      [newerBrowserSessionId],
    );
    const staleDossier = await api.getArubaInboundClosureReadiness();
    assert.equal(staleDossier.readyForAuthoritySwitch, false);
    assert.equal(staleDossier.blockers.includes("BROWSER_BASELINE_CURRENT"), true);
    await getPool().query("DELETE FROM aruba_sync_sessions WHERE id = $1", [newerBrowserSessionId]);
    assert.equal((await api.getArubaInboundClosureReadiness()).readyForAuthoritySwitch, true);
    const activeBrowserSessionId = "10000000-0000-4000-8000-000000000003";
    await getPool().query(
      `INSERT INTO aruba_sync_sessions
        (id, environment, account_reference, device_id, token_hash, status,
         absolute_expires_at, is_full_scan)
       VALUES ($1, 'MOCK', 'synthetic-aruba-account', 'browser-session-active', repeat('7', 64),
         'SCANNING', now() + interval '1 hour', true)`,
      [activeBrowserSessionId],
    );
    assert.equal(
      (await api.getArubaInboundClosureReadiness()).gates.BROWSER_BASELINE_CURRENT,
      false,
    );
    await assert.rejects(
      api.promoteArubaApiAuthority({ fallbackDecision: "KEEP_TRANSITIONAL_FALLBACK" }, owner),
      (error) => error instanceof AppError && error.code === "ARUBA_INVENTORY_BLOCKED",
    );
    await getPool().query("DELETE FROM aruba_sync_sessions WHERE id = $1", [
      activeBrowserSessionId,
    ]);
    assert.equal((await api.getArubaInboundClosureReadiness()).readyForAuthoritySwitch, true);
    await getPool().query(
      `UPDATE aruba_remote_documents SET remote_status = 'SDI_PROCESSING'
       WHERE remote_id = 'browser-parity-2019'`,
    );
    await getPool().query(
      `UPDATE aruba_api_shadow_documents SET remote_status = 'SDI_PROCESSING'
       WHERE remote_key = 'api-parity-2019' AND sync_run_id = (
         SELECT id FROM aruba_sync_runs WHERE kind = 'BACKFILL' AND status = 'COMPLETED'
         ORDER BY completed_at DESC LIMIT 1
       )`,
    );
    assert.deepEqual(
      await api.promoteArubaApiAuthority({ fallbackDecision: "KEEP_TRANSITIONAL_FALLBACK" }, owner),
      {
        automaticAuthority: "API",
        fallbackDecision: "KEEP_TRANSITIONAL_FALLBACK",
      },
    );
    assert.equal(
      (await getPool().query("SELECT count(*)::int AS count FROM aruba_remote_documents")).rows[0]
        .count,
      3,
    );
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT automatic_authority FROM connections WHERE provider = 'ARUBA'`,
        )
      ).rows[0],
      { automatic_authority: "API" },
    );
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT automatic_source, provider_group_id FROM aruba_remote_documents
           WHERE remote_id = 'browser-parity-2019'`,
        )
      ).rows[0],
      { automatic_source: "API", provider_group_id: "api-parity-group-2019" },
    );
    const apiStage = await import("./aruba-api-stage.server.ts");
    const canonicalPage = await import("./aruba-api-canonical-page.server.ts");
    const groupFile = await import("./aruba-api-group-file.server.ts");
    const arubaStorage = await import("./aruba.server.ts");
    let rolledBackFile = "";
    await assert.rejects(
      withJoinedTransaction(async () => {
        const stored = await arubaStorage.storeImportedFile(
          "atomic-rollback",
          "ARUBA_P7M",
          Buffer.from("payload sintetico da eliminare"),
        );
        rolledBackFile = stored.absolutePath;
        throw new AppError("ARUBA_INVENTORY_BLOCKED", 409);
      }),
      (error) => error instanceof AppError && error.code === "ARUBA_INVENTORY_BLOCKED",
    );
    await assert.rejects(
      readFile(rolledBackFile),
      (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
    const stagedRunId = "30000000-0000-4000-8000-000000000099";
    await getPool().query(
      `INSERT INTO aruba_sync_runs
        (id, environment, api_environment, account_reference, kind, authority_mode, status,
         window_start, window_end, checkpoint_start, checkpoint_end, lease_expires_at)
       VALUES ($1, 'MOCK', 'DEMO', 'synthetic-aruba-account', 'INCREMENTAL', 'CANONICAL',
         'RUNNING', '2019-01-01', '2019-01-03', '2019-01-01', '2019-01-03',
         now() + interval '3 minutes')`,
      [stagedRunId],
    );
    const stagedBrowserDocument = await getPool().query<{ id: string }>(
      `INSERT INTO aruba_remote_documents
        (environment, account_reference, remote_id, document_type, fiscal_year, series,
         fiscal_number, document_date, total_amount, remote_status, remote_status_observed_at,
         last_full_scan_at, metadata_digest)
       VALUES ('MOCK', 'synthetic-aruba-account', 'browser-atomic-stage', 'TD01', 2019,
         'FPR', '99', '2019-01-02', 12300, 'DELIVERED', now(), now(), repeat('7', 64))
       RETURNING id`,
    );
    const stagedPage = {
      stream: "api:incremental",
      scanOrdinal: 1,
      pageOrdinal: 1,
      cursor: null,
      terminal: true,
      fullScan: false,
      documents: [
        {
          remoteId: "atomic-stage-synthetic",
          documentType: "TD01" as const,
          fiscalYear: 2019,
          series: "FPR",
          fiscalNumber: "99",
          documentDate: "2019-01-02",
          recipientName: "Destinatario sintetico",
          recipientTaxId: "11111111111",
          recipientTaxIdentifiers: [
            { type: "PARTITA_IVA" as const, countryCode: "IT", value: "11111111111" },
          ],
          recipientCountryCode: "IT",
          recipientAddress: null,
          totalAmount: 12_300,
          currency: "EUR" as const,
          status: "SUBMITTED" as const,
          providerStatusLabel: "Inviata",
          providerInvoiceNumber: "99",
          providerObservedAt: "2019-01-02T12:00:00.000Z",
          xmlSha256: null,
          orderReferences: [],
        },
      ],
    };
    const newDocumentPage = {
      ...stagedPage,
      documents: [
        {
          ...stagedPage.documents[0]!,
          remoteId: "atomic-new-document",
          fiscalNumber: "100",
        },
      ],
    };
    await assert.rejects(
      withJoinedTransaction(async () => {
        const staged = await apiStage.stageApiPage(
          stagedRunId,
          newDocumentPage,
          new Map([["atomic-new-document", "atomic-new-group"]]),
          1,
        );
        await canonicalPage.commitArubaApiInventoryPage(
          stagedRunId,
          newDocumentPage,
          1,
          staged.resolvedDocuments!.map((document) => document.remoteDocumentId),
        );
      }),
      (error) => error instanceof AppError && error.code === "ARUBA_INVENTORY_BLOCKED",
    );
    assert.equal(
      (
        await getPool().query(
          `SELECT count(*)::integer AS count FROM aruba_remote_documents
           WHERE remote_id = 'atomic-new-document'`,
        )
      ).rows[0].count,
      0,
    );
    await assert.rejects(
      withJoinedTransaction(async () => {
        const staged = await apiStage.stageApiPage(
          stagedRunId,
          stagedPage,
          new Map([["atomic-stage-synthetic", "atomic-stage-group"]]),
          1,
        );
        await canonicalPage.commitArubaApiInventoryPage(
          stagedRunId,
          stagedPage,
          1,
          staged.resolvedDocuments!.map((document) => document.remoteDocumentId),
        );
      }),
      (error) => error instanceof AppError && error.code === "ARUBA_INVENTORY_BLOCKED",
    );
    assert.equal(
      (
        await getPool().query(
          `SELECT count(*)::integer AS count FROM aruba_remote_observations
           WHERE sync_run_id = $1 AND payload_json ->> 'remoteId' = 'atomic-stage-synthetic'`,
          [stagedRunId],
        )
      ).rows[0].count,
      0,
    );
    const stagedResult = await apiStage.stageApiPage(
      stagedRunId,
      stagedPage,
      new Map([["atomic-stage-synthetic", "atomic-stage-group"]]),
      1,
    );
    assert.deepEqual(stagedResult.resolvedDocuments, [
      {
        remoteId: "atomic-stage-synthetic",
        remoteDocumentId: stagedBrowserDocument.rows[0]!.id,
      },
    ]);
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT remote_id, remote_status, automatic_source
           FROM aruba_remote_documents WHERE id = $1`,
          [stagedBrowserDocument.rows[0]!.id],
        )
      ).rows[0],
      {
        remote_id: "atomic-stage-synthetic",
        remote_status: "DELIVERED",
        automatic_source: "API",
      },
    );
    assert.equal(
      (
        await getPool().query(
          `SELECT count(*)::integer AS count FROM aruba_deduplication_conflicts
           WHERE sync_run_id = $1`,
          [stagedRunId],
        )
      ).rows[0].count,
      0,
    );
    assert.equal(
      (
        await getPool().query(
          `SELECT count(*)::integer AS count FROM aruba_remote_observations
           WHERE sync_run_id = $1 AND payload_json ->> 'remoteId' = 'atomic-stage-synthetic'`,
          [stagedRunId],
        )
      ).rows[0].count,
      1,
    );
    const inbound = await import("./aruba-inbound.server.ts");
    const mismatchedNotification = Buffer.from(
      "<RicevutaConsegna><NomeFile>documento-diverso.xml</NomeFile></RicevutaConsegna>",
    );
    await assert.rejects(
      inbound.importArubaRemoteOfficialFileFromApi(
        stagedBrowserDocument.rows[0]!.id,
        "SDI_NOTIFICATION",
        mismatchedNotification,
        {
          type: "API",
          runId: stagedRunId,
          providerGroupId: "atomic-stage-group",
          providerFilename: "notifica-errata.xml",
          expectedDocumentFilename: "atomic-stage.xml.p7m",
          expectedInvoiceNumber: "99",
          requiresInvoiceNumber: true,
          notificationInvoiceNumber: "99",
          notificationId: "notifica-errata",
        },
      ),
      (error) => error instanceof AppError && error.code === "ARUBA_INVENTORY_CONFLICT",
    );
    const wrongInvoiceNotification = Buffer.from(
      "<RicevutaConsegna><NomeFile>atomic-stage.xml</NomeFile></RicevutaConsegna>",
    );
    await assert.rejects(
      inbound.importArubaRemoteOfficialFileFromApi(
        stagedBrowserDocument.rows[0]!.id,
        "SDI_NOTIFICATION",
        wrongInvoiceNotification,
        {
          type: "API",
          runId: stagedRunId,
          providerGroupId: "atomic-stage-group",
          providerFilename: "notifica-altra-fattura.xml",
          expectedDocumentFilename: "atomic-stage.xml.p7m",
          expectedInvoiceNumber: "99",
          requiresInvoiceNumber: true,
          notificationInvoiceNumber: "100",
          notificationId: "notifica-altra-fattura",
        },
      ),
      (error) => error instanceof AppError && error.code === "ARUBA_INVENTORY_CONFLICT",
    );
    assert.equal(
      (
        await getPool().query(
          `SELECT count(*)::integer AS count FROM aruba_files
           WHERE remote_document_id = $1 AND kind = 'SDI_NOTIFICATION'`,
          [stagedBrowserDocument.rows[0]!.id],
        )
      ).rows[0].count,
      0,
    );
    await assert.rejects(
      canonicalPage.commitArubaApiInventoryPage(stagedRunId, stagedPage, 1, [
        stagedBrowserDocument.rows[0]!.id,
      ]),
      (error) => error instanceof AppError && error.code === "ARUBA_INVENTORY_BLOCKED",
    );
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT page_count, checkpoint_page FROM aruba_sync_runs WHERE id = $1`,
          [stagedRunId],
        )
      ).rows[0],
      { page_count: 0, checkpoint_page: 1 },
    );
    await assert.rejects(
      groupFile.importArubaApiGroupFile({
        runId: stagedRunId,
        providerGroupId: "atomic-stage-group",
        kind: "ARUBA_P7M",
        filename: "atomic-stage.xml.p7m",
        bytes: signedXml(Buffer.from("<DocumentoNonFiscale />")),
      }),
      (error) => error instanceof AppError && error.code === "ARUBA_INVENTORY_INVALID",
    );
    const acceptedInvoiceXml = await readFile(
      "tests/fixtures/fatturapa/accepted-invoice.anonymized.xml",
    );
    await groupFile.importArubaApiGroupFile({
      runId: stagedRunId,
      providerGroupId: "atomic-stage-group",
      kind: "ARUBA_P7M",
      filename: "atomic-stage.xml.p7m",
      bytes: signedXml(acceptedInvoiceXml),
    });
    assert.deepEqual(
      await canonicalPage.commitArubaApiInventoryPage(stagedRunId, stagedPage, 1, [
        stagedBrowserDocument.rows[0]!.id,
      ]),
      { repeated: false },
    );
    await getPool().query("DELETE FROM aruba_remote_observations WHERE sync_run_id = $1", [
      stagedRunId,
    ]);
    await getPool().query(
      `WITH removed AS (DELETE FROM aruba_api_group_files WHERE sync_run_id = $1
         RETURNING storage_object_id)
       DELETE FROM storage_objects WHERE id IN (SELECT storage_object_id FROM removed)`,
      [stagedRunId],
    );
    await getPool().query("DELETE FROM aruba_sync_run_pages WHERE sync_run_id = $1", [stagedRunId]);
    await getPool().query("DELETE FROM aruba_deduplication_conflicts WHERE sync_run_id = $1", [
      stagedRunId,
    ]);
    await getPool().query("DELETE FROM aruba_sync_runs WHERE id = $1", [stagedRunId]);
    const canonicalRequest = await api.requestArubaApiSync(owner);
    assert.equal(canonicalRequest.queued, true);
    await getPool().query("UPDATE jobs SET run_at = now() WHERE id = $1", [canonicalRequest.jobId]);
    const canonicalJob = await jobs.claimJob("aruba-api-canonical-worker");
    const canonical = await api.runArubaApiInboundJob(canonicalJob!, {
      rateDelayMs: 0,
      now: new Date("2019-01-01T05:00:00.000Z"),
    });
    assert.equal(canonical.mode, "CANONICAL");
    assert.equal(await jobs.completeJob(canonicalJob!, canonical), true);
    assert.equal(
      (
        await getPool().query(
          `SELECT authority_mode FROM aruba_sync_runs
           WHERE kind = 'INCREMENTAL' ORDER BY started_at DESC LIMIT 1`,
        )
      ).rows[0].authority_mode,
      "CANONICAL",
    );
    await getPool().query(
      `UPDATE jobs SET completed_at = now() - interval '16 minutes'
       WHERE status = 'COMPLETED'`,
    );
    await jobs.scheduleDueSyncs();
    assert.deepEqual(
      (await getPool().query(`SELECT type FROM jobs WHERE status = 'PENDING' ORDER BY id`)).rows,
      [{ type: "aruba_refresh_nonterminal" }],
    );
    await getPool().query(`DELETE FROM jobs WHERE status = 'PENDING'`);
    await getPool().query(
      `INSERT INTO jobs (type, status, run_at, last_error_code)
       VALUES
         ('aruba_sync_inventory', 'FAILED', now() - interval '1 day', 'PROVIDER_UNAVAILABLE'),
         ('aruba_full_inventory', 'FAILED', now() + interval '1 minute', 'PROVIDER_RESPONSE_INVALID')`,
    );
    assert.deepEqual(await api.getArubaBackfillReadiness(), {
      activeJobs: 0,
      actionableFailures: 1,
      historicalFailures: 1,
      failureCodes: [{ code: "PROVIDER_RESPONSE_INVALID", count: 1 }],
    });
    await getPool().query(
      `INSERT INTO jobs
        (type, status, run_at, locked_at, lease_expires_at, locked_by, claim_token)
       VALUES ('aruba_sync_inventory', 'RUNNING', now(), now() + interval '2 minutes',
         now() + interval '5 minutes', 'recovery-worker', gen_random_uuid())`,
    );
    assert.deepEqual(await api.getArubaBackfillReadiness(), {
      activeJobs: 1,
      actionableFailures: 1,
      historicalFailures: 1,
      failureCodes: [{ code: "PROVIDER_RESPONSE_INVALID", count: 1 }],
    });
    await assert.rejects(
      api.revokeArubaApiCredentials(codex),
      (error) => error instanceof AppError && error.code === "ARUBA_OPERATION_FORBIDDEN",
    );
    await api.revokeArubaApiCredentials(owner);
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT status, encrypted_credentials, api_paused, inbound_enabled,
                  automatic_authority FROM connections WHERE provider = 'ARUBA'`,
        )
      ).rows[0],
      {
        status: "REVOKED",
        encrypted_credentials: null,
        api_paused: true,
        inbound_enabled: false,
        automatic_authority: "BROWSER",
      },
    );
    await getPool().query("DELETE FROM aruba_api_auth_attempts");
    await api.saveArubaApiCredentials(
      {
        apiEnvironment: "DEMO",
        username: "utente-sintetico",
        password: "password-sintetica-nuova",
        expectedTaxId: "00000000000",
      },
      owner,
    );
    await api.setArubaApiControls({ apiPaused: false, inboundEnabled: true }, owner);
    const obsoleteCanonicalRunId = "30000000-0000-4000-8000-000000000100";
    await getPool().query(
      `INSERT INTO aruba_sync_runs
        (id, environment, api_environment, account_reference, kind, authority_mode, status,
         window_start, window_end, checkpoint_start, checkpoint_end, request_count, request_limit,
         lease_expires_at, last_error_code)
       VALUES ($1, 'MOCK', 'DEMO', 'synthetic-aruba-account', 'INCREMENTAL', 'CANONICAL',
         'INCOMPLETE', '2019-01-01', '2019-01-03', '2019-01-01', '2019-01-02', 1, 1,
         now(), 'ARUBA_API_BUDGET_EXHAUSTED')`,
      [obsoleteCanonicalRunId],
    );
    const shadowRequest = await api.requestArubaApiSync(owner);
    await getPool().query("UPDATE jobs SET run_at = now() WHERE id = $1", [shadowRequest.jobId]);
    const shadowJob = await jobs.claimJob("aruba-api-authority-regression-worker");
    const shadowResult = await api.runArubaApiInboundJob(shadowJob!, {
      rateDelayMs: 0,
      now: new Date("2019-01-01T06:00:00.000Z"),
    });
    assert.equal(shadowResult.mode, "SHADOW");
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT authority_mode, continued_from_run_id FROM aruba_sync_runs
           WHERE status = 'COMPLETED' ORDER BY completed_at DESC LIMIT 1`,
        )
      ).rows[0],
      { authority_mode: "SHADOW", continued_from_run_id: null },
    );
    const uncertainCommitDirectory = await mkdtemp(path.join(tmpdir(), "hub-fatture-commit-"));
    const uncertainCommitFile = path.join(uncertainCommitDirectory, "evidenza.xml");
    await writeFile(uncertainCommitFile, "evidenza sintetica");
    try {
      await assert.rejects(
        withJoinedTransaction(async (client) => {
          registerJoinedTransactionFile(uncertainCommitFile);
          const query = client.query.bind(client);
          client.query = (async (...args: Parameters<typeof client.query>) => {
            const result = await query(...args);
            if (args[0] === "COMMIT") throw new Error("COMMIT_ACK_LOST");
            return result;
          }) as typeof client.query;
        }),
        /COMMIT_ACK_LOST/,
      );
      await access(uncertainCommitFile);
    } finally {
      await rm(uncertainCommitDirectory, { recursive: true, force: true });
    }
  } finally {
    globalThis.fetch = originalFetch;
    await closePool();
    await database.drop();
  }
});
