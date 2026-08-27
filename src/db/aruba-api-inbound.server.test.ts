import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../errors.ts";
import { closePool, getPool } from "./client.server.ts";
import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

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
          file: Buffer.from("fattura sintetica").toString("base64"),
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
      (error) => error instanceof AppError && error.code === "PROVIDER_RATE_LIMITED",
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
       VALUES ($1, $2, 'ARUBA_XML')`,
      [browserDocument.rows[0]!.id, browserFile.rows[0]!.id],
    );
    await getPool().query(
      `INSERT INTO aruba_sync_pages
        (sync_session_id, stream, scan_ordinal, page_ordinal, terminal, full_scan,
         row_count, documents_json, payload_digest)
       VALUES ('10000000-0000-4000-8000-000000000001', 'invoices:2019', 1, 1,
         true, true, 1, jsonb_build_array(jsonb_build_object(
           'remoteId', 'browser-parity-2019', 'documentType', 'TD01', 'fiscalYear', 2019,
           'series', 'FPR', 'fiscalNumber', '1', 'documentDate', '2019-01-01',
           'totalAmount', 10000, 'status', 'DELIVERED', 'xmlSha256', repeat('c', 64)
         )), repeat('d', 64))`,
    );
    await getPool().query(
      `INSERT INTO aruba_api_shadow_documents
        (sync_run_id, provider_group_id, remote_key, document_type, fiscal_year,
         series, fiscal_number, document_date, total_amount, remote_status, xml_sha256)
       SELECT id, 'api-parity-group-2019', 'api-parity-2019', 'TD01', 2019,
         'FPR', '1', '2019-01-01', 10000, 'DELIVERED', repeat('c', 64)
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
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT status, api_documents, browser_documents, matched_documents,
                  missing_in_api, missing_in_browser, status_mismatches, file_mismatches,
                  summary_json->'populationStreams' AS population_streams,
                  summary_json->'apiFileCoverage' AS api_file_coverage,
                  (summary_json->>'unresolvedBrowserConflicts')::int AS browser_conflicts
           FROM aruba_inbound_parity_dossiers`,
        )
      ).rows,
      [
        {
          status: "MATCHED",
          api_documents: 1,
          browser_documents: 1,
          matched_documents: 1,
          missing_in_api: 0,
          missing_in_browser: 0,
          status_mismatches: 0,
          file_mismatches: 0,
          population_streams: ["invoices:2019"],
          api_file_coverage: { notifications: 0, p7m: 0, pdf: 0, xml: 1 },
          browser_conflicts: 0,
        },
      ],
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
      getPool().query(
        "UPDATE connections SET automatic_authority = 'API' WHERE provider = 'ARUBA'",
      ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "23514",
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
      { automatic_authority: "BROWSER" },
    );
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
  } finally {
    globalThis.fetch = originalFetch;
    await closePool();
    await database.drop();
  }
});
