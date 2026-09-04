import { randomUUID } from "node:crypto";

import type pg from "pg";
import { z } from "zod";

import {
  ARUBA_UPLOAD_MAX_BATCH_BYTES,
  arubaManifestDocumentSchema,
  arubaMonthlyTransmissionUsage,
  effectiveArubaMode,
  manifestSha256,
  type ArubaManifestDocument,
  type ArubaMode,
} from "../aruba.ts";
import { getConfig } from "../config.server.ts";
import { AppError } from "../errors.ts";
import { writeAudit } from "./audit.server.ts";
import { getPool, withTransaction } from "./client.server.ts";
import type { ClaimedJob } from "./connector-types.server.ts";
import {
  arubaApiManifestPayload,
  arubaOutboundConnectionReady,
  assertArubaBatchManifestCurrent,
  currentArubaMode,
  type ArubaOutboundActor,
} from "./aruba-api-outbound-shared.server.ts";
import { runArubaApiSendJob } from "./aruba-api-send.server.ts";

type BatchStatus = "DOCUMENT_ONLY" | "AWAITING_CONFIRMATION" | "SEND_PENDING";

function batchStatus(mode: ArubaMode): BatchStatus {
  if (mode === "DOCUMENT_ONLY") return "DOCUMENT_ONLY";
  if (mode === "CONTEXTUAL_CONFIRMATION") return "AWAITING_CONFIRMATION";
  return "SEND_PENDING";
}

function submissionStatus(mode: ArubaMode) {
  return mode === "AUTOMATIC_AFTER_APPROVAL" ? "SEND_PENDING" : "PENDING";
}

async function enqueueSend(client: pg.PoolClient, submissionId: string) {
  await client.query(
    `INSERT INTO jobs (type, payload_json, max_attempts)
     VALUES ('aruba_send_submission', jsonb_build_object('submissionId', $1::text), 1)
     ON CONFLICT DO NOTHING`,
    [submissionId],
  );
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
  const configuredMode = await currentArubaMode(client);
  const mode = effectiveArubaMode(configuredMode, config.ARUBA_SUBMISSION_ENABLED);
  if (expectedMode !== undefined && expectedMode !== mode) {
    throw new AppError("DOCUMENT_PROJECTION_STALE", 409);
  }
  if (configuredMode !== mode && !confirmDocumentOnlyDowngrade) {
    throw new AppError("DOCUMENT_NOT_APPROVABLE", 409);
  }
  if (
    mode !== "DOCUMENT_ONLY" &&
    !(await arubaOutboundConnectionReady(client, environment, config.ARUBA_ACCOUNT_REFERENCE))
  ) {
    throw new AppError("ARUBA_SUBMISSION_PAUSED", 409);
  }
  const batchId = randomUUID();
  const payload = arubaApiManifestPayload(
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
         manifest_sha256, xml_sha256, source_filename, status)
       VALUES ($1, $2, 1, $3, $4, 'API', $5, $6, $7, $8)
       RETURNING id`,
      [
        batchId,
        document.id,
        environment,
        mode,
        digest,
        document.sha256,
        document.filename,
        submissionStatus(mode),
      ],
    );
    if (mode === "AUTOMATIC_AFTER_APPROVAL") {
      await enqueueSend(client, inserted.rows[0]!.id);
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
    const configuredMode = await currentArubaMode(client);
    if (
      current.environment !== environment ||
      current.account_reference !== config.ARUBA_ACCOUNT_REFERENCE ||
      effectiveArubaMode(configuredMode, config.ARUBA_SUBMISSION_ENABLED) !== current.mode ||
      !(await arubaOutboundConnectionReady(client, environment, config.ARUBA_ACCOUNT_REFERENCE))
    ) {
      throw new AppError("ARUBA_SUBMISSION_PAUSED", 409);
    }
    await assertArubaBatchManifestCurrent(client, batchId);
    const submissions = await client.query<{ id: string }>(
      `UPDATE aruba_submissions SET status = 'SEND_PENDING'
       WHERE batch_id = $1 AND transport = 'API' AND status = 'PENDING'
       RETURNING id`,
      [batchId],
    );
    if (!submissions.rows.length) throw new AppError("ARUBA_BATCH_INVALID", 409);
    await client.query(
      "UPDATE aruba_batches SET status = 'SEND_PENDING', updated_at = now() WHERE id = $1",
      [batchId],
    );
    for (const submission of submissions.rows) await enqueueSend(client, submission.id);
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

export async function runArubaApiOutboundJob(
  job: ClaimedJob,
): Promise<Record<string, unknown> & { accepted?: boolean }> {
  if (job.type !== "aruba_send_submission") {
    throw new AppError("ARUBA_SEND_NOT_AUTHORIZED", 409);
  }
  return runArubaApiSendJob(job);
}

export async function getArubaMonthlyTransmissionUsage() {
  const result = await getPool().query<{ accepted: number }>(
    `SELECT count(*)::integer AS accepted
     FROM aruba_submissions
     WHERE accepted_at >= date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Rome')
             AT TIME ZONE 'Europe/Rome'
       AND accepted_at < (date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Rome')
             + interval '1 month') AT TIME ZONE 'Europe/Rome'`,
  );
  return arubaMonthlyTransmissionUsage(result.rows[0]?.accepted ?? 0);
}
