import { createHash, randomUUID } from "node:crypto";

import type pg from "pg";
import { z } from "zod";

import {
  ARUBA_UPLOAD_MAX_BATCH_BYTES,
  arubaManifestDocumentSchema,
  arubaMonthlyTransmissionUsage,
  arubaModeSchema,
  effectiveArubaMode,
  manifestSha256,
  type ArubaManifestDocument,
  type ArubaMode,
} from "../aruba.ts";
import { getConfig } from "../config.server.ts";
import { AppError } from "../errors.ts";
import { dryRunArubaApiInvoice } from "../integrations/aruba-api.server.ts";
import { writeAudit } from "./audit.server.ts";
import { authenticateConfiguredArubaApiForOutbound } from "./aruba-api-connection.server.ts";
import { getPool, withTransaction } from "./client.server.ts";
import { assertJobLease, type ClaimedJob } from "./connectors.server.ts";
import { readVerifiedStorageObject } from "./storage-object.server.ts";

export interface ArubaOutboundActor {
  id: number;
  canApprove: boolean;
  requestId: string;
}

type BatchStatus = "DOCUMENT_ONLY" | "AWAITING_CONFIRMATION" | "DRY_RUN_PENDING";

function batchStatus(mode: ArubaMode): BatchStatus {
  if (mode === "DOCUMENT_ONLY") return "DOCUMENT_ONLY";
  if (mode === "CONTEXTUAL_CONFIRMATION") return "AWAITING_CONFIRMATION";
  return "DRY_RUN_PENDING";
}

function submissionStatus(mode: ArubaMode) {
  return mode === "AUTOMATIC_AFTER_APPROVAL" ? "DRY_RUN_PENDING" : "PENDING";
}

async function currentMode(client: pg.PoolClient): Promise<ArubaMode> {
  const result = await client.query<{ value_json: unknown }>(
    "SELECT value_json FROM settings WHERE key = 'aruba_mode' FOR UPDATE",
  );
  return arubaModeSchema.parse(result.rows[0]?.value_json ?? "DOCUMENT_ONLY");
}

async function outboundConnectionReady(
  client: pg.PoolClient,
  environment: "MOCK" | "PRODUCTION",
  accountReference: string,
) {
  const result = await client.query(
    `SELECT 1 FROM connections
     WHERE provider = 'ARUBA'
       AND environment = CASE WHEN $1 = 'PRODUCTION' THEN 'PRODUCTION' ELSE 'DEVELOPMENT' END
       AND account_reference = $2 AND status = 'CONNECTED'
       AND encrypted_credentials IS NOT NULL AND credentials_verified_at IS NOT NULL
       AND NOT api_paused`,
    [environment, accountReference],
  );
  return Boolean(result.rows[0]);
}

function manifestPayload(
  batchId: string,
  environment: "MOCK" | "PRODUCTION",
  mode: ArubaMode,
  accountReference: string,
  documents: ArubaManifestDocument[],
) {
  return {
    batchId,
    environment,
    mode,
    accountReference,
    attemptNumber: 1,
    documents,
  };
}

export async function createArubaApiBatch(
  client: pg.PoolClient,
  documents: ArubaManifestDocument[],
  actor: ArubaOutboundActor,
  expectedMode?: unknown,
  confirmDocumentOnlyDowngrade = false,
): Promise<string> {
  if (!actor.canApprove) throw new AppError("ARUBA_OPERATION_FORBIDDEN", 403);
  const parsedDocuments = z.array(arubaManifestDocumentSchema).min(1).max(300).safeParse(documents);
  if (
    !parsedDocuments.success ||
    new Set(documents.map((document) => document.id)).size !== documents.length ||
    documents.reduce((total, document) => total + document.sizeBytes, 0) >
      ARUBA_UPLOAD_MAX_BATCH_BYTES
  ) {
    throw new AppError("ARUBA_BATCH_INVALID", 422);
  }
  const config = getConfig();
  const environment = config.APP_ENV === "production" ? "PRODUCTION" : "MOCK";
  const configuredMode = await currentMode(client);
  const mode = effectiveArubaMode(configuredMode, environment, config.ARUBA_SUBMISSION_ENABLED);
  if (expectedMode !== undefined && expectedMode !== mode) {
    throw new AppError("DOCUMENT_PROJECTION_STALE", 409);
  }
  if (configuredMode !== mode && !confirmDocumentOnlyDowngrade) {
    throw new AppError("DOCUMENT_NOT_APPROVABLE", 409);
  }
  if (
    mode !== "DOCUMENT_ONLY" &&
    !(await outboundConnectionReady(client, environment, config.ARUBA_ACCOUNT_REFERENCE))
  ) {
    throw new AppError("ARUBA_SUBMISSION_PAUSED", 409);
  }
  const batchId = randomUUID();
  const payload = manifestPayload(
    batchId,
    environment,
    mode,
    config.ARUBA_ACCOUNT_REFERENCE,
    documents,
  );
  const digest = manifestSha256(payload);
  await client.query(
    `INSERT INTO aruba_batches
      (id, environment, mode, transport, account_reference, manifest_sha256,
       document_count, attempt_number, status, created_by)
     VALUES ($1, $2, $3, 'API', $4, $5, $6, 1, $7, $8)`,
    [
      batchId,
      environment,
      mode,
      config.ARUBA_ACCOUNT_REFERENCE,
      digest,
      documents.length,
      batchStatus(mode),
      actor.id,
    ],
  );
  for (const [index, document] of documents.entries()) {
    await client.query(
      `INSERT INTO aruba_batch_documents
        (batch_id, document_id, position, document_revision, xml_sha256, filename)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [batchId, document.id, index + 1, document.revision, document.sha256, document.filename],
    );
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO aruba_submissions
        (batch_id, document_id, attempt_number, environment, mode, transport,
         manifest_sha256, xml_sha256, status)
       VALUES ($1, $2, 1, $3, $4, 'API', $5, $6, $7)
       RETURNING id`,
      [batchId, document.id, environment, mode, digest, document.sha256, submissionStatus(mode)],
    );
    if (mode === "AUTOMATIC_AFTER_APPROVAL") {
      await enqueueDryRun(client, inserted.rows[0]!.id);
    }
  }
  await writeAudit(client, {
    actorType: "ADMIN",
    actorId: String(actor.id),
    action: "ARUBA_BATCH_CREATED",
    eventClass: "CRITICAL",
    entityType: "ARUBA_BATCH",
    entityId: batchId,
    metadata: {
      batchId,
      manifestSha256: digest,
      documentCount: documents.length,
      arubaMode: mode,
    },
    requestId: actor.requestId,
  });
  return batchId;
}

async function enqueueDryRun(client: pg.PoolClient, submissionId: string) {
  await client.query(
    `INSERT INTO jobs (type, payload_json, max_attempts)
     VALUES ('aruba_dry_run_submission', jsonb_build_object('submissionId', $1::text), 1)
     ON CONFLICT DO NOTHING`,
    [submissionId],
  );
}

export async function authorizeArubaApiDryRunQualification(
  batchId: string,
  actor: ArubaOutboundActor,
  confirmed: boolean,
) {
  if (!actor.canApprove) throw new AppError("ARUBA_OPERATION_FORBIDDEN", 403);
  if (!confirmed || !z.uuid().safeParse(batchId).success) {
    throw new AppError("ARUBA_BATCH_INVALID", 422);
  }
  const config = getConfig();
  if (config.APP_ENV !== "production" || config.ARUBA_SUBMISSION_ENABLED) {
    throw new AppError("ARUBA_SUBMISSION_PAUSED", 409);
  }
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('aruba-dry-run-qualification'))");
    await client.query(
      `UPDATE aruba_dry_run_qualifications SET status = 'EXPIRED', completed_at = now()
       WHERE status = 'AUTHORIZED' AND expires_at <= now()`,
    );
    const batch = await client.query<{
      environment: string;
      mode: ArubaMode;
      transport: string;
      status: string;
      account_reference: string;
      manifest_sha256: string;
      document_count: number;
    }>(
      `SELECT environment, mode, transport, status, account_reference,
              manifest_sha256, document_count
       FROM aruba_batches WHERE id = $1 FOR UPDATE`,
      [batchId],
    );
    const current = batch.rows[0];
    if (
      !current ||
      current.environment !== "PRODUCTION" ||
      current.mode !== "DOCUMENT_ONLY" ||
      current.transport !== "API" ||
      current.status !== "DOCUMENT_ONLY" ||
      current.account_reference !== config.ARUBA_ACCOUNT_REFERENCE ||
      current.document_count !== 1 ||
      !(await outboundConnectionReady(client, "PRODUCTION", config.ARUBA_ACCOUNT_REFERENCE))
    ) {
      throw new AppError("ARUBA_BATCH_INVALID", 409);
    }
    await assertBatchManifestCurrent(client, batchId);
    const qualificationId = randomUUID();
    await client.query(
      `INSERT INTO aruba_dry_run_qualifications
        (id, batch_id, environment, account_reference, manifest_sha256,
         expires_at, created_by)
       VALUES ($1, $2, 'PRODUCTION', $3, $4, now() + interval '15 minutes', $5)`,
      [qualificationId, batchId, current.account_reference, current.manifest_sha256, actor.id],
    );
    const submission = await client.query<{ id: string }>(
      `UPDATE aruba_submissions SET status = 'DRY_RUN_PENDING'
       WHERE batch_id = $1 AND transport = 'API' AND mode = 'DOCUMENT_ONLY'
         AND status = 'PENDING'
       RETURNING id`,
      [batchId],
    );
    if (submission.rowCount !== 1) throw new AppError("ARUBA_BATCH_INVALID", 409);
    await client.query(
      "UPDATE aruba_batches SET status = 'DRY_RUN_PENDING', updated_at = now() WHERE id = $1",
      [batchId],
    );
    await enqueueDryRun(client, submission.rows[0]!.id);
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "ARUBA_API_DRY_RUN_AUTHORIZED",
      eventClass: "CRITICAL",
      entityType: "ARUBA_BATCH",
      entityId: batchId,
      metadata: {
        batchId,
        manifestSha256: current.manifest_sha256,
        endpoint: "/services/invoice/upload",
        requestLimit: 1,
      },
      requestId: actor.requestId,
    });
    return { qualificationId, queued: 1 };
  });
}

export async function confirmArubaApiBatch(batchId: string, actor: ArubaOutboundActor) {
  if (!actor.canApprove) throw new AppError("ARUBA_OPERATION_FORBIDDEN", 403);
  if (!z.uuid().safeParse(batchId).success) throw new AppError("ARUBA_BATCH_INVALID", 422);
  if (!getConfig().ARUBA_SUBMISSION_ENABLED) {
    throw new AppError("ARUBA_SUBMISSION_PAUSED", 409);
  }
  return withTransaction(async (client) => {
    const batch = await client.query<{
      environment: "MOCK" | "PRODUCTION";
      mode: ArubaMode;
      transport: string;
      status: string;
      manifest_sha256: string;
      account_reference: string;
    }>(
      `SELECT environment, mode, transport, status, manifest_sha256, account_reference
       FROM aruba_batches WHERE id = $1 FOR UPDATE`,
      [batchId],
    );
    const current = batch.rows[0];
    if (
      !current ||
      current.transport !== "API" ||
      current.mode !== "CONTEXTUAL_CONFIRMATION" ||
      current.status !== "AWAITING_CONFIRMATION"
    ) {
      throw new AppError("ARUBA_BATCH_INVALID", 409);
    }
    const config = getConfig();
    const environment = config.APP_ENV === "production" ? "PRODUCTION" : "MOCK";
    const configuredMode = await currentMode(client);
    if (
      current.environment !== environment ||
      current.account_reference !== config.ARUBA_ACCOUNT_REFERENCE ||
      effectiveArubaMode(configuredMode, environment, config.ARUBA_SUBMISSION_ENABLED) !==
        current.mode ||
      !(await outboundConnectionReady(client, environment, config.ARUBA_ACCOUNT_REFERENCE))
    ) {
      throw new AppError("ARUBA_SUBMISSION_PAUSED", 409);
    }
    await assertBatchManifestCurrent(client, batchId);
    const submissions = await client.query<{ id: string }>(
      `UPDATE aruba_submissions SET status = 'DRY_RUN_PENDING'
       WHERE batch_id = $1 AND transport = 'API' AND status = 'PENDING'
       RETURNING id`,
      [batchId],
    );
    if (!submissions.rows.length) throw new AppError("ARUBA_BATCH_INVALID", 409);
    await client.query(
      "UPDATE aruba_batches SET status = 'DRY_RUN_PENDING', updated_at = now() WHERE id = $1",
      [batchId],
    );
    for (const submission of submissions.rows) await enqueueDryRun(client, submission.id);
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "ARUBA_API_BATCH_CONFIRMED",
      eventClass: "CRITICAL",
      entityType: "ARUBA_BATCH",
      entityId: batchId,
      metadata: { batchId, manifestSha256: current.manifest_sha256 },
      requestId: actor.requestId,
    });
    return { queued: submissions.rows.length };
  });
}

interface DryRunContext {
  attemptId: string;
  submissionId: string;
  batchId: string;
  accountReference: string;
  xmlSha256: string;
  relativePath: string;
  sizeBytes: number;
  qualificationId: string | null;
}

interface BatchInvariant {
  id: string;
  environment: "MOCK" | "PRODUCTION";
  mode: ArubaMode;
  account_reference: string;
  manifest_sha256: string;
  document_count: number;
  attempt_number: number;
}

async function assertBatchManifestCurrent(client: pg.PoolClient, batchId: string) {
  const batch = await client.query<BatchInvariant & { created_by_can_approve: boolean }>(
    `SELECT batches.id, batches.environment, batches.mode, batches.account_reference,
            batches.manifest_sha256, batches.document_count, batches.attempt_number,
            users.can_approve AS created_by_can_approve
     FROM aruba_batches AS batches
     JOIN users ON users.id = batches.created_by
     WHERE batches.id = $1`,
    [batchId],
  );
  const current = batch.rows[0];
  if (!current || !current.created_by_can_approve || current.attempt_number !== 1) {
    throw new AppError("ARUBA_BATCH_INVALID", 409);
  }
  const rows = await client.query<{
    id: string;
    revision: number;
    sha256: string;
    filename: string;
    size_bytes: number;
    fiscal_number: string;
    document_date: string;
    total_amount: number;
    status: string;
    submission_environment: string;
    submission_mode: string;
    submission_manifest_sha256: string;
    submission_xml_sha256: string;
  }>(
    `SELECT documents.id, batch_documents.document_revision AS revision,
            batch_documents.xml_sha256 AS sha256, batch_documents.filename,
            storage.size_bytes,
            documents.series || ' ' || lpad(documents.fiscal_number::text, 4, '0') || '/' ||
              right(documents.fiscal_year::text, 2) AS fiscal_number,
            documents.document_date::text, documents.total_amount, documents.status,
            submissions.environment AS submission_environment,
            submissions.mode AS submission_mode,
            submissions.manifest_sha256 AS submission_manifest_sha256,
            submissions.xml_sha256 AS submission_xml_sha256
     FROM aruba_batch_documents AS batch_documents
     JOIN documents ON documents.id = batch_documents.document_id
     JOIN storage_objects AS storage ON storage.id = documents.storage_object_id
     JOIN aruba_submissions AS submissions
       ON submissions.batch_id = batch_documents.batch_id
      AND submissions.document_id = batch_documents.document_id
      AND submissions.attempt_number = $2
     WHERE batch_documents.batch_id = $1
     ORDER BY batch_documents.position`,
    [batchId, current.attempt_number],
  );
  if (
    rows.rows.length !== current.document_count ||
    rows.rows.some(
      (row) =>
        row.status !== "APPROVED" ||
        row.submission_environment !== current.environment ||
        row.submission_mode !== current.mode ||
        row.submission_manifest_sha256 !== current.manifest_sha256 ||
        row.submission_xml_sha256 !== row.sha256,
    )
  ) {
    throw new AppError("ARUBA_BATCH_INVALID", 409);
  }
  const documents: ArubaManifestDocument[] = rows.rows.map((row) => ({
    id: row.id,
    revision: row.revision,
    sha256: row.sha256,
    filename: row.filename,
    sizeBytes: row.size_bytes,
    fiscalNumber: row.fiscal_number,
    documentDate: row.document_date,
    totalAmount: row.total_amount,
  }));
  const digest = manifestSha256(
    manifestPayload(
      current.id,
      current.environment,
      current.mode,
      current.account_reference,
      documents,
    ),
  );
  if (digest !== current.manifest_sha256) throw new AppError("ARUBA_BATCH_INVALID", 409);
}

async function prepareDryRun(job: ClaimedJob): Promise<DryRunContext> {
  const submissionId = z.string().regex(/^\d+$/).safeParse(job.payload.submissionId);
  if (!submissionId.success) throw new AppError("ARUBA_BATCH_INVALID", 422);
  return withTransaction(async (client) => {
    await assertJobLease(client, job);
    const result = await client.query<{
      submission_id: string;
      batch_id: string;
      account_reference: string;
      manifest_sha256: string;
      xml_sha256: string;
      relative_path: string;
      size_bytes: number;
      current_revision: number;
      document_revision: number;
      current_sha256: string;
      api_paused: boolean;
      connection_status: string;
      credentials_verified_at: Date | null;
      environment: "MOCK" | "PRODUCTION";
      mode: ArubaMode;
      submission_environment: string;
      submission_mode: string;
      submission_manifest_sha256: string;
      document_status: string;
    }>(
      `SELECT submissions.id AS submission_id, batches.id AS batch_id,
              batches.account_reference, batches.manifest_sha256, submissions.xml_sha256,
              batches.environment, batches.mode,
              submissions.environment AS submission_environment,
              submissions.mode AS submission_mode,
              submissions.manifest_sha256 AS submission_manifest_sha256,
              storage.relative_path, storage.size_bytes,
              documents.draft_version AS current_revision,
              batch_documents.document_revision, documents.xml_sha256 AS current_sha256,
              documents.status AS document_status,
              connections.api_paused, connections.status AS connection_status,
              connections.credentials_verified_at
       FROM aruba_submissions AS submissions
       JOIN aruba_batches AS batches ON batches.id = submissions.batch_id
       JOIN aruba_batch_documents AS batch_documents
         ON batch_documents.batch_id = batches.id
        AND batch_documents.document_id = submissions.document_id
       JOIN documents ON documents.id = submissions.document_id
       JOIN storage_objects AS storage ON storage.id = documents.storage_object_id
       LEFT JOIN connections ON connections.provider = 'ARUBA'
        AND connections.environment = CASE WHEN batches.environment = 'PRODUCTION'
          THEN 'PRODUCTION' ELSE 'DEVELOPMENT' END
       WHERE submissions.id = $1 AND submissions.transport = 'API'
         AND submissions.status = 'DRY_RUN_PENDING'
         AND batches.status = 'DRY_RUN_PENDING'
       FOR UPDATE OF submissions, batches, documents`,
      [submissionId.data],
    );
    const current = result.rows[0];
    const config = getConfig();
    const environment = config.APP_ENV === "production" ? "PRODUCTION" : "MOCK";
    const configuredMode = await currentMode(client);
    const qualification = current
      ? await client.query<{ id: string }>(
          `SELECT id FROM aruba_dry_run_qualifications
           WHERE batch_id = $1 AND environment = 'PRODUCTION'
             AND account_reference = $2 AND manifest_sha256 = $3
             AND endpoint = '/services/invoice/upload' AND request_limit = 1
             AND status = 'AUTHORIZED' AND expires_at > now()
           FOR UPDATE`,
          [current.batch_id, current.account_reference, current.manifest_sha256],
        )
      : null;
    const qualificationId = qualification?.rows[0]?.id ?? null;
    const ordinaryAuthorization =
      config.ARUBA_SUBMISSION_ENABLED &&
      current?.mode !== "DOCUMENT_ONLY" &&
      effectiveArubaMode(configuredMode, environment, config.ARUBA_SUBMISSION_ENABLED) ===
        current?.mode;
    const qualificationAuthorization =
      !config.ARUBA_SUBMISSION_ENABLED &&
      environment === "PRODUCTION" &&
      current?.mode === "DOCUMENT_ONLY" &&
      qualificationId !== null;
    if (
      !current ||
      current.environment !== environment ||
      current.account_reference !== config.ARUBA_ACCOUNT_REFERENCE ||
      current.submission_environment !== current.environment ||
      current.submission_mode !== current.mode ||
      current.submission_manifest_sha256 !== current.manifest_sha256 ||
      (!ordinaryAuthorization && !qualificationAuthorization) ||
      current.api_paused !== false ||
      current.connection_status !== "CONNECTED" ||
      !current.credentials_verified_at
    ) {
      throw new AppError("ARUBA_SUBMISSION_PAUSED", 409);
    }
    if (
      current.current_revision !== current.document_revision ||
      current.current_sha256 !== current.xml_sha256 ||
      current.document_status !== "APPROVED"
    ) {
      throw new AppError("ARUBA_BATCH_INVALID", 409);
    }
    await assertBatchManifestCurrent(client, current.batch_id);
    if (qualificationId) {
      const consumed = await client.query(
        `UPDATE aruba_dry_run_qualifications
         SET status = 'CONSUMED', consumed_at = now()
         WHERE id = $1 AND status = 'AUTHORIZED' AND expires_at > now()`,
        [qualificationId],
      );
      if (consumed.rowCount !== 1) throw new AppError("ARUBA_SUBMISSION_PAUSED", 409);
    }
    const attemptId = randomUUID();
    const fingerprint = createHash("sha256")
      .update(`DRY_RUN:${current.submission_id}:${current.manifest_sha256}:${current.xml_sha256}`)
      .digest("hex");
    await client.query(
      `INSERT INTO aruba_submission_attempts
        (id, submission_id, operation, attempt_number, request_fingerprint, xml_sha256,
         status, started_at)
       VALUES ($1, $2, 'DRY_RUN', 1, $3, $4, 'RUNNING', now())`,
      [attemptId, current.submission_id, fingerprint, current.xml_sha256],
    );
    await writeAudit(client, {
      actorType: "SYSTEM",
      action: "ARUBA_API_DRY_RUN_STARTED",
      eventClass: "CRITICAL",
      entityType: "ARUBA_SUBMISSION_ATTEMPT",
      entityId: attemptId,
      metadata: {
        batchId: current.batch_id,
        manifestSha256: current.manifest_sha256,
        provider: "ARUBA",
      },
      requestId: `aruba-dry-run:${job.id}`,
    });
    return {
      attemptId,
      submissionId: current.submission_id,
      batchId: current.batch_id,
      accountReference: current.account_reference,
      xmlSha256: current.xml_sha256,
      relativePath: current.relative_path,
      sizeBytes: current.size_bytes,
      qualificationId,
    };
  });
}

async function finishDryRun(
  context: DryRunContext,
  result: Awaited<ReturnType<typeof dryRunArubaApiInvoice>>,
) {
  await withTransaction(async (client) => {
    const status = result.accepted ? "SUCCEEDED" : "FAILED";
    const attempt = await client.query(
      `UPDATE aruba_submission_attempts
       SET status = $2, provider_reference = $3,
           response_metadata_json = jsonb_build_object('errorCode', $4::text),
           error_code = CASE WHEN $2 = 'FAILED' THEN $4 ELSE NULL END,
           error_message_sanitized = CASE WHEN $2 = 'FAILED' THEN $5 ELSE NULL END,
           completed_at = now()
       WHERE id = $1 AND status = 'RUNNING'`,
      [context.attemptId, status, result.uploadFileName, result.errorCode, result.errorDescription],
    );
    const submission = await client.query(
      `UPDATE aruba_submissions
       SET status = $2, validation_metadata_json = jsonb_build_object(
         'errorCode', $3::text, 'uploadFileName', $4::text),
         error_code = CASE WHEN $2 = 'DRY_RUN_FAILED' THEN $3 ELSE NULL END,
         error_message_sanitized = CASE WHEN $2 = 'DRY_RUN_FAILED' THEN $5 ELSE NULL END,
         last_checked_at = now()
       WHERE id = $1 AND status = 'DRY_RUN_PENDING'`,
      [
        context.submissionId,
        result.accepted ? "DRY_RUN_VALIDATED" : "DRY_RUN_FAILED",
        result.errorCode,
        result.uploadFileName,
        result.errorDescription,
      ],
    );
    if (attempt.rowCount !== 1 || submission.rowCount !== 1) {
      throw new AppError("ARUBA_BATCH_INVALID", 409);
    }
    if (context.qualificationId) {
      const qualification = await client.query(
        `UPDATE aruba_dry_run_qualifications
         SET status = $2, completed_at = now()
         WHERE id = $1 AND status = 'CONSUMED'`,
        [context.qualificationId, result.accepted ? "SUCCEEDED" : "FAILED"],
      );
      if (qualification.rowCount !== 1) throw new AppError("ARUBA_BATCH_INVALID", 409);
    }
    await refreshBatchDryRunStatus(client, context.batchId);
    await writeAudit(client, {
      actorType: "SYSTEM",
      action: result.accepted ? "ARUBA_API_DRY_RUN_COMPLETED" : "ARUBA_API_DRY_RUN_FAILED",
      eventClass: "CRITICAL",
      entityType: "ARUBA_SUBMISSION_ATTEMPT",
      entityId: context.attemptId,
      metadata: { batchId: context.batchId, provider: "ARUBA" },
      requestId: `aruba-dry-run:${context.attemptId}`,
    });
  });
}

async function markDryRunUnknown(context: DryRunContext) {
  await withTransaction(async (client) => {
    const attempt = await client.query(
      `UPDATE aruba_submission_attempts SET status = 'UNKNOWN_REMOTE_STATE',
         error_code = 'ARUBA_SUBMISSION_UNKNOWN',
         error_message_sanitized = 'Esito remoto non confermato', completed_at = now()
       WHERE id = $1 AND status = 'RUNNING'`,
      [context.attemptId],
    );
    const submission = await client.query(
      `UPDATE aruba_submissions SET status = 'UNKNOWN_REMOTE_STATE',
         error_code = 'ARUBA_SUBMISSION_UNKNOWN',
         error_message_sanitized = 'Esito remoto non confermato', last_checked_at = now()
       WHERE id = $1 AND status = 'DRY_RUN_PENDING'`,
      [context.submissionId],
    );
    if (attempt.rowCount !== 1 || submission.rowCount !== 1) {
      throw new AppError("ARUBA_BATCH_INVALID", 409);
    }
    if (context.qualificationId) {
      const qualification = await client.query(
        `UPDATE aruba_dry_run_qualifications
         SET status = 'UNKNOWN_REMOTE_STATE', completed_at = now()
         WHERE id = $1 AND status = 'CONSUMED'`,
        [context.qualificationId],
      );
      if (qualification.rowCount !== 1) throw new AppError("ARUBA_BATCH_INVALID", 409);
    }
    await refreshBatchDryRunStatus(client, context.batchId);
    await writeAudit(client, {
      actorType: "SYSTEM",
      action: "ARUBA_API_DRY_RUN_UNKNOWN",
      eventClass: "CRITICAL",
      entityType: "ARUBA_SUBMISSION_ATTEMPT",
      entityId: context.attemptId,
      metadata: { batchId: context.batchId, provider: "ARUBA" },
      requestId: `aruba-dry-run:${context.attemptId}`,
    });
  });
}

async function refreshBatchDryRunStatus(client: pg.PoolClient, batchId: string) {
  const summary = await client.query<{ pending: string; failed: string; unknown: string }>(
    `SELECT count(*) FILTER (WHERE status = 'DRY_RUN_PENDING')::text AS pending,
            count(*) FILTER (WHERE status = 'DRY_RUN_FAILED')::text AS failed,
            count(*) FILTER (WHERE status = 'UNKNOWN_REMOTE_STATE')::text AS unknown
     FROM aruba_submissions WHERE batch_id = $1`,
    [batchId],
  );
  const counts = summary.rows[0]!;
  if (Number(counts.unknown) > 0) {
    await client.query(
      `UPDATE aruba_batches SET status = 'UNKNOWN_REMOTE_STATE',
         requires_reconciliation = true, updated_at = now() WHERE id = $1`,
      [batchId],
    );
    return;
  }
  if (Number(counts.pending) > 0) return;
  await client.query(
    `UPDATE aruba_batches SET status = $2, requires_reconciliation = false, updated_at = now()
     WHERE id = $1`,
    [batchId, Number(counts.failed) > 0 ? "DRY_RUN_FAILED" : "DRY_RUN_VALIDATED"],
  );
}

async function recoverInterruptedDryRun(job: ClaimedJob) {
  const submissionId = z.string().regex(/^\d+$/).safeParse(job.payload.submissionId);
  if (!submissionId.success) throw new AppError("ARUBA_BATCH_INVALID", 422);
  return withTransaction(async (client) => {
    await assertJobLease(client, job);
    const interrupted = await client.query<{
      attempt_id: string;
      submission_id: string;
      batch_id: string;
      qualification_id: string | null;
    }>(
      `SELECT attempts.id AS attempt_id, submissions.id AS submission_id,
              submissions.batch_id, qualifications.id AS qualification_id
       FROM aruba_submission_attempts AS attempts
       JOIN aruba_submissions AS submissions ON submissions.id = attempts.submission_id
       LEFT JOIN aruba_dry_run_qualifications AS qualifications
         ON qualifications.batch_id = submissions.batch_id AND qualifications.status = 'CONSUMED'
       WHERE submissions.id = $1 AND attempts.operation = 'DRY_RUN'
         AND attempts.status = 'RUNNING' AND submissions.status = 'DRY_RUN_PENDING'
       FOR UPDATE OF attempts, submissions`,
      [submissionId.data],
    );
    const current = interrupted.rows[0];
    if (!current) return null;
    const attempt = await client.query(
      `UPDATE aruba_submission_attempts SET status = 'UNKNOWN_REMOTE_STATE',
         error_code = 'ARUBA_SUBMISSION_UNKNOWN',
         error_message_sanitized = 'Esecuzione interrotta dopo la preparazione della richiesta',
         completed_at = now()
       WHERE id = $1 AND status = 'RUNNING'`,
      [current.attempt_id],
    );
    const submission = await client.query(
      `UPDATE aruba_submissions SET status = 'UNKNOWN_REMOTE_STATE',
         error_code = 'ARUBA_SUBMISSION_UNKNOWN',
         error_message_sanitized = 'Esito remoto non confermato dopo il riavvio',
         last_checked_at = now()
       WHERE id = $1 AND status = 'DRY_RUN_PENDING'`,
      [current.submission_id],
    );
    if (attempt.rowCount !== 1 || submission.rowCount !== 1) {
      throw new AppError("ARUBA_BATCH_INVALID", 409);
    }
    if (current.qualification_id) {
      const qualification = await client.query(
        `UPDATE aruba_dry_run_qualifications
         SET status = 'UNKNOWN_REMOTE_STATE', completed_at = now()
         WHERE id = $1 AND status = 'CONSUMED'`,
        [current.qualification_id],
      );
      if (qualification.rowCount !== 1) throw new AppError("ARUBA_BATCH_INVALID", 409);
    }
    await refreshBatchDryRunStatus(client, current.batch_id);
    await writeAudit(client, {
      actorType: "SYSTEM",
      action: "ARUBA_API_DRY_RUN_UNKNOWN",
      eventClass: "CRITICAL",
      entityType: "ARUBA_SUBMISSION_ATTEMPT",
      entityId: current.attempt_id,
      metadata: { batchId: current.batch_id, provider: "ARUBA", recoveredAfterRestart: true },
      requestId: `aruba-dry-run-recovery:${job.id}`,
    });
    return { submissionId: current.submission_id, batchId: current.batch_id };
  });
}

async function failQueuedDryRun(job: ClaimedJob, errorCode: string) {
  const submissionId = z.string().regex(/^\d+$/).safeParse(job.payload.submissionId);
  if (!submissionId.success) return null;
  return withTransaction(async (client) => {
    await assertJobLease(client, job);
    const failed = await client.query<{ batch_id: string }>(
      `UPDATE aruba_submissions SET status = 'DRY_RUN_FAILED', error_code = $2,
         error_message_sanitized = 'Prerequisiti del dry-run non più validi',
         last_checked_at = now()
       WHERE id = $1 AND status = 'DRY_RUN_PENDING'
       RETURNING batch_id`,
      [submissionId.data, errorCode],
    );
    const batchId = failed.rows[0]?.batch_id;
    if (!batchId) return null;
    await client.query(
      `UPDATE aruba_dry_run_qualifications
       SET status = CASE WHEN expires_at <= now() THEN 'EXPIRED' ELSE 'CANCELLED' END,
           completed_at = now()
       WHERE batch_id = $1 AND status = 'AUTHORIZED'`,
      [batchId],
    );
    await refreshBatchDryRunStatus(client, batchId);
    await writeAudit(client, {
      actorType: "SYSTEM",
      action: "ARUBA_API_DRY_RUN_FAILED",
      eventClass: "CRITICAL",
      entityType: "ARUBA_BATCH",
      entityId: batchId,
      metadata: { batchId, provider: "ARUBA" },
      reason: errorCode,
      requestId: `aruba-dry-run-preflight:${job.id}`,
    });
    return { submissionId: submissionId.data, batchId };
  });
}

export async function runArubaApiOutboundJob(job: ClaimedJob) {
  if (job.type !== "aruba_dry_run_submission") {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 422);
  }
  const interrupted = await recoverInterruptedDryRun(job);
  if (interrupted) {
    return { accepted: false, unknownRemoteState: true, ...interrupted };
  }
  let context: DryRunContext;
  try {
    context = await prepareDryRun(job);
  } catch (error) {
    if (error instanceof AppError && error.code !== "CONFLICT_REVISION") {
      const failed = await failQueuedDryRun(job, error.code);
      if (failed) return { accepted: false, errorCode: error.code, ...failed };
    }
    throw error;
  }
  let xml: Buffer;
  let authenticated: Awaited<ReturnType<typeof authenticateConfiguredArubaApiForOutbound>>;
  try {
    xml = await readVerifiedStorageObject({
      relativePath: context.relativePath,
      sha256: context.xmlSha256,
      sizeBytes: context.sizeBytes,
    });
    authenticated = await authenticateConfiguredArubaApiForOutbound();
    if (authenticated.accountReference !== context.accountReference) {
      throw new AppError("ARUBA_ACCOUNT_MISMATCH", 409);
    }
  } catch (error) {
    const errorCode = error instanceof AppError ? error.code : "UNKNOWN";
    await finishDryRun(context, {
      accepted: false,
      errorCode,
      errorDescription: "Prerequisiti del dry-run non soddisfatti",
      uploadFileName: null,
    });
    return { accepted: false, submissionId: context.submissionId, errorCode };
  }
  try {
    const result = await dryRunArubaApiInvoice(authenticated.session, xml);
    await finishDryRun(context, result);
    return { accepted: result.accepted, submissionId: context.submissionId };
  } catch (error) {
    await markDryRunUnknown(context);
    return {
      accepted: false,
      submissionId: context.submissionId,
      unknownRemoteState: true,
      errorCode: error instanceof AppError ? error.code : "UNKNOWN",
    };
  }
}

export async function getArubaApiOutboundSummary() {
  const result = await getPool().query<{
    document_only: string;
    awaiting_confirmation: string;
    dry_run_pending: string;
    dry_run_validated: string;
    dry_run_failed: string;
    unknown_remote_state: string;
  }>(
    `SELECT
       count(*) FILTER (WHERE status = 'DOCUMENT_ONLY')::text AS document_only,
       count(*) FILTER (WHERE status = 'AWAITING_CONFIRMATION')::text AS awaiting_confirmation,
       count(*) FILTER (WHERE status = 'DRY_RUN_PENDING')::text AS dry_run_pending,
       count(*) FILTER (WHERE status = 'DRY_RUN_VALIDATED')::text AS dry_run_validated,
       count(*) FILTER (WHERE status = 'DRY_RUN_FAILED')::text AS dry_run_failed,
       count(*) FILTER (WHERE status = 'UNKNOWN_REMOTE_STATE')::text AS unknown_remote_state
     FROM aruba_batches WHERE transport = 'API'`,
  );
  return Object.fromEntries(
    Object.entries(result.rows[0]!).map(([key, value]) => [key, Number(value)]),
  );
}

export async function getArubaMonthlyTransmissionUsage() {
  const result = await getPool().query<{ accepted: number }>(
    `SELECT count(*)::integer AS accepted
     FROM aruba_submissions
     WHERE submitted_at >= date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Rome')
             AT TIME ZONE 'Europe/Rome'
       AND submitted_at < (date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Rome')
             + interval '1 month') AT TIME ZONE 'Europe/Rome'`,
  );
  return arubaMonthlyTransmissionUsage(result.rows[0]?.accepted ?? 0);
}
