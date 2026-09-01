import assert from "node:assert/strict";
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

test("l’inbound API cifra la credenziale e completa un backfill canonico riprendibile", async () => {
  const database = await temporaryDatabase("aruba_api_inbound");
  const documentStorage = await mkdtemp(path.join(tmpdir(), "hub-fatture-aruba-api-storage-"));
  const originalFetch = globalThis.fetch;
  let pageTwoAttempts = 0;
  let pauseAfterSearch: (() => Promise<void>) | null = null;
  let invalidTargetedGroupOnce: string | null = null;
  const targetedGroupRequests: string[] = [];
  process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
  process.env.APP_BASE_URL = "http://localhost:8080";
  process.env.APP_ENV = "test";
  process.env.ARUBA_ACCOUNT_REFERENCE = "synthetic-aruba-account";
  process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64url");
  process.env.DATABASE_URL = database.connectionString;
  process.env.DOCUMENT_STORAGE_ROOT = documentStorage;
  try {
    await runMigrations({ connectionString: database.connectionString });
    const profileInvoiceXml = await readFile(
      "tests/fixtures/fatturapa/accepted-invoice.anonymized.xml",
    );
    const apiInvoiceXml = Buffer.from(
      profileInvoiceXml
        .toString("utf8")
        .replaceAll("2026-08-10", "2026-07-01")
        .replaceAll("123.45", "100.00"),
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
        if (groupId === invalidTargetedGroupOnce) {
          invalidTargetedGroupOnce = null;
          return response({ risposta: "non valida" });
        }
        const secondCheckpoint = groupId === "checkpoint-b";
        const detailXml = secondCheckpoint
          ? Buffer.from(
              apiInvoiceXml
                .toString("utf8")
                .replaceAll("2026-07-01", "2026-07-02")
                .replace("FPR 0001/26", "FPR 0002/26")
                .replaceAll("100.00", "200.00"),
            )
          : apiInvoiceXml;
        return response({
          channelGroup: 1,
          shopName: null,
          invoices: [
            {
              invoiceDate: secondCheckpoint
                ? "2026-07-02T02:30:00.000Z"
                : "2026-07-01T02:30:00.000Z",
              number: secondCheckpoint ? "FPR-TARGET-2" : "FPR-TARGET-1",
              documentType: "TD01",
              status: "Presa in carico",
              statusDescription: null,
              totalDocument: secondCheckpoint ? "200.00" : "100.00",
              totalVat: "22.00",
              netPayable: secondCheckpoint ? "200.00" : "100.00",
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
          file: detailXml.toString("base64"),
          filename: secondCheckpoint ? "IT00000000000_TARGET_2.xml" : "IT00000000000_TARGET.xml",
          username: "utente-sintetico",
          creationDate: "2026-07-01T02:30:00.000Z",
          lastUpdate: "2026-07-01T02:31:00.000Z",
          idSdi: null,
          pdfFile: null,
          pddAvailable: false,
        });
      }
      if (url.pathname === "/api/v2/invoices-out/notifications") {
        const groupId = url.searchParams.get("id");
        const secondCheckpoint = groupId === "checkpoint-b";
        return response({
          count: 1,
          notifications: [
            {
              date: secondCheckpoint ? "2026-07-02T02:32:00.000Z" : "2026-07-01T02:32:00.000Z",
              docType: "RC",
              filename: secondCheckpoint
                ? "IT00000000000_TARGET_2_RC.xml"
                : "IT00000000000_TARGET_RC.xml",
              invoiceId: groupId,
              notificationDate: "",
              number: secondCheckpoint ? "FPR-TARGET-2" : "FPR-TARGET-1",
              result: null,
              file: Buffer.from(
                `<RicevutaConsegna><NomeFile>${
                  secondCheckpoint ? "IT00000000000_TARGET_2.xml" : "IT00000000000_TARGET.xml"
                }</NomeFile></RicevutaConsegna>`,
              ).toString("base64"),
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
    const api = {
      ...(await import("./aruba-api-context.server.ts")),
      ...(await import("./aruba-api-settings.server.ts")),
      ...(await import("./aruba-api-inbound.server.ts")),
    };
    assert.equal(api.arubaApiInventoryFloor().toISOString(), "2026-07-01T00:00:00.000Z");
    const jobs = await import("./connector-jobs.server.ts");
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
      (error) => error instanceof AppError && error.code === "ARUBA_API_AUTH_INTERVAL_ACTIVE",
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
      { status: "PAUSED", paused: true, enabled: false, authority: "API" },
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
    assert.deepEqual(await api.requestArubaApiSync(codex), {
      queued: true,
      jobId: "1",
    });
    await getPool().query("UPDATE jobs SET run_at = now() WHERE id = 1");
    let job = await jobs.claimJob("aruba-api-test-worker");
    assert.equal(job?.type, "aruba_backfill_inventory");
    const runOptions = {
      rateDelayMs: 0,
      now: new Date("2026-07-01T01:00:00.000Z"),
      pageBudget: Number.MAX_SAFE_INTEGER,
    };
    const firstQuantum = await api.runArubaApiInboundJob(job!, {
      ...runOptions,
      pageBudget: 1,
    });
    assert.equal(firstQuantum.continuationPending, true);
    assert.equal(await jobs.yieldJob(job!, firstQuantum, 0), true);
    job = await jobs.claimJob("aruba-api-resumed-quantum-worker");
    assert.equal(job?.attempts, 1);
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
    await getPool().query("DELETE FROM jobs WHERE id = $1", [job!.id]);
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
    const stagedApiDocument = await getPool().query<{ id: string }>(
      `INSERT INTO aruba_remote_documents
        (environment, account_reference, remote_id, document_type, fiscal_year, series,
         fiscal_number, document_date, total_amount, remote_status, remote_status_observed_at,
         last_full_scan_at, metadata_digest)
       VALUES ('MOCK', 'synthetic-aruba-account', 'api-atomic-stage', 'TD01', 2019,
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
    const immutableConflictPage = {
      ...stagedPage,
      documents: [
        {
          ...stagedPage.documents[0]!,
          remoteId: "atomic-immutable-conflict",
          totalAmount: 12_400,
          xmlSha256: "8".repeat(64),
        },
      ],
    };
    const diagnosticRollback = new Error("DIAGNOSTIC_ROLLBACK");
    await assert.rejects(
      withJoinedTransaction(async (client) => {
        const staged = await apiStage.stageApiPage(
          stagedRunId,
          immutableConflictPage,
          new Map([["atomic-immutable-conflict", "atomic-conflict-group"]]),
          1,
        );
        assert.deepEqual(staged.resolvedDocuments, [
          {
            remoteId: "atomic-immutable-conflict",
            remoteDocumentId: stagedApiDocument.rows[0]!.id,
            officialFilesBlocked: true,
          },
        ]);
        assert.deepEqual(
          (
            await client.query(
              `SELECT remote_id, total_amount, provider_group_id,
                      (SELECT status FROM aruba_document_matches
                       WHERE remote_document_id = aruba_remote_documents.id) AS match_status,
                      (SELECT signals_json FROM aruba_document_matches
                       WHERE remote_document_id = aruba_remote_documents.id) AS signals,
                      (SELECT count(*)::integer FROM aruba_deduplication_conflicts
                       WHERE sync_run_id = $2) AS conflicts
               FROM aruba_remote_documents WHERE id = $1`,
              [stagedApiDocument.rows[0]!.id, stagedRunId],
            )
          ).rows[0],
          {
            remote_id: "api-atomic-stage",
            total_amount: 12_300,
            provider_group_id: "atomic-conflict-group",
            match_status: "UNKNOWN_REMOTE_STATE",
            signals: { deduplicationCollision: true, immutableFiscalConflict: true },
            conflicts: 1,
          },
        );
        throw diagnosticRollback;
      }),
      (error) => error === diagnosticRollback,
    );
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
        remoteDocumentId: stagedApiDocument.rows[0]!.id,
      },
    ]);
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT remote_id, remote_status, automatic_source
           FROM aruba_remote_documents WHERE id = $1`,
          [stagedApiDocument.rows[0]!.id],
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
    const inbound = await import("./aruba-official-file-import.server.ts");
    const mismatchedNotification = Buffer.from(
      "<RicevutaConsegna><NomeFile>documento-diverso.xml</NomeFile></RicevutaConsegna>",
    );
    await assert.rejects(
      inbound.importArubaRemoteOfficialFileFromApi(
        stagedApiDocument.rows[0]!.id,
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
        stagedApiDocument.rows[0]!.id,
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
          [stagedApiDocument.rows[0]!.id],
        )
      ).rows[0].count,
      0,
    );
    await assert.rejects(
      canonicalPage.commitArubaApiInventoryPage(stagedRunId, stagedPage, 1, [
        stagedApiDocument.rows[0]!.id,
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
    const conflictedStage = await apiStage.stageApiPage(
      stagedRunId,
      immutableConflictPage,
      new Map([["atomic-immutable-conflict", "atomic-conflict-group"]]),
      1,
    );
    assert.equal(conflictedStage.resolvedDocuments?.[0]?.officialFilesBlocked, true);
    await groupFile.importArubaApiGroupFile({
      runId: stagedRunId,
      providerGroupId: "atomic-conflict-group",
      kind: "ARUBA_P7M",
      filename: "atomic-stage.xml.p7m",
      bytes: signedXml(acceptedInvoiceXml),
    });
    const pageWithImmutableConflict = {
      ...stagedPage,
      documents: [...stagedPage.documents, ...immutableConflictPage.documents],
    };
    assert.deepEqual(
      await canonicalPage.commitArubaApiInventoryPage(stagedRunId, pageWithImmutableConflict, 2, [
        stagedApiDocument.rows[0]!.id,
        stagedApiDocument.rows[0]!.id,
      ]),
      { repeated: false },
    );
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT group_count, document_count FROM aruba_sync_run_pages
           WHERE sync_run_id = $1`,
          [stagedRunId],
        )
      ).rows[0],
      { group_count: 2, document_count: 2 },
    );
    await getPool().query(
      `UPDATE aruba_sync_runs SET status = 'COMPLETED', completed_at = now()
       WHERE id = $1`,
      [stagedRunId],
    );
    const repeatedConflictRunId = "30000000-0000-4000-8000-000000000100";
    await getPool().query(
      `INSERT INTO aruba_sync_runs
        (id, environment, api_environment, account_reference, kind, authority_mode, status,
         window_start, window_end, checkpoint_start, checkpoint_end, lease_expires_at)
       VALUES ($1, 'MOCK', 'DEMO', 'synthetic-aruba-account', 'INCREMENTAL', 'CANONICAL',
         'RUNNING', '2019-01-01', '2019-01-03', '2019-01-01', '2019-01-03',
         now() + interval '3 minutes')`,
      [repeatedConflictRunId],
    );
    const repeatedStage = await apiStage.stageApiPage(
      repeatedConflictRunId,
      pageWithImmutableConflict,
      new Map([
        ["atomic-stage-synthetic", "atomic-stage-group"],
        ["atomic-immutable-conflict", "atomic-conflict-group"],
      ]),
      2,
    );
    assert.deepEqual(
      repeatedStage.resolvedDocuments?.map((document) => document.remoteDocumentId),
      [stagedApiDocument.rows[0]!.id, stagedApiDocument.rows[0]!.id],
    );
    await groupFile.importArubaApiGroupFile({
      runId: repeatedConflictRunId,
      providerGroupId: "atomic-conflict-group",
      kind: "ARUBA_P7M",
      filename: "atomic-stage.xml.p7m",
      bytes: signedXml(acceptedInvoiceXml),
    });
    assert.deepEqual(
      await canonicalPage.commitArubaApiInventoryPage(
        repeatedConflictRunId,
        pageWithImmutableConflict,
        2,
        [stagedApiDocument.rows[0]!.id, stagedApiDocument.rows[0]!.id],
      ),
      { repeated: false },
    );
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT
             (SELECT count(*)::integer FROM aruba_sync_run_pages
               WHERE sync_run_id = $1) AS pages,
             (SELECT count(*)::integer FROM aruba_deduplication_conflicts
               WHERE sync_run_id = $1) AS new_conflicts`,
          [repeatedConflictRunId],
        )
      ).rows[0],
      { pages: 1, new_conflicts: 0 },
    );
    await getPool().query("DELETE FROM aruba_remote_observations WHERE sync_run_id = $1", [
      repeatedConflictRunId,
    ]);
    await getPool().query(
      `WITH removed AS (DELETE FROM aruba_api_group_files WHERE sync_run_id = $1
         RETURNING storage_object_id)
       DELETE FROM storage_objects WHERE id IN (SELECT storage_object_id FROM removed)`,
      [repeatedConflictRunId],
    );
    await getPool().query("DELETE FROM aruba_sync_run_pages WHERE sync_run_id = $1", [
      repeatedConflictRunId,
    ]);
    await getPool().query("DELETE FROM aruba_sync_runs WHERE id = $1", [repeatedConflictRunId]);
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
    await getPool().query("DELETE FROM aruba_remote_documents WHERE id = $1", [
      stagedApiDocument.rows[0]!.id,
    ]);
    const canonicalRequest = await api.requestArubaApiSync(owner);
    assert.equal(canonicalRequest.queued, true);
    await getPool().query("UPDATE jobs SET run_at = now() WHERE id = $1", [canonicalRequest.jobId]);
    const canonicalJob = await jobs.claimJob("aruba-api-canonical-worker");
    const canonical = await api.runArubaApiInboundJob(canonicalJob!, {
      rateDelayMs: 0,
      now: new Date("2026-07-01T05:00:00.000Z"),
    });
    assert.equal(canonical.mode, "CANONICAL");
    assert.equal(await jobs.completeJob(canonicalJob!, canonical), true);
    assert.equal(
      (
        await getPool().query(
          `SELECT authority_mode FROM aruba_sync_runs
           WHERE status = 'COMPLETED' ORDER BY completed_at DESC LIMIT 1`,
        )
      ).rows[0].authority_mode,
      "CANONICAL",
    );
    const inventoryHealth = await import("./aruba-inventory-health.server.ts").then((module) =>
      module.getArubaInventoryHealth(),
    );
    assert.notEqual(inventoryHealth.status, "NEVER");
    assert.ok(inventoryHealth.lastCompletedAt);
    const completedFullRun = await getPool().query<{ id: string }>(
      `SELECT id FROM aruba_sync_runs
       WHERE kind IN ('BACKFILL', 'FULL') AND status = 'COMPLETED'
         AND full_scan_completed_at IS NOT NULL
       ORDER BY completed_at DESC LIMIT 1`,
    );
    await getPool().query("UPDATE aruba_sync_runs SET authority_mode = 'SHADOW' WHERE id = $1", [
      completedFullRun.rows[0]!.id,
    ]);
    const healthAfterAuthorityCutover = await import("./aruba-inventory-health.server.ts").then(
      (module) => module.getArubaInventoryHealth(),
    );
    assert.notEqual(healthAfterAuthorityCutover.status, "NEVER");
    assert.equal(healthAfterAuthorityCutover.lastCompletedAt, inventoryHealth.lastCompletedAt);
    await getPool().query("UPDATE aruba_sync_runs SET authority_mode = 'CANONICAL' WHERE id = $1", [
      completedFullRun.rows[0]!.id,
    ]);
    const healthFixtures = await getPool().query<{ id: string }>(
      `INSERT INTO aruba_remote_documents
        (environment, account_reference, remote_id, document_type, fiscal_year,
         document_date, total_amount, remote_status, remote_status_observed_at,
         metadata_digest, xml_sha256, automatic_source, provider_group_id)
       VALUES
         ('MOCK', 'synthetic-aruba-account', 'before-inventory-floor', 'TD01', 2026,
          '2026-06-30', 10000, 'DELIVERED', now(), repeat('c', 64), repeat('d', 64),
          'API', 'before-inventory-floor'),
         ('MOCK', 'synthetic-aruba-account', 'official-external-document', 'TD01', 2026,
          '2026-07-01', 10000, 'DELIVERED', now(), repeat('e', 64), repeat('f', 64),
          'API', 'official-external-document')
       RETURNING id`,
    );
    await getPool().query(
      `INSERT INTO aruba_document_matches
        (remote_document_id, status, method, matcher_version, candidates_json)
       SELECT id, 'UNMATCHED', 'NONE', 1,
         '[{"candidateId":"1","probe":true,"potential":true,"compatible":false}]'::jsonb
       FROM aruba_remote_documents
       WHERE id = ANY($1::bigint[])`,
      [healthFixtures.rows.map((row) => row.id)],
    );
    const healthWithOfficialExternal = await import("./aruba-inventory-health.server.ts").then(
      (module) => module.getArubaInventoryHealth(),
    );
    assert.equal(healthWithOfficialExternal.remoteDocuments, inventoryHealth.remoteDocuments + 1);
    assert.equal(
      healthWithOfficialExternal.externalDocuments,
      inventoryHealth.externalDocuments + 1,
    );
    assert.equal(healthWithOfficialExternal.potentialMatches, inventoryHealth.potentialMatches);
    await getPool().query("DELETE FROM aruba_remote_documents WHERE id = ANY($1::bigint[])", [
      healthFixtures.rows.map((row) => row.id),
    ]);
    await getPool().query(
      `INSERT INTO aruba_remote_documents
        (environment, account_reference, remote_id, document_type, fiscal_year,
         document_date, total_amount, remote_status, remote_status_observed_at,
         metadata_digest, automatic_source, provider_group_id)
       VALUES
         ('MOCK', 'synthetic-aruba-account', 'checkpoint-a-document', 'TD01', 2026,
          '2026-07-01', 10000, 'SUBMITTED', now(), repeat('a', 64), 'API', 'checkpoint-a'),
         ('MOCK', 'synthetic-aruba-account', 'checkpoint-b-document', 'TD01', 2026,
          '2026-07-01', 10000, 'SUBMITTED', now(), repeat('b', 64), 'API', 'checkpoint-b')`,
    );
    invalidTargetedGroupOnce = "checkpoint-b";
    const targetedJobId = await getPool().query<{ id: string }>(
      `INSERT INTO jobs (type, status, payload_json, run_at)
       VALUES ('aruba_refresh_nonterminal', 'PENDING', '{}', now()) RETURNING id`,
    );
    const targetedJob = await jobs.claimJob("aruba-api-targeted-worker");
    await assert.rejects(
      api.runArubaApiInboundJob(targetedJob!, {
        rateDelayMs: 0,
        now: new Date("2026-07-01T05:30:00.000Z"),
      }),
      (error) => error instanceof AppError && error.code === "PROVIDER_RESPONSE_INVALID",
    );
    assert.equal(await jobs.failJob(targetedJob!, "PROVIDER_RESPONSE_INVALID"), true);
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT checkpoint_page, page_count, group_count,
                  (SELECT count(*)::integer FROM aruba_api_targeted_run_groups groups
                   WHERE groups.sync_run_id = runs.id) AS snapshotted_groups
           FROM aruba_sync_runs runs WHERE kind = 'TARGETED'
           ORDER BY started_at DESC LIMIT 1`,
        )
      ).rows[0],
      { checkpoint_page: 2, page_count: 1, group_count: 1, snapshotted_groups: 2 },
    );
    await jobs.retryFailedJob(targetedJobId.rows[0]!.id, {
      type: "ADMIN",
      id: codex.id,
      requestId: codex.requestId,
    });
    const resumedTargetedJob = await jobs.claimJob("aruba-api-targeted-resume-worker");
    const targeted = await api.runArubaApiInboundJob(resumedTargetedJob!, {
      rateDelayMs: 0,
      now: new Date("2026-07-01T05:31:00.000Z"),
    });
    assert.equal(targeted.documents, 2);
    assert.deepEqual(targetedGroupRequests.slice(-3), [
      "checkpoint-a",
      "checkpoint-b",
      "checkpoint-b",
    ]);
    assert.equal(await jobs.completeJob(resumedTargetedJob!, targeted), true);
    await getPool().query(
      `UPDATE aruba_remote_documents SET remote_status = 'DELIVERED'
       WHERE provider_group_id IN ('checkpoint-a', 'checkpoint-b')`,
    );
    await getPool().query(
      `UPDATE jobs SET completed_at = now() - interval '16 minutes'
       WHERE status = 'COMPLETED'`,
    );
    await jobs.scheduleDueSyncs();
    assert.deepEqual(
      (await getPool().query(`SELECT type FROM jobs WHERE status = 'PENDING' ORDER BY id`)).rows,
      [{ type: "aruba_sync_inventory" }],
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
        automatic_authority: "API",
      },
    );
    await getPool().query("DELETE FROM aruba_api_auth_attempts");
    await getPool().query("DELETE FROM aruba_api_traffic_limits");
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
    const resumedRequest = await api.requestArubaApiSync(owner);
    await getPool().query("UPDATE jobs SET run_at = now() WHERE id = $1", [resumedRequest.jobId]);
    const resumedJob = await jobs.claimJob("aruba-api-authority-regression-worker");
    const resumedResult = await api.runArubaApiInboundJob(resumedJob!, {
      rateDelayMs: 0,
      now: new Date("2026-07-01T06:00:00.000Z"),
    });
    assert.equal(resumedResult.mode, "CANONICAL");
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT authority_mode, continued_from_run_id FROM aruba_sync_runs
           WHERE status = 'COMPLETED' ORDER BY completed_at DESC LIMIT 1`,
        )
      ).rows[0],
      { authority_mode: "CANONICAL", continued_from_run_id: null },
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
    await rm(documentStorage, { recursive: true, force: true });
  }
});
