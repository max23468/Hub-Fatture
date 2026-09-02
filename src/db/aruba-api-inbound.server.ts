import { randomUUID } from "node:crypto";

import {
  hasRequiredArubaApiFiles,
  mapArubaApiInboundGroup,
  type ArubaApiInboundDocument,
} from "../aruba-api-inbound.ts";
import { ARUBA_API_POLICY, type ArubaApiReadScope } from "../aruba-api-policy.ts";
import { AppError, type ErrorCode } from "../errors.ts";
import {
  authenticateArubaApi,
  readArubaApiInvoiceDetail,
  readArubaApiInvoicePage,
  readArubaApiNotifications,
  type ArubaApiCredentials,
  type ArubaApiEnvironment,
  type ArubaApiInvoiceDetail,
  type ArubaApiSession,
} from "../integrations/aruba-api.server.ts";
import { reserveArubaApiAuthentication } from "./aruba-api-authentication.server.ts";
import {
  findHistoricalArubaProviderGroup,
  recordHistoricalArubaRecovery,
  snapshotTargetedTargets,
  type TargetedRunTarget,
} from "./aruba-api-historical-recovery.server.ts";
import { recomputeOpenBillingCaseStatuses } from "./billing-case-status.server.ts";
import { waitForArubaApiReadSlot } from "./aruba-api-traffic.server.ts";
import { commitArubaApiInventoryPage } from "./aruba-api-canonical-page.server.ts";
import { importArubaApiGroupFile } from "./aruba-api-group-file.server.ts";
import { importArubaRemoteOfficialFileFromApi } from "./aruba-official-file-import.server.ts";
import { upgradeCachedArubaMatcher } from "./aruba-matcher-upgrade.server.ts";
import { stageApiPage } from "./aruba-api-stage.server.ts";
import { getPool, withJoinedTransaction, withTransaction } from "./client.server.ts";
import type { ClaimedJob } from "./connector-types.server.ts";
import {
  INCREMENTAL_OVERLAP_MS,
  REQUEST_LIMIT,
  WINDOW_MS,
  arubaApiInventoryFloor,
  arubaProviderCall,
  connection,
  connectionEnvironment,
  inventoryEnvironment,
  parseStoredCredentials,
  runJobType,
  runKind,
  type ArubaApiConnectionRow,
  type ArubaSyncRunRow,
  type AuthorityMode,
  type RunKind,
  type StoredCredentials,
} from "./aruba-api-context.server.ts";

async function runnableConnection() {
  const current = await connection(getPool());
  if (
    !current?.encrypted_credentials ||
    !current.credentials_verified_at ||
    current.api_paused ||
    !current.inbound_enabled ||
    !["CONNECTED", "ERROR"].includes(current.status)
  ) {
    throw new AppError("PROVIDER_NOT_CONFIGURED", 503);
  }
  return { current, credentials: parseStoredCredentials(current.encrypted_credentials) };
}

async function runMayContinue(run: ArubaSyncRunRow): Promise<boolean> {
  const active = await getPool().query(
    `SELECT 1 FROM connections
     WHERE provider = 'ARUBA' AND environment = $1 AND account_reference = $2
       AND status IN ('CONNECTED', 'ERROR') AND encrypted_credentials IS NOT NULL
       AND credentials_verified_at IS NOT NULL AND inbound_enabled AND NOT api_paused`,
    [connectionEnvironment(), run.account_reference],
  );
  if (active.rows[0]) return true;
  await getPool().query(
    `UPDATE aruba_sync_runs SET status = 'CANCELLED', completed_at = now(),
       lease_expires_at = now()
     WHERE id = $1 AND status = 'RUNNING'`,
    [run.id],
  );
  return false;
}

async function reserveArubaApiRequests(runId: string, count = 1) {
  const reserved = await getPool().query(
    `UPDATE aruba_sync_runs SET request_count = request_count + $2,
       lease_expires_at = now() + interval '3 minutes'
     WHERE id = $1 AND status = 'RUNNING'
       AND request_count + $2 <= request_limit
     RETURNING request_count`,
    [runId, count],
  );
  if (!reserved.rows[0]) throw new AppError("ARUBA_API_BUDGET_EXHAUSTED", 409);
}

function nextWindowEnd(start: Date, end: Date) {
  return new Date(Math.min(end.getTime(), start.getTime() + WINDOW_MS));
}

async function openOrResumeRun(
  current: ArubaApiConnectionRow,
  credentials: StoredCredentials,
  kind: RunKind,
  now: Date,
) {
  const inventoryFloor = arubaApiInventoryFloor();
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('aruba-api-run'))");
    const expectedAuthority: AuthorityMode = "CANONICAL";
    await client.query(
      `UPDATE aruba_sync_runs SET status = 'CANCELLED', lease_expires_at = now(),
         last_error_code = 'ARUBA_READ_SESSION_INVALID',
         last_error_message_sanitized = 'Autorità Aruba modificata durante il run'
       WHERE environment = $1 AND account_reference = $2 AND status = 'RUNNING'
         AND authority_mode <> $3`,
      [inventoryEnvironment(), current.account_reference, expectedAuthority],
    );
    const active = await client.query<ArubaSyncRunRow>(
      `SELECT * FROM aruba_sync_runs
       WHERE environment = $1 AND account_reference = $2 AND status = 'RUNNING'
         AND authority_mode = $3
       FOR UPDATE`,
      [inventoryEnvironment(), current.account_reference, expectedAuthority],
    );
    if (active.rows[0]) {
      if (active.rows[0].kind !== kind) throw new AppError("CONFLICT_REVISION", 409);
      await client.query(
        `UPDATE aruba_sync_runs SET lease_expires_at = now() + interval '3 minutes'
         WHERE id = $1`,
        [active.rows[0].id],
      );
      return active.rows[0];
    }
    const previous = await client.query<ArubaSyncRunRow>(
      `SELECT previous.* FROM aruba_sync_runs AS previous
       WHERE previous.environment = $1 AND previous.account_reference = $2
         AND previous.kind = $3
         AND previous.window_start >= $5
         AND (previous.status = 'FAILED' OR (
           previous.status = 'INCOMPLETE'
           AND previous.last_error_code = 'ARUBA_API_BUDGET_EXHAUSTED'
         ))
         AND previous.authority_mode = $4
         AND NOT EXISTS (
           SELECT 1 FROM aruba_sync_runs AS continuation
           WHERE continuation.continued_from_run_id = previous.id
         )
       ORDER BY previous.started_at DESC LIMIT 1 FOR UPDATE OF previous`,
      [inventoryEnvironment(), current.account_reference, kind, expectedAuthority, inventoryFloor],
    );
    if (previous.rows[0]) {
      const source = previous.rows[0];
      const continuationId = randomUUID();
      const inserted = await client.query<ArubaSyncRunRow>(
        `INSERT INTO aruba_sync_runs
          (id, continued_from_run_id, environment, api_environment, account_reference,
           kind, authority_mode, window_start, window_end, checkpoint_start,
           checkpoint_end, checkpoint_page, page_count, group_count, document_count,
           file_count, notification_count, request_limit, lease_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
           $13, $14, $15, $16, $17, $18, now() + interval '3 minutes')
         RETURNING *`,
        [
          continuationId,
          source.id,
          source.environment,
          credentials.apiEnvironment,
          source.account_reference,
          source.kind,
          source.authority_mode,
          source.window_start,
          source.window_end,
          source.checkpoint_start,
          source.checkpoint_end,
          source.checkpoint_page,
          source.page_count,
          source.group_count,
          source.document_count,
          source.file_count,
          source.notification_count,
          REQUEST_LIMIT,
        ],
      );
      await client.query(
        `INSERT INTO aruba_api_targeted_run_targets
          (sync_run_id, target_ordinal, provider_group_id, remote_document_id,
           search_start, search_end)
         SELECT $1, target_ordinal, provider_group_id, remote_document_id,
                search_start, search_end
         FROM aruba_api_targeted_run_targets WHERE sync_run_id = $2`,
        [continuationId, source.id],
      );
      return inserted.rows[0]!;
    }
    let windowStart = inventoryFloor;
    if (kind === "INCREMENTAL") {
      const latest = await client.query<{ window_end: Date }>(
        `SELECT window_end FROM aruba_sync_runs
         WHERE environment = $1 AND account_reference = $2 AND status = 'COMPLETED'
           AND kind IN ('BACKFILL', 'INCREMENTAL', 'FULL')
         ORDER BY completed_at DESC LIMIT 1`,
        [inventoryEnvironment(), current.account_reference],
      );
      windowStart = new Date(
        Math.max(
          inventoryFloor.getTime(),
          (latest.rows[0]?.window_end ?? now).getTime() - INCREMENTAL_OVERLAP_MS,
        ),
      );
    } else if (kind === "TARGETED") {
      windowStart = new Date(now.getTime() - 60_000);
    }
    const windowEnd = now;
    const checkpointEnd = nextWindowEnd(windowStart, windowEnd);
    const inserted = await client.query<ArubaSyncRunRow>(
      `INSERT INTO aruba_sync_runs
        (id, environment, api_environment, account_reference, kind, authority_mode,
         window_start, window_end, checkpoint_start, checkpoint_end, checkpoint_page,
         request_limit, lease_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $7, $9, 1,
         $10, now() + interval '3 minutes')
       RETURNING *`,
      [
        randomUUID(),
        inventoryEnvironment(),
        credentials.apiEnvironment,
        current.account_reference,
        kind,
        expectedAuthority,
        windowStart,
        windowEnd,
        checkpointEnd,
        REQUEST_LIMIT,
      ],
    );
    return inserted.rows[0]!;
  });
}

class RateGate {
  private nextAt = 0;
  private readonly delayMs: number;

  constructor(delayMs: number) {
    this.delayMs = delayMs;
  }

  async wait() {
    const delay = Math.max(0, this.nextAt - Date.now());
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    this.nextAt = Date.now() + this.delayMs;
  }
}

class ArubaSessionManager {
  private static readonly sessions = new Map<string, ArubaApiSession>();
  private session: ArubaApiSession | null = null;
  private readonly authenticationGate: RateGate;
  private readonly environment: ArubaApiEnvironment;
  private readonly credentials: ArubaApiCredentials;
  private readonly cacheKey: string;
  private readonly runId: string;
  private readonly reserveAuthentication: boolean;

  constructor(
    environment: ArubaApiEnvironment,
    credentials: ArubaApiCredentials,
    cacheKey: string,
    runId: string,
    rateDelayMs: number,
    reserveAuthentication: boolean,
  ) {
    this.environment = environment;
    this.credentials = credentials;
    this.cacheKey = cacheKey;
    this.runId = runId;
    this.reserveAuthentication = reserveAuthentication;
    this.authenticationGate = new RateGate(
      Math.max(rateDelayMs, ARUBA_API_POLICY.authenticationIntervalMs),
    );
  }

  async current() {
    this.session ??= ArubaSessionManager.sessions.get(this.cacheKey) ?? null;
    if (!this.session || this.session.expiresAt <= Date.now() + 60_000) {
      await this.authenticationGate.wait();
      if (this.reserveAuthentication) await reserveArubaApiAuthentication(this.environment);
      await reserveArubaApiRequests(this.runId, 2);
      this.session = await arubaProviderCall(this.environment, () =>
        authenticateArubaApi({
          environment: this.environment,
          credentials: this.credentials,
        }),
      );
      ArubaSessionManager.sessions.set(this.cacheKey, this.session);
    }
    return this.session;
  }

  environmentName() {
    return this.environment;
  }
}

function apiGroupFromDetail(detail: ArubaApiInvoiceDetail) {
  return {
    id: detail.id,
    filename: detail.filename,
    invoices: detail.invoices.map((invoice) => ({
      invoiceDate: invoice.invoiceDate,
      number: invoice.number,
      documentType: invoice.documentType,
      status: invoice.status,
    })),
  };
}

async function readGroup(
  runId: string,
  manager: ArubaSessionManager,
  waitForRead: (scope: ArubaApiReadScope) => Promise<void>,
  group: ReturnType<typeof apiGroupFromDetail>,
  knownDetail?: ArubaApiInvoiceDetail,
) {
  if (!knownDetail) {
    await waitForRead("INVOICE_READ");
    await reserveArubaApiRequests(runId);
  }
  const detail =
    knownDetail ??
    (await arubaProviderCall(manager.environmentName(), async () =>
      readArubaApiInvoiceDetail(await manager.current(), group.id),
    ));
  await waitForRead("NOTIFICATION_READ");
  await reserveArubaApiRequests(runId);
  const notifications = await arubaProviderCall(manager.environmentName(), async () =>
    readArubaApiNotifications(await manager.current(), group.id),
  );
  return mapArubaApiInboundGroup({
    group,
    detail,
    notifications: notifications.notifications.map((notification) => ({
      filename: notification.filename,
      invoiceId: notification.invoiceId,
      docType: notification.docType,
      notificationDate: notification.notificationDate,
      number: notification.number,
      result: notification.result,
      file: notification.file,
    })),
  });
}

async function persistCanonicalPageContents(
  run: ArubaSyncRunRow,
  documents: ArubaApiInboundDocument[],
  groupCount: number,
  page: number,
  terminal: boolean,
) {
  if (documents.some((document) => !hasRequiredArubaApiFiles(document))) {
    throw new AppError("ARUBA_INVENTORY_BLOCKED", 409);
  }
  const providerGroupIds = new Map(
    documents.map((document) => [document.remote.remoteId, document.providerGroupId]),
  );
  const pagePayload = {
    stream: `api:${run.kind.toLowerCase()}`,
    scanOrdinal: 1,
    pageOrdinal: page,
    cursor: terminal ? null : String(page + 1),
    terminal,
    fullScan: run.kind === "BACKFILL" || run.kind === "FULL",
    documents: documents.map((document) => document.remote),
  };
  const staged = await stageApiPage(run.id, pagePayload, providerGroupIds, groupCount);
  const remoteDocumentIds = new Map(
    staged.resolvedDocuments?.map((document) => [document.remoteId, document.remoteDocumentId]),
  );
  const officialFilesBlocked = new Set<string>();
  for (const document of staged.resolvedDocuments ?? []) {
    if (document.officialFilesBlocked) officialFilesBlocked.add(document.remoteId);
  }
  if (remoteDocumentIds.size !== documents.length) {
    throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
  }
  const groupFiles = new Map(
    documents.flatMap((document) =>
      document.groupFiles.map(
        (file) => [`${document.providerGroupId}:${file.kind}:${file.sha256}`, file] as const,
      ),
    ),
  );
  for (const file of groupFiles.values()) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Ogni artefatto condiviso deve essere durabile prima del commit atomico della pagina.
    await importArubaApiGroupFile({
      runId: run.id,
      providerGroupId: file.providerGroupId,
      kind: file.kind,
      filename: file.filename,
      bytes: file.bytes,
    });
  }
  for (const document of documents) {
    if (officialFilesBlocked.has(document.remote.remoteId)) continue;
    const remoteDocumentId = remoteDocumentIds.get(document.remote.remoteId);
    const expectedInvoiceNumber = document.remote.providerInvoiceNumber;
    if (!remoteDocumentId || !expectedInvoiceNumber) {
      throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
    }
    const expectedDocumentFilename = [...document.files, ...document.groupFiles].find(
      (file) => file.kind === "ARUBA_XML" || file.kind === "ARUBA_P7M",
    )?.filename;
    for (const file of document.files) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- I file appartengono alla pagina canonica appena acquisita e vanno validati e persistiti in ordine prima del checkpoint successivo.
      await importArubaRemoteOfficialFileFromApi(remoteDocumentId, file.kind, file.bytes, {
        type: "API",
        runId: run.id,
        providerGroupId: document.providerGroupId,
        providerFilename: file.filename,
        expectedDocumentFilename,
        expectedInvoiceNumber,
        requiresInvoiceNumber: document.groupFiles.length > 0,
        notificationInvoiceNumber: file.notificationInvoiceNumber,
        notificationId: file.kind === "SDI_NOTIFICATION" ? file.sha256 : undefined,
      });
    }
  }
  await withTransaction((client) =>
    client.query(
      `UPDATE aruba_sync_runs SET
       file_count = (SELECT count(DISTINCT files.id)::integer
         FROM aruba_files files JOIN aruba_remote_observations observations
           ON observations.remote_document_id = files.remote_document_id
          AND observations.sync_run_id = aruba_sync_runs.id)
         + (SELECT count(*)::integer FROM aruba_api_group_files group_files
           WHERE group_files.sync_run_id = aruba_sync_runs.id),
       notification_count = (
         SELECT count(DISTINCT files.id)::integer
         FROM aruba_files files
         JOIN aruba_remote_observations observations
           ON observations.remote_document_id = files.remote_document_id
          AND observations.sync_run_id = aruba_sync_runs.id
         WHERE files.kind = 'SDI_NOTIFICATION'
       )
       WHERE id = $1 AND status = 'RUNNING'`,
      [run.id],
    ),
  );
  await commitArubaApiInventoryPage(run.id, pagePayload, groupCount, [
    ...remoteDocumentIds.values(),
  ]);
}

async function persistCanonicalPage(
  run: ArubaSyncRunRow,
  documents: ArubaApiInboundDocument[],
  groupCount: number,
  page: number,
  terminal: boolean,
  afterPersist?: () => Promise<void>,
) {
  return withJoinedTransaction(async () => {
    await persistCanonicalPageContents(run, documents, groupCount, page, terminal);
    await afterPersist?.();
  });
}

async function persistApiPage(
  run: ArubaSyncRunRow,
  documents: ArubaApiInboundDocument[],
  groupCount: number,
  page: number,
  terminal: boolean,
  afterPersist?: () => Promise<void>,
) {
  await persistCanonicalPage(run, documents, groupCount, page, terminal, afterPersist);
}

async function advanceWindow(runId: string) {
  return withTransaction(async (client) => {
    const result = await client.query<ArubaSyncRunRow>(
      `SELECT * FROM aruba_sync_runs WHERE id = $1 AND status = 'RUNNING' FOR UPDATE`,
      [runId],
    );
    const run = result.rows[0];
    if (!run) throw new AppError("CONFLICT_REVISION", 409);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `aruba-read:${run.environment}:${run.account_reference}`,
    ]);
    if (run.checkpoint_end >= run.window_end) return false;
    const nextStart = run.checkpoint_end;
    await client.query(
      `UPDATE aruba_sync_runs SET checkpoint_start = $2, checkpoint_end = $3,
         checkpoint_page = 1, lease_expires_at = now() + interval '3 minutes'
       WHERE id = $1`,
      [run.id, nextStart, nextWindowEnd(nextStart, run.window_end)],
    );
    return true;
  });
}

async function completeRun(runId: string) {
  const completed = await withTransaction(async (client) => {
    const result = await client.query<ArubaSyncRunRow>(
      `UPDATE aruba_sync_runs SET status = 'COMPLETED', completed_at = now(),
         full_scan_completed_at = CASE WHEN kind IN ('BACKFILL', 'FULL') THEN now()
           ELSE full_scan_completed_at END,
         lease_expires_at = now()
       WHERE id = $1 AND status = 'RUNNING' RETURNING *`,
      [runId],
    );
    const run = result.rows[0];
    if (!run) throw new AppError("CONFLICT_REVISION", 409);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `aruba-read:${run.environment}:${run.account_reference}`,
    ]);
    await upgradeCachedArubaMatcher(client, run.environment, run.account_reference);
    await client.query(
      `UPDATE connections SET last_synced_at = now(),
         last_full_sync_at = CASE WHEN $3 THEN now() ELSE last_full_sync_at END,
         last_error_code = NULL, last_error_message_sanitized = NULL, updated_at = now()
       WHERE provider = 'ARUBA' AND environment = $1 AND account_reference = $2`,
      [
        connectionEnvironment(),
        run.account_reference,
        run.kind === "BACKFILL" || run.kind === "FULL",
      ],
    );
    await recomputeOpenBillingCaseStatuses(client);
    return run;
  });
  return completed;
}

async function readTargetedGroup(
  run: ArubaSyncRunRow,
  manager: ArubaSessionManager,
  waitForRead: (scope: ArubaApiReadScope) => Promise<void>,
  providerGroupId: string,
) {
  await waitForRead("INVOICE_READ");
  await reserveArubaApiRequests(run.id);
  const detail = await arubaProviderCall(manager.environmentName(), async () =>
    readArubaApiInvoiceDetail(await manager.current(), providerGroupId),
  );
  return readGroup(run.id, manager, waitForRead, apiGroupFromDetail(detail), detail);
}

async function readHistoricalTarget(
  run: ArubaSyncRunRow,
  manager: ArubaSessionManager,
  waitForRead: (scope: ArubaApiReadScope) => Promise<void>,
  target: TargetedRunTarget,
) {
  const recovered = await findHistoricalArubaProviderGroup(
    target,
    async (page, windowStart, windowEnd) => {
      await waitForRead("INVOICE_READ");
      await reserveArubaApiRequests(run.id);
      return arubaProviderCall(manager.environmentName(), async () =>
        readArubaApiInvoicePage({
          session: await manager.current(),
          page,
          windowStart,
          windowEnd,
          documentType: target.document_type!,
        }),
      );
    },
  );
  return {
    ...recovered,
    documents: recovered.providerGroupId
      ? await readTargetedGroup(run, manager, waitForRead, recovered.providerGroupId)
      : ([] as ArubaApiInboundDocument[]),
  };
}

export async function runArubaApiInboundJob(
  job: ClaimedJob,
  options: { rateDelayMs?: number; now?: Date; pageBudget?: number } = {},
) {
  if (!runJobType(job.type)) throw new AppError("PROVIDER_RESPONSE_INVALID", 422);
  const { current, credentials } = await runnableConnection();
  const kind = runKind(job.type);
  const run = await openOrResumeRun(current, credentials, kind, options.now ?? new Date());
  const rateDelayMs = options.rateDelayMs ?? ARUBA_API_POLICY.invoiceReadIntervalMs;
  const manager = new ArubaSessionManager(
    credentials.apiEnvironment,
    credentials,
    `${current.id}:${current.credentials_rotated_at?.toISOString() ?? "initial"}`,
    run.id,
    rateDelayMs,
    options.rateDelayMs === undefined,
  );
  const testGlobalGate = new RateGate(rateDelayMs);
  const testScopeGates = {
    INVOICE_READ: new RateGate(rateDelayMs),
    NOTIFICATION_READ: new RateGate(rateDelayMs),
  } satisfies Record<ArubaApiReadScope, RateGate>;
  const waitForRead = async (scope: ArubaApiReadScope) => {
    if (options.rateDelayMs === undefined) {
      await waitForArubaApiReadSlot(credentials.apiEnvironment, scope);
      return;
    }
    await testGlobalGate.wait();
    await testScopeGates[scope].wait();
  };
  const pageBudget =
    options.pageBudget ?? (options.rateDelayMs === undefined ? 1 : Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(pageBudget) || pageBudget < 1) {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 422);
  }
  let processedPages = 0;
  try {
    if (kind === "TARGETED") {
      while (true) {
        if (!(await runMayContinue(run))) {
          return { runId: run.id, kind, mode: run.authority_mode, stopped: true };
        }
        const target = await snapshotTargetedTargets(run);
        if (!target) {
          const completed = await completeRun(run.id);
          return { runId: completed.id, kind, documents: completed.document_count };
        }
        const historical = target.remote_document_id
          ? await readHistoricalTarget(run, manager, waitForRead, target)
          : null;
        if (!historical && !target.provider_group_id) {
          throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
        }
        const documents = historical
          ? historical.documents
          : await readTargetedGroup(run, manager, waitForRead, target.provider_group_id!);
        const terminal = target.target_ordinal === target.target_count;
        await persistApiPage(
          run,
          documents,
          historical ? historical.searchedGroups : 1,
          target.target_ordinal,
          terminal,
          historical && target.remote_document_id
            ? () =>
                recordHistoricalArubaRecovery(
                  run.id,
                  target.remote_document_id!,
                  historical.result,
                  historical.providerGroupId,
                )
            : undefined,
        );
        processedPages += 1;
        if (terminal) {
          const completed = await completeRun(run.id);
          return { runId: completed.id, kind, documents: completed.document_count };
        }
        if (processedPages >= pageBudget) {
          return {
            runId: run.id,
            kind,
            mode: run.authority_mode,
            continuationPending: true,
          };
        }
      }
    }
    while (true) {
      if (!(await runMayContinue(run))) {
        return { runId: run.id, kind, mode: run.authority_mode, stopped: true };
      }
      const latest = await getPool().query<ArubaSyncRunRow>(
        `SELECT * FROM aruba_sync_runs WHERE id = $1 AND status = 'RUNNING'`,
        [run.id],
      );
      const checkpoint = latest.rows[0];
      if (!checkpoint) throw new AppError("CONFLICT_REVISION", 409);
      await waitForRead("INVOICE_READ");
      await reserveArubaApiRequests(run.id);
      const page = await arubaProviderCall(credentials.apiEnvironment, async () =>
        readArubaApiInvoicePage({
          session: await manager.current(),
          page: checkpoint.checkpoint_page,
          windowStart: checkpoint.checkpoint_start,
          windowEnd: checkpoint.checkpoint_end,
        }),
      );
      const documents: ArubaApiInboundDocument[] = [];
      for (const group of page.groups) {
        if (!group.invoices.length) continue;
        documents.push(...(await readGroup(run.id, manager, waitForRead, group)));
      }
      await persistApiPage(checkpoint, documents, page.groups.length, page.page, page.terminal);
      processedPages += 1;
      if (!(await runMayContinue(run))) {
        return { runId: run.id, kind, mode: run.authority_mode, stopped: true };
      }
      if (!page.terminal) {
        if (processedPages >= pageBudget) {
          return {
            runId: run.id,
            kind,
            mode: run.authority_mode,
            continuationPending: true,
          };
        }
        continue;
      }
      if (await advanceWindow(run.id)) {
        if (processedPages >= pageBudget) {
          return {
            runId: run.id,
            kind,
            mode: run.authority_mode,
            continuationPending: true,
          };
        }
        continue;
      }
      const completed = await completeRun(run.id);
      return {
        runId: completed.id,
        kind: completed.kind,
        mode: completed.authority_mode,
        pages: completed.page_count,
        groups: completed.group_count,
        documents: completed.document_count,
      };
    }
  } catch (error) {
    const appError =
      error instanceof AppError ? error : new AppError("PROVIDER_RESPONSE_INVALID", 502);
    const retryable =
      appError.code === "PROVIDER_RATE_LIMITED" ||
      appError.code === "ARUBA_API_COOLDOWN_ACTIVE" ||
      appError.code === "ARUBA_API_AUTH_INTERVAL_ACTIVE" ||
      appError.code === "PROVIDER_UNAVAILABLE";
    const budgetExhausted = appError.code === "ARUBA_API_BUDGET_EXHAUSTED";
    await getPool().query(
      `UPDATE aruba_sync_runs SET status = CASE
           WHEN $2 THEN 'INCOMPLETE' WHEN $3 THEN status ELSE 'FAILED' END,
         lease_expires_at = now(), last_error_code = $4,
         last_error_message_sanitized = 'Sincronizzazione API Aruba interrotta'
       WHERE id = $1 AND status = 'RUNNING'`,
      [run.id, budgetExhausted, retryable, appError.code],
    );
    throw appError;
  }
}

export async function markArubaApiConnectionError(code: ErrorCode, terminal: boolean) {
  await getPool().query(
    `UPDATE connections SET status = CASE
         WHEN $1 = 'AUTH_PROVIDER_EXPIRED' THEN 'REAUTH_REQUIRED'
         WHEN $2 THEN 'ERROR'
         ELSE status
       END,
       last_checked_at = now(), last_error_code = $1,
       last_error_message_sanitized = 'Sincronizzazione API Aruba interrotta', updated_at = now()
     WHERE provider = 'ARUBA' AND environment = $3`,
    [code, terminal, connectionEnvironment()],
  );
}
