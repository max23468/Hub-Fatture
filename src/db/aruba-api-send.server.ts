import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import { ARUBA_UPLOAD_MAX_BYTES, effectiveArubaMode, type ArubaMode } from "../aruba.ts";
import { arubaInventoryBlocksAllApprovals } from "../aruba-inventory.ts";
import { getConfig } from "../config.server.ts";
import { AppError } from "../errors.ts";
import { validateFatturaXml } from "../fatturapa.server.ts";
import {
  arubaApiAccountInfoSchema,
  sendUnsignedArubaApiInvoice,
} from "../integrations/aruba-api.server.ts";
import { writeAudit } from "./audit.server.ts";
import {
  authenticateConfiguredArubaApiForOutbound,
  refreshConfiguredArubaApiAfterUnauthorized,
} from "./aruba-api-connection.server.ts";
import { arubaPotentialMatchSql } from "./billing-case-sql.server.ts";
import { withTransaction } from "./client.server.ts";
import { assertJobLease, renewLockedJobLease } from "./connector-jobs.server.ts";
import type { ClaimedJob } from "./connector-types.server.ts";
import { getLockedArubaInventoryHealth } from "./aruba-inventory-health.server.ts";
import {
  assertArubaBatchManifestCurrent,
  currentArubaMode,
  enqueueArubaReadback,
  refreshArubaApiBatchStatus,
} from "./aruba-api-outbound-shared.server.ts";
import { recordArubaApiRateLimited, waitForArubaApiSendSlot } from "./aruba-api-traffic.server.ts";
import { readVerifiedStorageObject } from "./storage-object.server.ts";

interface SendContext {
  attemptId: string;
  attemptNumber: number;
  submissionId: string;
  batchId: string;
  jobId: string;
  accountReference: string;
  xmlSha256: string;
  relativePath: string;
  sizeBytes: number;
}

interface LockedSend {
  submission_id: string;
  document_id: string;
  batch_id: string;
  account_reference: string;
  xml_sha256: string;
  source_filename: string;
  relative_path: string;
  size_bytes: number;
  document_revision: number;
  current_revision: number;
  current_sha256: string;
  document_status: string;
  document_type: string;
  environment: "MOCK" | "PRODUCTION";
  mode: ArubaMode;
  manifest_sha256: string;
}

function submissionIdFromJob(job: ClaimedJob) {
  const submissionId = z.string().regex(/^\d+$/).safeParse(job.payload.submissionId);
  if (!submissionId.success) throw new AppError("ARUBA_BATCH_INVALID", 422);
  return submissionId.data;
}

async function recoverInterruptedSend(job: ClaimedJob) {
  const submissionId = submissionIdFromJob(job);
  return withTransaction(async (client) => {
    await assertJobLease(client, job);
    const interrupted = await client.query<{ attempt_id: string; batch_id: string }>(
      `SELECT attempts.id AS attempt_id, submissions.batch_id
       FROM aruba_submission_attempts AS attempts
       JOIN aruba_submissions AS submissions ON submissions.id = attempts.submission_id
       WHERE submissions.id = $1 AND attempts.operation = 'SEND'
         AND attempts.status = 'RUNNING' AND submissions.status = 'SEND_PENDING'
       FOR UPDATE OF attempts, submissions`,
      [submissionId],
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
         next_readback_at = now(), last_checked_at = now(), remote_status_changed_at = now()
       WHERE id = $1 AND status = 'SEND_PENDING'`,
      [submissionId],
    );
    if (attempt.rowCount !== 1 || submission.rowCount !== 1) {
      throw new AppError("ARUBA_BATCH_INVALID", 409);
    }
    await enqueueArubaReadback(client, submissionId);
    await refreshArubaApiBatchStatus(client, current.batch_id);
    await writeAudit(client, {
      actorType: "SYSTEM",
      action: "ARUBA_API_SEND_UNKNOWN",
      eventClass: "CRITICAL",
      entityType: "ARUBA_SUBMISSION_ATTEMPT",
      entityId: current.attempt_id,
      metadata: { batchId: current.batch_id, provider: "ARUBA", recoveredAfterRestart: true },
      requestId: `aruba-send-recovery:${job.id}`,
    });
    return { submissionId, batchId: current.batch_id };
  });
}

async function prepareSend(job: ClaimedJob): Promise<SendContext> {
  const submissionId = submissionIdFromJob(job);
  return withTransaction(async (client) => {
    await assertJobLease(client, job);
    const result = await client.query<LockedSend>(
      `SELECT submissions.id AS submission_id, submissions.document_id,
              submissions.batch_id, batches.account_reference, submissions.xml_sha256,
              submissions.source_filename, storage.relative_path, storage.size_bytes,
              batch_documents.document_revision, documents.draft_version AS current_revision,
              documents.xml_sha256 AS current_sha256, documents.status AS document_status,
              documents.document_type, batches.environment, batches.mode,
              batches.manifest_sha256
       FROM aruba_submissions AS submissions
       JOIN aruba_batches AS batches ON batches.id = submissions.batch_id
       JOIN aruba_batch_documents AS batch_documents
         ON batch_documents.batch_id = submissions.batch_id
        AND batch_documents.document_id = submissions.document_id
       JOIN documents ON documents.id = submissions.document_id
       JOIN storage_objects AS storage ON storage.id = documents.storage_object_id
       WHERE submissions.id = $1 AND submissions.status = 'SEND_PENDING'
         AND submissions.transport = 'API'
       FOR UPDATE OF submissions, batches, documents`,
      [submissionId],
    );
    const current = result.rows[0];
    const config = getConfig();
    const expectedEnvironment = config.APP_ENV === "production" ? "PRODUCTION" : "MOCK";
    const configuredMode = await currentArubaMode(client);
    if (
      !current ||
      !config.ARUBA_SUBMISSION_ENABLED ||
      current.environment !== expectedEnvironment ||
      current.account_reference !== config.ARUBA_ACCOUNT_REFERENCE ||
      current.mode === "DOCUMENT_ONLY" ||
      effectiveArubaMode(configuredMode, true) !== current.mode ||
      current.document_status !== "APPROVED" ||
      current.document_type !== "TD01" ||
      current.current_revision !== current.document_revision ||
      current.current_sha256 !== current.xml_sha256 ||
      current.size_bytes > ARUBA_UPLOAD_MAX_BYTES
    ) {
      throw new AppError("ARUBA_SEND_NOT_AUTHORIZED", 409);
    }
    await assertArubaBatchManifestCurrent(client, current.batch_id);
    const previous = await client.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM aruba_submission_attempts
       WHERE submission_id = $1 AND operation = 'SEND'`,
      [current.submission_id],
    );
    const attemptNumber = (previous.rows[0]?.count ?? 0) + 1;
    if (attemptNumber > 2) throw new AppError("ARUBA_SEND_NOT_AUTHORIZED", 409);
    const attemptId = randomUUID();
    const fingerprint = createHash("sha256")
      .update(`SEND:${current.submission_id}:${current.manifest_sha256}:${current.xml_sha256}`)
      .digest("hex");
    await client.query(
      `INSERT INTO aruba_submission_attempts
        (id, submission_id, operation, attempt_number, request_fingerprint, xml_sha256,
         status, started_at)
       VALUES ($1, $2, 'SEND', $3, $4, $5, 'RUNNING', now())`,
      [attemptId, current.submission_id, attemptNumber, fingerprint, current.xml_sha256],
    );
    await writeAudit(client, {
      actorType: "SYSTEM",
      action: "ARUBA_API_SEND_STARTED",
      eventClass: "CRITICAL",
      entityType: "ARUBA_SUBMISSION_ATTEMPT",
      entityId: attemptId,
      metadata: { batchId: current.batch_id, provider: "ARUBA", attemptNumber },
      requestId: `aruba-send:${job.id}`,
    });
    return {
      attemptId,
      attemptNumber,
      submissionId: current.submission_id,
      batchId: current.batch_id,
      jobId: job.id,
      accountReference: current.account_reference,
      xmlSha256: current.xml_sha256,
      relativePath: current.relative_path,
      sizeBytes: current.size_bytes,
    };
  });
}

async function assertSendStillAuthorized(context: SendContext, job: ClaimedJob) {
  await withTransaction(async (client) => {
    await renewLockedJobLease(client, job);
    const inventory = await getLockedArubaInventoryHealth(client);
    if (arubaInventoryBlocksAllApprovals(inventory)) {
      throw new AppError("ARUBA_INVENTORY_BLOCKED", 409);
    }
    const current = await client.query<
      LockedSend & {
        connection_status: string;
        api_paused: boolean;
        account_info_json: unknown;
        account_info_checked_at: Date | null;
        current_attempt: boolean;
        duplicate_submission: boolean;
        duplicate_remote_document: boolean;
        duplicate_fiscal_identity: boolean;
        aruba_potential_match: boolean;
        duplicate_job: boolean;
      }
    >(
      `SELECT submissions.id AS submission_id, submissions.document_id,
              submissions.batch_id, batches.account_reference, submissions.xml_sha256,
              submissions.source_filename, storage.relative_path, storage.size_bytes,
              batch_documents.document_revision, documents.draft_version AS current_revision,
              documents.xml_sha256 AS current_sha256, documents.status AS document_status,
              documents.document_type, batches.environment, batches.mode,
              batches.manifest_sha256, connections.status AS connection_status,
              connections.api_paused, connections.account_info_json,
              connections.account_info_checked_at,
              EXISTS (SELECT 1 FROM aruba_submission_attempts AS active_attempt
                WHERE active_attempt.id = $2 AND active_attempt.submission_id = submissions.id
                  AND active_attempt.operation = 'SEND' AND active_attempt.status = 'RUNNING'
                  AND active_attempt.xml_sha256 = submissions.xml_sha256) AS current_attempt,
              EXISTS (SELECT 1 FROM aruba_submissions AS prior
                WHERE prior.document_id = submissions.document_id AND prior.id <> submissions.id
                  AND prior.transport = 'API'
                  AND prior.status IN ('ARUBA_ACCEPTED', 'SUBMITTED', 'SDI_PROCESSING',
                    'DELIVERED', 'NOT_DELIVERED', 'UNKNOWN', 'UNKNOWN_REMOTE_STATE'))
                AS duplicate_submission,
              EXISTS (SELECT 1 FROM aruba_document_matches AS matches
                JOIN aruba_remote_documents AS remote ON remote.id = matches.remote_document_id
                WHERE matches.document_id = submissions.document_id
                  AND matches.status = 'MATCHED' AND remote.remote_status <> 'REJECTED')
                AS duplicate_remote_document,
              EXISTS (SELECT 1 FROM aruba_remote_documents AS remote
                WHERE remote.environment = batches.environment
                  AND remote.account_reference = batches.account_reference
                  AND remote.document_type = documents.document_type
                  AND remote.fiscal_year = documents.fiscal_year
                  AND upper(remote.series) = upper(documents.series)
                  AND btrim(remote.fiscal_number) ~ '^[0-9]+$'
                  AND (btrim(remote.fiscal_number))::integer = documents.fiscal_number)
                AS duplicate_fiscal_identity,
              EXISTS (SELECT 1 FROM billing_cases
                WHERE billing_cases.id = documents.billing_case_id AND ${arubaPotentialMatchSql})
                AS aruba_potential_match,
              EXISTS (SELECT 1 FROM jobs AS duplicate_job
                WHERE duplicate_job.type = 'aruba_send_submission'
                  AND duplicate_job.payload_json ->> 'submissionId' = submissions.id::text
                  AND duplicate_job.id <> $3 AND duplicate_job.status IN ('PENDING', 'RUNNING'))
                AS duplicate_job
       FROM aruba_submissions AS submissions
       JOIN aruba_batches AS batches ON batches.id = submissions.batch_id
       JOIN aruba_batch_documents AS batch_documents
         ON batch_documents.batch_id = submissions.batch_id
        AND batch_documents.document_id = submissions.document_id
       JOIN documents ON documents.id = submissions.document_id
       JOIN storage_objects AS storage ON storage.id = documents.storage_object_id
       JOIN connections ON connections.provider = 'ARUBA'
        AND connections.environment = CASE WHEN batches.environment = 'PRODUCTION'
          THEN 'PRODUCTION' ELSE 'DEVELOPMENT' END
        AND connections.account_reference = batches.account_reference
       WHERE submissions.id = $1 AND submissions.status = 'SEND_PENDING'
         AND submissions.transport = 'API'
       FOR UPDATE OF submissions, batches, documents, connections`,
      [context.submissionId, context.attemptId, context.jobId],
    );
    const row = current.rows[0];
    const config = getConfig();
    const environment = config.APP_ENV === "production" ? "PRODUCTION" : "MOCK";
    const configuredMode = await currentArubaMode(client);
    const account = arubaApiAccountInfoSchema.safeParse(row?.account_info_json);
    const accountFresh = Boolean(
      row?.account_info_checked_at &&
      row.account_info_checked_at.getTime() > Date.now() - 5 * 60_000,
    );
    if (
      !row ||
      !config.ARUBA_SUBMISSION_ENABLED ||
      row.environment !== environment ||
      row.account_reference !== context.accountReference ||
      row.account_reference !== config.ARUBA_ACCOUNT_REFERENCE ||
      row.connection_status !== "CONNECTED" ||
      row.api_paused ||
      row.mode === "DOCUMENT_ONLY" ||
      effectiveArubaMode(configuredMode, true) !== row.mode ||
      row.document_status !== "APPROVED" ||
      row.document_type !== "TD01" ||
      row.current_revision !== row.document_revision ||
      row.current_sha256 !== context.xmlSha256 ||
      row.xml_sha256 !== context.xmlSha256 ||
      row.relative_path !== context.relativePath ||
      row.size_bytes !== context.sizeBytes ||
      row.size_bytes > ARUBA_UPLOAD_MAX_BYTES ||
      !row.current_attempt ||
      row.duplicate_submission ||
      row.duplicate_remote_document ||
      row.duplicate_fiscal_identity ||
      row.aruba_potential_match ||
      row.duplicate_job ||
      !account.success ||
      !accountFresh ||
      account.data.accountStatus.expired ||
      account.data.usageStatus.usedSpaceKB >= account.data.usageStatus.maxSpaceKB
    ) {
      throw new AppError("ARUBA_SEND_NOT_AUTHORIZED", 409);
    }
    await assertArubaBatchManifestCurrent(client, context.batchId);
  });
}

async function finishSend(
  context: SendContext,
  result: Awaited<ReturnType<typeof sendUnsignedArubaApiInvoice>>,
) {
  return withTransaction(async (client) => {
    const accepted = result.accepted && result.errorCode === "0000";
    const retryable = !accepted && result.errorCode === "0095" && context.attemptNumber === 1;
    const unknown = !accepted && result.errorCode === "0034";
    const attemptStatus = accepted ? "SUCCEEDED" : unknown ? "UNKNOWN_REMOTE_STATE" : "FAILED";
    const attempt = await client.query(
      `UPDATE aruba_submission_attempts SET status = $2, provider_reference = $3,
         response_metadata_json = jsonb_build_object('errorCode', $4::text),
         error_code = CASE WHEN $2 = 'SUCCEEDED' THEN NULL ELSE $4 END,
         error_message_sanitized = CASE WHEN $2 = 'SUCCEEDED'
           THEN NULL ELSE 'Trasmissione Aruba rifiutata' END,
         completed_at = now() WHERE id = $1 AND status = 'RUNNING'`,
      [context.attemptId, attemptStatus, result.uploadFileName, result.errorCode],
    );
    const submission = await client.query(
      `UPDATE aruba_submissions SET status = $2,
         provider_filename = coalesce($3, provider_filename),
         accepted_at = CASE WHEN $2 = 'ARUBA_ACCEPTED' THEN now() ELSE accepted_at END,
         next_readback_at = CASE
           WHEN $2 IN ('ARUBA_ACCEPTED', 'UNKNOWN_REMOTE_STATE') THEN now() + interval '2 minutes'
           ELSE NULL END,
         error_code = CASE WHEN $2 IN ('ARUBA_ACCEPTED', 'SEND_PENDING') THEN NULL ELSE $4 END,
         error_message_sanitized = CASE
           WHEN $2 IN ('ARUBA_ACCEPTED', 'SEND_PENDING') THEN NULL
           ELSE 'Trasmissione Aruba rifiutata' END,
         last_checked_at = now(), remote_status_changed_at = now()
       WHERE id = $1 AND status = 'SEND_PENDING'`,
      [
        context.submissionId,
        accepted
          ? "ARUBA_ACCEPTED"
          : retryable
            ? "SEND_PENDING"
            : unknown
              ? "UNKNOWN_REMOTE_STATE"
              : "SEND_FAILED",
        result.uploadFileName,
        result.errorCode,
      ],
    );
    if (attempt.rowCount !== 1 || submission.rowCount !== 1) {
      throw new AppError("ARUBA_BATCH_INVALID", 409);
    }
    if (accepted || unknown) await enqueueArubaReadback(client, context.submissionId);
    await refreshArubaApiBatchStatus(client, context.batchId);
    await writeAudit(client, {
      actorType: "SYSTEM",
      action: unknown
        ? "ARUBA_API_SEND_UNKNOWN"
        : accepted
          ? "ARUBA_API_SEND_ACCEPTED"
          : "ARUBA_API_SEND_FAILED",
      eventClass: "CRITICAL",
      entityType: "ARUBA_SUBMISSION_ATTEMPT",
      entityId: context.attemptId,
      metadata: {
        batchId: context.batchId,
        provider: "ARUBA",
        resultClass: accepted ? "ACCEPTED" : unknown ? "UNKNOWN" : "REJECTED",
      },
      requestId: `aruba-send:${context.attemptId}`,
    });
    return { accepted, retryable, unknownRemoteState: unknown };
  });
}

async function markSendUnknown(context: SendContext, errorCode: string) {
  await withTransaction(async (client) => {
    const attempt = await client.query(
      `UPDATE aruba_submission_attempts SET status = 'UNKNOWN_REMOTE_STATE', error_code = $2,
         error_message_sanitized = 'Esito remoto non confermato', completed_at = now()
       WHERE id = $1 AND status = 'RUNNING'`,
      [context.attemptId, errorCode],
    );
    const submission = await client.query(
      `UPDATE aruba_submissions SET status = 'UNKNOWN_REMOTE_STATE', error_code = $2,
         error_message_sanitized = 'Esito remoto non confermato',
         next_readback_at = now() + interval '2 minutes', last_checked_at = now(),
         remote_status_changed_at = now()
       WHERE id = $1 AND status = 'SEND_PENDING'`,
      [context.submissionId, errorCode],
    );
    if (attempt.rowCount !== 1 || submission.rowCount !== 1) {
      throw new AppError("ARUBA_BATCH_INVALID", 409);
    }
    await enqueueArubaReadback(client, context.submissionId);
    await refreshArubaApiBatchStatus(client, context.batchId);
    await writeAudit(client, {
      actorType: "SYSTEM",
      action: "ARUBA_API_SEND_UNKNOWN",
      eventClass: "CRITICAL",
      entityType: "ARUBA_SUBMISSION_ATTEMPT",
      entityId: context.attemptId,
      metadata: { batchId: context.batchId, provider: "ARUBA", resultClass: "UNKNOWN" },
      reason: errorCode,
      requestId: `aruba-send:${context.attemptId}`,
    });
  });
}

async function failQueuedSend(job: ClaimedJob, errorCode: string) {
  const submissionId = submissionIdFromJob(job);
  return withTransaction(async (client) => {
    await assertJobLease(client, job);
    const failed = await client.query<{ batch_id: string }>(
      `UPDATE aruba_submissions SET status = 'SEND_FAILED', error_code = $2,
         error_message_sanitized = 'Prerequisiti dell’invio non più validi',
         next_readback_at = NULL, last_checked_at = now(), remote_status_changed_at = now()
       WHERE id = $1 AND status = 'SEND_PENDING'
       RETURNING batch_id`,
      [submissionId, errorCode],
    );
    const batchId = failed.rows[0]?.batch_id;
    if (!batchId) return null;
    await refreshArubaApiBatchStatus(client, batchId);
    await writeAudit(client, {
      actorType: "SYSTEM",
      action: "ARUBA_API_SEND_FAILED",
      eventClass: "CRITICAL",
      entityType: "ARUBA_SUBMISSION",
      entityId: submissionId,
      metadata: { batchId, provider: "ARUBA", resultClass: "REJECTED" },
      reason: errorCode,
      requestId: `aruba-send-preflight:${job.id}`,
    });
    return { submissionId, batchId };
  });
}

export async function runArubaApiSendJob(job: ClaimedJob) {
  const interrupted = await recoverInterruptedSend(job);
  if (interrupted) return { accepted: false, unknownRemoteState: true, ...interrupted };

  let context: SendContext;
  try {
    context = await prepareSend(job);
  } catch (error) {
    if (error instanceof AppError && error.code !== "CONFLICT_REVISION") {
      const failed = await failQueuedSend(job, error.code);
      if (failed) return { accepted: false, errorCode: error.code, ...failed };
    }
    throw error;
  }

  let mutationMayHaveEffect = false;
  try {
    const xml = await readVerifiedStorageObject({
      relativePath: context.relativePath,
      sha256: context.xmlSha256,
      sizeBytes: context.sizeBytes,
    });
    await validateFatturaXml(xml.toString("utf8"));
    const authenticated = await authenticateConfiguredArubaApiForOutbound();
    if (authenticated.accountReference !== context.accountReference) {
      throw new AppError("ARUBA_ACCOUNT_MISMATCH", 409);
    }
    await assertSendStillAuthorized(context, job);
    await waitForArubaApiSendSlot(authenticated.session.environment);
    await assertSendStillAuthorized(context, job);
    let result;
    try {
      mutationMayHaveEffect = true;
      result = await sendUnsignedArubaApiInvoice(authenticated.session, xml);
    } catch (error) {
      if (error instanceof AppError && error.code === "PROVIDER_RATE_LIMITED") {
        mutationMayHaveEffect = false;
        throw error;
      }
      if (!(error instanceof AppError) || error.code !== "AUTH_PROVIDER_EXPIRED") throw error;
      mutationMayHaveEffect = false;
      const refreshed = await refreshConfiguredArubaApiAfterUnauthorized();
      await assertSendStillAuthorized(context, job);
      await waitForArubaApiSendSlot(refreshed.session.environment);
      await assertSendStillAuthorized(context, job);
      try {
        mutationMayHaveEffect = true;
        result = await sendUnsignedArubaApiInvoice(refreshed.session, xml);
      } catch (retryError) {
        if (
          retryError instanceof AppError &&
          ["AUTH_PROVIDER_EXPIRED", "PROVIDER_RATE_LIMITED"].includes(retryError.code)
        ) {
          mutationMayHaveEffect = false;
        }
        throw retryError;
      }
    }
    const completed = await finishSend(context, result);
    return {
      submissionId: context.submissionId,
      ...completed,
      continuationPending: completed.retryable,
      continuationDelayMs: completed.retryable ? 5 * 60_000 : undefined,
    };
  } catch (error) {
    if (error instanceof AppError && error.code === "CONFLICT_REVISION") throw error;
    if (error instanceof AppError && error.code === "PROVIDER_RATE_LIMITED") {
      await recordArubaApiRateLimited(
        getConfig().APP_ENV === "production" ? "PRODUCTION" : "DEMO",
        "SEND",
      );
    }
    if (!mutationMayHaveEffect) {
      const errorCode = error instanceof AppError ? error.code : "UNKNOWN";
      await finishSend(context, {
        accepted: false,
        errorCode,
        errorDescription: "Prerequisiti dell’invio non soddisfatti",
        uploadFileName: null,
      });
      return { submissionId: context.submissionId, accepted: false, errorCode };
    }
    await markSendUnknown(context, error instanceof AppError ? error.code : "UNKNOWN");
    return { submissionId: context.submissionId, accepted: false, unknownRemoteState: true };
  }
}
