import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import {
  arubaReadbackJobPayloadSchema,
  type ArubaReadbackJobPayload,
} from "../aruba-api-readback.ts";
import { normalizeArubaRemoteStatusLabel } from "../aruba-inbound.ts";
import {
  arubaSubmissionIsTerminal,
  arubaSubmissionJobPriority,
  arubaSubmissionTransition,
  type ArubaReadbackStatus,
  type MonitoredArubaSubmissionStatus,
} from "../aruba-submission-state.ts";
import { AppError } from "../errors.ts";
import { ARUBA_API_POLICY, type ArubaApiTrafficScope } from "../aruba-api-policy.ts";
import {
  ARUBA_API_V2_CONTRACT,
  readArubaApiInvoiceDetail,
  readArubaApiInvoicePage,
  readArubaApiNotifications,
} from "../integrations/aruba-api.server.ts";
import { writeAudit } from "./audit.server.ts";
import {
  authenticateConfiguredArubaApiForOutbound,
  refreshConfiguredArubaApiAfterUnauthorized,
} from "./aruba-api-connection.server.ts";
import { reconcileArubaApiOutboundReadback } from "./aruba-api-inbound.server.ts";
import {
  arubaProviderCall,
  connection,
  connectionEnvironment,
  inventoryEnvironment,
  storedApiEnvironment,
} from "./aruba-api-context.server.ts";
import { scheduleArubaEmissionEffects } from "./aruba-emission-effects.server.ts";
import { requeueAuthoritativelyRejectedInvoice } from "./rejected-invoice-requeue.server.ts";
import {
  refreshArubaApiBatchStatus,
  type ArubaOutboundActor,
} from "./aruba-api-outbound-shared.server.ts";
import { arubaApiCooldownDelayMs, waitForArubaApiReadSlot } from "./aruba-api-traffic.server.ts";
import { getPool, withTransaction } from "./client.server.ts";
import { assertJobLease, renewLockedJobLease } from "./connector-jobs.server.ts";
import type { ClaimedJob } from "./connector-types.server.ts";

type ConnectedArubaApi = Awaited<ReturnType<typeof authenticateConfiguredArubaApiForOutbound>>;
type AdvancedPayload = Extract<ArubaReadbackJobPayload, { readbackKind: "advanced" }>;
type TargetedPayload = Extract<ArubaReadbackJobPayload, { readbackKind: "targeted" }>;

class ArubaReadClient {
  private connected: ConnectedArubaApi | null = null;
  private latestScope: ArubaApiTrafficScope = "AUTH";
  private readonly job: ClaimedJob;

  constructor(job: ClaimedJob) {
    this.job = job;
  }

  async accountReference() {
    return (await this.connection()).accountReference;
  }

  async read<T>(
    scope: "INVOICE_READ" | "NOTIFICATION_READ",
    call: (session: ConnectedArubaApi["session"]) => Promise<T>,
  ) {
    const run = async () => {
      const connected = await this.connection();
      this.latestScope = scope;
      await withTransaction((client) => assertJobLease(client, this.job));
      await waitForArubaApiReadSlot(connected.session.environment, scope);
      await withTransaction((client) => renewLockedJobLease(client, this.job));
      return arubaProviderCall(connected.session.environment, scope, () => call(connected.session));
    };
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "AUTH_PROVIDER_EXPIRED") throw error;
      this.latestScope = "AUTH";
      this.connected = await refreshConfiguredArubaApiAfterUnauthorized();
      return run();
    }
  }

  async environment() {
    if (this.connected) return this.connected.session.environment;
    const current = await connection(getPool());
    if (!current) throw new AppError("PROVIDER_NOT_CONFIGURED", 503);
    return storedApiEnvironment(current);
  }

  async cooldownDelayMs() {
    return arubaApiCooldownDelayMs(
      await this.environment(),
      this.latestScope,
      this.latestScope === "AUTH" ? ARUBA_API_POLICY.authenticationIntervalMs : 15 * 60_000,
    );
  }

  private async connection() {
    this.connected ??= await authenticateConfiguredArubaApiForOutbound();
    return this.connected;
  }
}

async function continueAfterArubaReadLimit(error: unknown, reader: ArubaReadClient) {
  if (
    !(error instanceof AppError) ||
    ![
      "PROVIDER_RATE_LIMITED",
      "ARUBA_API_COOLDOWN_ACTIVE",
      "ARUBA_API_AUTH_INTERVAL_ACTIVE",
    ].includes(error.code)
  ) {
    throw error;
  }
  return {
    continuationPending: true as const,
    continuationDelayMs: await reader.cooldownDelayMs(),
  };
}

async function runSubmissionReadback(job: ClaimedJob, submissionId: string) {
  let reader: ArubaReadClient | null = null;
  const context = await withTransaction(async (client) => {
    await assertJobLease(client, job);
    const result = await client.query<{
      batch_id: string;
      account_reference: string;
      provider_filename: string | null;
      source_filename: string;
      xml_sha256: string;
      document_id: string;
      environment: "MOCK" | "PRODUCTION";
      status: MonitoredArubaSubmissionStatus;
    }>(
      `SELECT submissions.batch_id, batches.account_reference,
              submissions.provider_filename, submissions.source_filename,
              submissions.xml_sha256, submissions.document_id::text,
              submissions.environment, submissions.status
       FROM aruba_submissions submissions
       JOIN aruba_batches batches ON batches.id = submissions.batch_id
       WHERE submissions.id = $1 AND (
         submissions.status IN
           ('ARUBA_ACCEPTED', 'SDI_PROCESSING', 'SUBMITTED', 'UNKNOWN', 'UNKNOWN_REMOTE_STATE')
         OR submissions.error_code = 'ARUBA_INVENTORY_CONFLICT'
       )
       FOR UPDATE OF submissions`,
      [submissionId],
    );
    const current = result.rows[0];
    if (!current) return null;
    const number = await client.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM aruba_submission_attempts
       WHERE submission_id = $1 AND operation = 'READBACK'`,
      [submissionId],
    );
    await client.query(
      `UPDATE aruba_submission_attempts SET status = 'FAILED',
         error_code = 'CONFLICT_REVISION',
         error_message_sanitized = 'Readback interrotto prima del completamento',
         completed_at = now()
       WHERE submission_id = $1 AND operation = 'READBACK' AND status = 'RUNNING'`,
      [submissionId],
    );
    const attemptId = randomUUID();
    await client.query(
      `INSERT INTO aruba_submission_attempts
        (id, submission_id, operation, attempt_number, request_fingerprint, xml_sha256,
         status, started_at)
       VALUES ($1, $2, 'READBACK', $3, $4, $5, 'RUNNING', now())`,
      [
        attemptId,
        submissionId,
        (number.rows[0]?.count ?? 0) + 1,
        createHash("sha256")
          .update(
            `READBACK:${submissionId}:${current.provider_filename ?? current.source_filename}`,
          )
          .digest("hex"),
        current.xml_sha256,
      ],
    );
    return { ...current, attemptId };
  });
  if (!context) return { stopped: true };
  try {
    reader = new ArubaReadClient(job);
    if ((await reader.accountReference()) !== context.account_reference) {
      throw new AppError("ARUBA_ACCOUNT_MISMATCH", 409);
    }
    const detail = await reader.read("INVOICE_READ", (session) =>
      readArubaApiInvoiceDetail(session, {
        filename: context.provider_filename ?? context.source_filename,
      }),
    );
    const notifications = await reader.read("NOTIFICATION_READ", (session) =>
      readArubaApiNotifications(session, detail.id),
    );
    const reconciled = await reconcileArubaApiOutboundReadback(detail, notifications);
    if (!reconciled) {
      await withTransaction(async (client) => {
        await assertJobLease(client, job);
        await client.query(
          `UPDATE aruba_submission_attempts SET status = 'CANCELLED', completed_at = now()
           WHERE id = $1 AND status = 'RUNNING'`,
          [context.attemptId],
        );
      });
      return { continuationPending: true, continuationDelayMs: 5_000 };
    }
    if (detail.invoices.length !== 1) throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
    const detailStatus = normalizeArubaRemoteStatusLabel(detail.invoices[0]!.status);
    const canonicalStatus = await getPool().query<{ remote_status: ArubaReadbackStatus }>(
      `SELECT DISTINCT remote_status
       FROM aruba_remote_documents
       WHERE environment = $1 AND account_reference = $2 AND provider_group_id = $3`,
      [context.environment, context.account_reference, detail.id],
    );
    if (canonicalStatus.rows.length !== 1) throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
    const observedStatus = canonicalStatus.rows[0]!.remote_status;
    const committed = await withTransaction(async (client) => {
      await assertJobLease(client, job);
      const locked = await client.query<{
        status: MonitoredArubaSubmissionStatus | ArubaReadbackStatus;
      }>(`SELECT status FROM aruba_submissions WHERE id = $1 FOR UPDATE`, [submissionId]);
      const currentStatus = locked.rows[0]?.status;
      if (!currentStatus) throw new AppError("ARUBA_BATCH_INVALID", 409);
      const transition = arubaSubmissionTransition(currentStatus, observedStatus);
      const committedStatus = transition === "ADVANCE" ? observedStatus : currentStatus;
      const terminal = arubaSubmissionIsTerminal(committedStatus);
      const attempt = await client.query(
        `UPDATE aruba_submission_attempts SET status = $2, provider_reference = $3,
           response_metadata_json = jsonb_build_object(
             'remoteStatus', $4::text, 'transition', $5::text),
           error_code = CASE WHEN $2 = 'FAILED' THEN 'ARUBA_INVENTORY_CONFLICT' ELSE NULL END,
           error_message_sanitized = CASE WHEN $2 = 'FAILED'
             THEN 'Stato remoto incompatibile con lo stato già acquisito' ELSE NULL END,
           completed_at = now()
         WHERE id = $1 AND status = 'RUNNING'`,
        [
          context.attemptId,
          transition === "CONFLICT" ? "FAILED" : "SUCCEEDED",
          detail.id,
          observedStatus,
          transition,
        ],
      );
      const submission = await client.query(
        `UPDATE aruba_submissions SET status = $2, remote_id = coalesce($3, remote_id),
           provider_filename = $4, provider_sdi_id = $5,
           submitted_at = CASE WHEN $2 IN ('SUBMITTED', 'DELIVERED', 'NOT_DELIVERED', 'REJECTED')
             THEN coalesce(submitted_at, now()) ELSE submitted_at END,
           next_readback_at = CASE WHEN $6 THEN NULL ELSE now() + interval '15 minutes' END,
           readback_metadata_json = jsonb_build_object(
             'remoteStatus', $7::text, 'transition', $8::text),
           error_code = CASE WHEN $8 = 'CONFLICT' THEN 'ARUBA_INVENTORY_CONFLICT' ELSE NULL END,
           error_message_sanitized = CASE WHEN $8 = 'CONFLICT'
             THEN 'Stato remoto incompatibile con lo stato già acquisito' ELSE NULL END,
           last_checked_at = now(),
           remote_status_changed_at = CASE WHEN $8 = 'ADVANCE'
             THEN now() ELSE remote_status_changed_at END
         WHERE id = $1`,
        [
          submissionId,
          committedStatus,
          detail.id,
          detail.filename,
          detail.idSdi,
          terminal,
          observedStatus,
          transition,
        ],
      );
      if (attempt.rowCount !== 1 || submission.rowCount !== 1) {
        throw new AppError("ARUBA_BATCH_INVALID", 409);
      }
      await client.query(
        `UPDATE aruba_files AS files SET document_id = $1
         WHERE files.document_id IS NULL AND files.remote_document_id IN (
           SELECT matches.remote_document_id FROM aruba_document_matches AS matches
           WHERE matches.document_id = $1 AND matches.status = 'MATCHED'
         )`,
        [context.document_id],
      );
      await refreshArubaApiBatchStatus(client, context.batch_id);
      if (transition === "ADVANCE") {
        await writeAudit(client, {
          actorType: "SYSTEM",
          action: "ARUBA_API_READBACK_COMPLETED",
          eventClass: "OPERATIONAL",
          entityType: "ARUBA_SUBMISSION",
          entityId: submissionId,
          metadata: { provider: "ARUBA", remoteStatus: observedStatus },
          before: { status: currentStatus },
          after: { status: committedStatus, detailStatus },
          requestId: `aruba-readback:${job.id}`,
        });
      } else if (transition === "CONFLICT") {
        await writeAudit(client, {
          actorType: "SYSTEM",
          action: "ARUBA_API_READBACK_CONFLICT",
          eventClass: "CRITICAL",
          entityType: "ARUBA_SUBMISSION",
          entityId: submissionId,
          metadata: { provider: "ARUBA", remoteStatus: observedStatus },
          before: { status: currentStatus },
          after: { observedStatus },
          requestId: `aruba-readback:${job.id}`,
        });
      }
      if (transition === "ADVANCE" && ["DELIVERED", "NOT_DELIVERED"].includes(committedStatus)) {
        await scheduleArubaEmissionEffects(client, context.document_id);
      }
      if (transition === "ADVANCE" && committedStatus === "REJECTED") {
        await requeueAuthoritativelyRejectedInvoice(client, submissionId, {
          requestId: `aruba-readback:${job.id}`,
        });
      }
      return { status: committedStatus, terminal, transition };
    });
    return {
      submissionId,
      status: committed.status,
      transition: committed.transition,
      terminal: committed.terminal,
      continuationPending: !committed.terminal,
      continuationDelayMs: 15 * 60_000,
    };
  } catch (error) {
    const errorCode = error instanceof AppError ? error.code : "UNKNOWN";
    if (errorCode === "CONFLICT_REVISION") throw error;
    const rateLimited = [
      "PROVIDER_RATE_LIMITED",
      "ARUBA_API_COOLDOWN_ACTIVE",
      "ARUBA_API_AUTH_INTERVAL_ACTIVE",
    ].includes(errorCode);
    const delayMs = rateLimited && reader ? await reader.cooldownDelayMs() : 15 * 60_000;
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE aruba_submission_attempts SET status = 'FAILED', error_code = $2,
           error_message_sanitized = 'Readback Aruba non riuscito', completed_at = now()
         WHERE id = $1 AND status = 'RUNNING'`,
        [context.attemptId, errorCode],
      );
      await client.query(
        `UPDATE aruba_submissions SET
           next_readback_at = now() + make_interval(secs => $2::double precision / 1000),
           last_checked_at = now() WHERE id = $1`,
        [submissionId, delayMs],
      );
    });
    return {
      submissionId,
      status: "PENDING_READBACK",
      continuationPending: true,
      continuationDelayMs: delayMs,
    };
  }
}

async function runTargetedLookupJob(job: ClaimedJob, lookup: TargetedPayload) {
  const reader = new ArubaReadClient(job);
  try {
    const detail = await reader.read("INVOICE_READ", (session) =>
      readArubaApiInvoiceDetail(session, { [lookup.lookupType]: lookup.lookupValue }),
    );
    const notifications = await reader.read("NOTIFICATION_READ", (session) =>
      readArubaApiNotifications(session, detail.id),
    );
    const reconciled = await reconcileArubaApiOutboundReadback(detail, notifications);
    if (!reconciled) return { continuationPending: true, continuationDelayMs: 5_000 };
    return {
      lookupType: lookup.lookupType,
      remoteId: detail.id,
      filename: detail.filename,
      idSdi: detail.idSdi,
      ...reconciled,
    };
  } catch (error) {
    return continueAfterArubaReadLimit(error, reader);
  }
}

async function checkpointAdvancedJob(job: ClaimedJob, payload: AdvancedPayload) {
  await withTransaction(async (client) => {
    await assertJobLease(client, job);
    await client.query("UPDATE jobs SET payload_json = $2::jsonb WHERE id = $1", [
      job.id,
      JSON.stringify(payload),
    ]);
  });
}

async function runAdvancedSearchJob(job: ClaimedJob, input: AdvancedPayload) {
  const reader = new ArubaReadClient(job);
  try {
    let payload = input;
    if (payload.groupIds.length === 0) {
      const page = await reader.read("INVOICE_READ", (session) =>
        readArubaApiInvoicePage({
          session,
          page: payload.page,
          size: 100,
          windowStart: new Date(payload.creationStart),
          windowEnd: new Date(payload.creationEnd),
          filters: {
            receiverCountry: payload.receiverCountry,
            receiverVatCode: payload.receiverVatCode,
            receiverFiscalCode: payload.receiverFiscalCode,
            documentType: payload.documentType,
            status: payload.status,
            modifiedStart: payload.modifiedStart ? new Date(payload.modifiedStart) : undefined,
            modifiedEnd: payload.modifiedEnd ? new Date(payload.modifiedEnd) : undefined,
          },
        }),
      );
      payload = {
        ...payload,
        groupIds: page.groups.map((group) => group.id),
        groupIndex: 0,
        pageTerminal: page.terminal,
        pages: payload.pages + 1,
      };
      if (payload.groupIds.length === 0) {
        if (payload.pageTerminal) {
          return { pages: payload.pages, groups: payload.groups, documents: payload.documents };
        }
        payload = { ...payload, page: payload.page + 1 };
        await checkpointAdvancedJob(job, payload);
        return { continuationPending: true, continuationDelayMs: 1_000 };
      }
    }
    const providerGroupId = payload.groupIds[payload.groupIndex];
    if (!providerGroupId) throw new AppError("ARUBA_BATCH_INVALID", 422);
    const detail = await reader.read("INVOICE_READ", (session) =>
      readArubaApiInvoiceDetail(session, { id: providerGroupId }),
    );
    const notifications = await reader.read("NOTIFICATION_READ", (session) =>
      readArubaApiNotifications(session, providerGroupId),
    );
    const reconciled = await reconcileArubaApiOutboundReadback(detail, notifications);
    if (!reconciled) return { continuationPending: true, continuationDelayMs: 5_000 };
    const nextIndex = payload.groupIndex + 1;
    payload = {
      ...payload,
      groupIndex: nextIndex,
      groups: payload.groups + 1,
      documents: payload.documents + reconciled.documents,
    };
    if (nextIndex < payload.groupIds.length) {
      await checkpointAdvancedJob(job, payload);
      return { continuationPending: true, continuationDelayMs: 1_000 };
    }
    if (payload.pageTerminal) {
      return { pages: payload.pages, groups: payload.groups, documents: payload.documents };
    }
    payload = {
      ...payload,
      page: payload.page + 1,
      groupIds: [],
      groupIndex: 0,
      pageTerminal: false,
    };
    await checkpointAdvancedJob(job, payload);
    return { continuationPending: true, continuationDelayMs: 1_000 };
  } catch (error) {
    return continueAfterArubaReadLimit(error, reader);
  }
}

export async function runArubaApiReadbackJob(job: ClaimedJob) {
  if (job.type !== "aruba_readback_submission") {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 422);
  }
  const payload = arubaReadbackJobPayloadSchema.safeParse(job.payload);
  if (!payload.success) throw new AppError("ARUBA_BATCH_INVALID", 422);
  const active = await getPool().query(
    `SELECT 1 FROM aruba_sync_runs AS runs
     JOIN connections ON connections.provider = 'ARUBA'
       AND connections.environment = $1 AND connections.account_reference = runs.account_reference
     WHERE runs.environment = $2 AND runs.status = 'RUNNING' LIMIT 1`,
    [connectionEnvironment(), inventoryEnvironment()],
  );
  if (active.rows[0]) return { continuationPending: true, continuationDelayMs: 5_000 };
  if (payload.data.readbackKind === "submission") {
    return runSubmissionReadback(job, payload.data.submissionId);
  }
  if (payload.data.readbackKind === "advanced") return runAdvancedSearchJob(job, payload.data);
  return runTargetedLookupJob(job, payload.data);
}

export async function requestArubaSubmissionReadback(
  documentId: string,
  actor: ArubaOutboundActor,
) {
  if (!actor.canApprove) throw new AppError("ARUBA_OPERATION_FORBIDDEN", 403);
  if (!z.string().regex(/^\d+$/).safeParse(documentId).success) {
    throw new AppError("ARUBA_BATCH_INVALID", 422);
  }
  return withTransaction(async (client) => {
    const result = await client.query<{ id: string; status: string }>(
      `SELECT submissions.id, submissions.status FROM aruba_submissions submissions
       JOIN aruba_batches batches ON batches.id = submissions.batch_id
       WHERE submissions.document_id = $1 AND submissions.transport = 'API'
         AND (submissions.status IN ('ARUBA_ACCEPTED', 'SDI_PROCESSING', 'SUBMITTED',
           'UNKNOWN', 'UNKNOWN_REMOTE_STATE')
           OR submissions.error_code = 'ARUBA_INVENTORY_CONFLICT')
       ORDER BY batches.created_at DESC LIMIT 1 FOR UPDATE OF submissions`,
      [documentId],
    );
    const submission = result.rows[0];
    if (!submission) throw new AppError("ARUBA_BATCH_INVALID", 409);
    const priority = arubaSubmissionJobPriority(submission.status, true);
    const rescheduled = await client.query(
      `UPDATE jobs SET run_at = now(), priority = least(priority, $2)
       WHERE type = 'aruba_readback_submission'
         AND payload_json ->> 'submissionId' = $1 AND status = 'PENDING'`,
      [submission.id, priority],
    );
    if (!rescheduled.rowCount) {
      await client.query(
        `INSERT INTO jobs (type, payload_json, max_attempts, priority)
         VALUES ('aruba_readback_submission', jsonb_build_object(
           'readbackKind', 'submission', 'submissionId', $1::text), 1, $2)
         ON CONFLICT DO NOTHING`,
        [submission.id, priority],
      );
    }
    await client.query("UPDATE aruba_submissions SET next_readback_at = now() WHERE id = $1", [
      submission.id,
    ]);
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "ARUBA_API_READBACK_REQUESTED",
      eventClass: "OPERATIONAL",
      entityType: "ARUBA_SUBMISSION",
      entityId: submission.id,
      metadata: { provider: "ARUBA" },
      requestId: actor.requestId,
    });
    return { queued: true, submissionId: submission.id };
  });
}

export async function requestArubaTargetedLookup(
  input: { filename?: string; idSdi?: string },
  actor: ArubaOutboundActor,
) {
  if (!actor.canApprove) throw new AppError("ARUBA_OPERATION_FORBIDDEN", 403);
  const entries = Object.entries(input).filter(([, value]) => Boolean(value?.trim()));
  if (entries.length !== 1) throw new AppError("ARUBA_BATCH_INVALID", 422);
  const [lookupType, rawValue] = entries[0]!;
  if (!(["filename", "idSdi"] as const).includes(lookupType as "filename")) {
    throw new AppError("ARUBA_BATCH_INVALID", 422);
  }
  const value = z
    .string()
    .trim()
    .min(1)
    .max(lookupType === "idSdi" ? 200 : 255)
    .safeParse(rawValue);
  if (!value.success) throw new AppError("ARUBA_BATCH_INVALID", 422);
  return withTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO jobs (type, payload_json, max_attempts, priority)
       VALUES ('aruba_readback_submission', jsonb_build_object(
         'readbackKind', 'targeted', 'lookupType', $1::text,
         'lookupValue', $2::text, 'requestedBy', $3::text), 1, 40)
       RETURNING id`,
      [lookupType, value.data, String(actor.id)],
    );
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "ARUBA_API_READBACK_REQUESTED",
      eventClass: "OPERATIONAL",
      entityType: "JOB",
      entityId: inserted.rows[0]!.id,
      metadata: { provider: "ARUBA", scope: lookupType },
      requestId: actor.requestId,
    });
    return { queued: true, jobId: inserted.rows[0]!.id };
  });
}

export async function requestArubaAdvancedSearch(
  input: Record<string, string | undefined>,
  actor: ArubaOutboundActor,
) {
  if (!actor.canApprove) throw new AppError("ARUBA_OPERATION_FORBIDDEN", 403);
  const parsed = z
    .object({
      creationStart: z.coerce.date(),
      creationEnd: z.coerce.date(),
      modifiedStart: z.coerce.date().optional(),
      modifiedEnd: z.coerce.date().optional(),
      receiverCountry: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{2}$/)
        .optional(),
      receiverVatCode: z.string().trim().max(64).optional(),
      receiverFiscalCode: z.string().trim().max(64).optional(),
      documentType: z.enum(["TD01", "TD04"]).optional(),
      status: z.enum(ARUBA_API_V2_CONTRACT.documentedInvoiceStatuses).optional(),
    })
    .safeParse(Object.fromEntries(Object.entries(input).filter(([, value]) => value)));
  if (!parsed.success) throw new AppError("ARUBA_BATCH_INVALID", 422);
  const payload = arubaReadbackJobPayloadSchema.safeParse({
    readbackKind: "advanced",
    ...parsed.data,
    creationStart: parsed.data.creationStart.toISOString(),
    creationEnd: parsed.data.creationEnd.toISOString(),
    modifiedStart: parsed.data.modifiedStart?.toISOString(),
    modifiedEnd: parsed.data.modifiedEnd?.toISOString(),
  });
  if (!payload.success || payload.data.readbackKind !== "advanced") {
    throw new AppError("ARUBA_BATCH_INVALID", 422);
  }
  return withTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO jobs (type, payload_json, max_attempts, priority)
       VALUES ('aruba_readback_submission', $1::jsonb, 1, 60) RETURNING id`,
      [JSON.stringify(payload.data)],
    );
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "ARUBA_API_READBACK_REQUESTED",
      eventClass: "OPERATIONAL",
      entityType: "JOB",
      entityId: inserted.rows[0]!.id,
      metadata: { provider: "ARUBA", scope: "advanced-search" },
      requestId: actor.requestId,
    });
    return { queued: true, jobId: inserted.rows[0]!.id };
  });
}
