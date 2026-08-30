import { randomUUID } from "node:crypto";

import type pg from "pg";

import { ARUBA_API_POLICY } from "../aruba-api-policy.ts";
import { getConfig } from "../config.server.ts";
import { AppError, type ErrorCode } from "../errors.ts";
import { writeAudit } from "./audit.server.ts";
import { getPool, withTransaction } from "./client.server.ts";
import { activeConnectorEnvironment } from "./connector-environment.server.ts";
import type { ClaimedJob, ConnectorActor, JobType } from "./connector-types.server.ts";

const manuallyRetryableJobTypes: JobType[] = [
  "shopify_sync_orders",
  "shopify_process_webhook",
  "ebay_sync_orders",
  "ebay_preview_history",
  "aruba_backfill_inventory",
  "aruba_sync_inventory",
  "aruba_refresh_nonterminal",
  "aruba_full_inventory",
];

export async function scheduleDueSyncs() {
  await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('connector:SHOPIFY'))");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('connector:EBAY'))");
    await client.query(
      `INSERT INTO jobs (type)
     SELECT CASE provider
       WHEN 'SHOPIFY' THEN 'shopify_sync_orders'
       ELSE 'ebay_sync_orders'
     END
     FROM connections
     WHERE status = 'CONNECTED'
       AND EXISTS (
         SELECT 1 FROM sync_cursors
         WHERE sync_cursors.provider = connections.provider
           AND sync_cursors.stream = 'history_import'
       )
       AND ((provider = 'SHOPIFY' AND environment = $1)
         OR (provider = 'EBAY' AND environment = $2))
       AND (last_synced_at IS NULL OR last_synced_at <= now() - interval '10 minutes')
     ON CONFLICT DO NOTHING`,
      [activeConnectorEnvironment("SHOPIFY"), activeConnectorEnvironment("EBAY")],
    );
    await client.query("SELECT pg_advisory_xact_lock(hashtext('connector:ARUBA'))");
    await client.query(
      `INSERT INTO jobs (type, run_at)
       SELECT CASE
         WHEN NOT EXISTS (
           SELECT 1 FROM aruba_sync_runs
           WHERE environment = CASE WHEN connections.environment = 'PRODUCTION'
             THEN 'PRODUCTION' ELSE 'MOCK' END
             AND account_reference = connections.account_reference
             AND kind = 'BACKFILL' AND status = 'COMPLETED'
         ) THEN 'aruba_backfill_inventory'
         WHEN connections.last_full_sync_at IS NULL
           OR connections.last_full_sync_at <= now() - interval '30 days'
           THEN 'aruba_full_inventory'
         WHEN (EXISTS (
           SELECT 1 FROM aruba_remote_documents
           WHERE environment = CASE WHEN connections.environment = 'PRODUCTION'
             THEN 'PRODUCTION' ELSE 'MOCK' END
             AND account_reference = connections.account_reference
             AND automatic_source = 'API' AND provider_group_id IS NOT NULL
             AND remote_status IN ('SUBMITTED', 'SDI_PROCESSING', 'UNKNOWN')
         )) AND NOT EXISTS (
           SELECT 1 FROM jobs
           WHERE type = 'aruba_refresh_nonterminal'
             AND coalesce(completed_at, run_at) > now() - interval '15 minutes'
         ) THEN 'aruba_refresh_nonterminal'
         ELSE 'aruba_sync_inventory'
       END,
       greatest(now(), connections.credentials_verified_at + interval '61 seconds')
       FROM connections
       WHERE provider = 'ARUBA' AND environment = $1
         AND status = 'CONNECTED' AND encrypted_credentials IS NOT NULL
         AND credentials_verified_at IS NOT NULL
         AND inbound_enabled AND NOT api_paused
         AND NOT EXISTS (
           SELECT 1 FROM jobs
           WHERE type IN ('aruba_backfill_inventory', 'aruba_sync_inventory',
             'aruba_refresh_nonterminal', 'aruba_full_inventory')
             AND coalesce(completed_at, run_at) > now() - interval '15 minutes'
         )
       ON CONFLICT DO NOTHING`,
      [getConfig().APP_ENV === "production" ? "PRODUCTION" : "DEVELOPMENT"],
    );
  });
}

export async function claimJob(workerId: string = randomUUID()): Promise<ClaimedJob | null> {
  const claimToken = randomUUID();
  const result = await withTransaction((client) =>
    client.query<{
      id: string;
      type: JobType;
      payload_json: Record<string, unknown>;
      attempts: number;
      max_attempts: number;
      claim_token: string;
    }>(
      `WITH candidate AS (
         SELECT id FROM jobs
         WHERE run_at <= now()
           AND (status = 'PENDING' OR (status = 'RUNNING' AND lease_expires_at <= now()))
         ORDER BY run_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE jobs SET status = 'RUNNING', attempts = attempts + 1, locked_at = now(),
         lease_expires_at = now() + interval '2 minutes', locked_by = $1, claim_token = $2
       FROM candidate WHERE jobs.id = candidate.id
       RETURNING jobs.id, jobs.type, jobs.payload_json, jobs.attempts, jobs.max_attempts,
         jobs.claim_token`,
      [workerId, claimToken],
    ),
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        type: row.type,
        payload: row.payload_json,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        workerId,
        claimToken: row.claim_token,
      }
    : null;
}

export async function renewJobLease(job: ClaimedJob) {
  const result = await getPool().query(
    `UPDATE jobs SET lease_expires_at = now() + interval '2 minutes'
     WHERE id = $1 AND status = 'RUNNING' AND locked_by = $2 AND claim_token = $3
       AND lease_expires_at > now()`,
    [job.id, job.workerId, job.claimToken],
  );
  return result.rowCount === 1;
}

export async function assertJobLease(client: pg.PoolClient, job: ClaimedJob): Promise<void> {
  const current = await client.query(
    `SELECT 1 FROM jobs
     WHERE id = $1 AND status = 'RUNNING' AND locked_by = $2 AND claim_token = $3
       AND lease_expires_at > now()
     FOR UPDATE`,
    [job.id, job.workerId, job.claimToken],
  );
  if (!current.rows[0]) throw new AppError("CONFLICT_REVISION", 409);
}

export async function renewLockedJobLease(client: pg.PoolClient, job: ClaimedJob): Promise<void> {
  const renewed = await client.query(
    `UPDATE jobs SET lease_expires_at = clock_timestamp() + interval '2 minutes'
     WHERE id = $1 AND status = 'RUNNING' AND locked_by = $2 AND claim_token = $3`,
    [job.id, job.workerId, job.claimToken],
  );
  if (renewed.rowCount !== 1) throw new AppError("CONFLICT_REVISION", 409);
}

export async function jobLeaseCurrent(job: ClaimedJob): Promise<boolean> {
  const current = await getPool().query(
    `SELECT 1 FROM jobs
     WHERE id = $1 AND status = 'RUNNING' AND locked_by = $2 AND claim_token = $3
       AND lease_expires_at > now()`,
    [job.id, job.workerId, job.claimToken],
  );
  return Boolean(current.rows[0]);
}

export async function yieldJob(
  job: ClaimedJob,
  result: Record<string, unknown> = {},
  delayMs = 1_000,
) {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 422);
  }
  const yielded = await getPool().query(
    `UPDATE jobs SET status = 'PENDING',
       run_at = now() + make_interval(secs => $4::double precision / 1000),
       attempts = greatest(attempts - 1, 0), locked_at = NULL,
       lease_expires_at = NULL, locked_by = NULL, claim_token = NULL,
       result_json = $5, last_error_code = NULL
     WHERE id = $1 AND status = 'RUNNING' AND locked_by = $2 AND claim_token = $3
       AND lease_expires_at > now()`,
    [job.id, job.workerId, job.claimToken, delayMs, JSON.stringify(result)],
  );
  return yielded.rowCount === 1;
}

export async function completeJob(job: ClaimedJob, result: Record<string, unknown> = {}) {
  return withTransaction(async (client) => {
    const completed = await client.query(
      `UPDATE jobs SET status = 'COMPLETED', completed_at = now(), lease_expires_at = NULL,
         locked_by = NULL, claim_token = NULL, result_json = $4
       WHERE id = $1 AND status = 'RUNNING' AND locked_by = $2 AND claim_token = $3
         AND lease_expires_at > now()`,
      [job.id, job.workerId, job.claimToken, JSON.stringify(result)],
    );
    if (completed.rowCount !== 1) return false;
    const provider = job.type.startsWith("shopify")
      ? "SHOPIFY"
      : job.type.startsWith("ebay")
        ? "EBAY"
        : null;
    if (provider) {
      await client.query(
        `UPDATE connections SET status = 'CONNECTED', last_checked_at = now(),
           last_error_code = NULL, last_error_message_sanitized = NULL, updated_at = now()
         WHERE provider = $1 AND environment = $2 AND status = 'ERROR'`,
        [provider, activeConnectorEnvironment(provider)],
      );
    }
    if (job.type.startsWith("aruba_") && result.stopped !== true) {
      await client.query(
        `UPDATE connections SET status = CASE WHEN api_paused THEN 'PAUSED' ELSE 'CONNECTED' END,
           last_checked_at = now(), last_synced_at = now(), last_error_code = NULL,
           last_error_message_sanitized = NULL, updated_at = now()
         WHERE provider = 'ARUBA'
           AND environment = $1 AND encrypted_credentials IS NOT NULL`,
        [getConfig().APP_ENV === "production" ? "PRODUCTION" : "DEVELOPMENT"],
      );
    }
    const eventId = Number(job.payload.webhookEventId);
    if (Number.isSafeInteger(eventId)) {
      await client.query(
        `UPDATE webhook_events SET status = 'PROCESSED', processed_at = now(),
           lease_expires_at = NULL WHERE id = $1`,
        [eventId],
      );
    }
    return true;
  });
}

export async function failJob(job: ClaimedJob, code: ErrorCode) {
  const budgetContinuation = code === "ARUBA_API_BUDGET_EXHAUSTED";
  const retryable =
    code === "PROVIDER_RATE_LIMITED" ||
    code === "ARUBA_API_COOLDOWN_ACTIVE" ||
    code === "ARUBA_API_AUTH_INTERVAL_ACTIVE" ||
    code === "PROVIDER_UNAVAILABLE" ||
    code === "EMAIL_DELIVERY_TEMPORARY";
  const terminal = budgetContinuation ? false : job.attempts >= job.maxAttempts || !retryable;
  const arubaProviderCooldown =
    job.type.startsWith("aruba_") &&
    (code === "PROVIDER_RATE_LIMITED" || code === "ARUBA_API_COOLDOWN_ACTIVE");
  const arubaAuthenticationInterval =
    job.type.startsWith("aruba_") && code === "ARUBA_API_AUTH_INTERVAL_ACTIVE";
  return withTransaction(async (client) => {
    const failed = await client.query(
      `UPDATE jobs SET status = $5, run_at = CASE WHEN $5 = 'PENDING'
           THEN CASE WHEN $4 = 'ARUBA_API_BUDGET_EXHAUSTED' THEN now()
             WHEN $6 THEN now() + make_interval(secs => $7::double precision / 1000)
             WHEN $8 THEN now() + make_interval(secs => $9::double precision / 1000)
             ELSE now() + make_interval(secs => LEAST(900,
               5 * power(2, attempts)::integer + floor(random() * 6)::integer)) END
           ELSE run_at END,
         lease_expires_at = NULL, locked_by = NULL, claim_token = NULL, last_error_code = $4
       WHERE id = $1 AND status = 'RUNNING' AND locked_by = $2 AND claim_token = $3
         AND lease_expires_at > now()`,
      [
        job.id,
        job.workerId,
        job.claimToken,
        code,
        terminal ? "FAILED" : "PENDING",
        arubaProviderCooldown,
        ARUBA_API_POLICY.providerCooldownMs,
        arubaAuthenticationInterval,
        ARUBA_API_POLICY.authenticationIntervalMs,
      ],
    );
    if (failed.rowCount !== 1) return null;
    const eventId = Number(job.payload.webhookEventId);
    if (terminal && Number.isSafeInteger(eventId)) {
      await client.query(
        "UPDATE webhook_events SET status = 'FAILED', error_code = $2 WHERE id = $1",
        [eventId, code],
      );
    }
    return terminal;
  });
}

/**
 * Le dead-letter restano nel DB per audit e retention, ma non sono più una criticità
 * corrente quando un readback completo dello stesso provider le ha superate.
 * `locked_at` identifica il tentativo effettivo e impedisce di nascondere un retry
 * manuale recente di un job creato in precedenza.
 */
export async function actionableConnectorFailures() {
  const result = await getPool().query<{
    id: string;
    type: JobType;
    attempts: number;
    last_error_code: string | null;
    failed_at: Date;
  }>(
    `SELECT jobs.id, jobs.type, jobs.attempts, jobs.last_error_code,
            coalesce(jobs.locked_at, jobs.run_at, jobs.created_at) AS failed_at
     FROM jobs
     JOIN connections
      ON connections.provider = CASE
            WHEN jobs.type LIKE 'shopify_%' THEN 'SHOPIFY'
            WHEN jobs.type LIKE 'ebay_%' THEN 'EBAY'
            WHEN jobs.type LIKE 'aruba_%' THEN 'ARUBA'
          END
      AND connections.environment = CASE
            WHEN jobs.type LIKE 'shopify_%' THEN $2
            WHEN jobs.type LIKE 'ebay_%' THEN $3
            WHEN jobs.type LIKE 'aruba_%' THEN $4
          END
      AND connections.status IN ('CONNECTED', 'ERROR')
     WHERE jobs.status = 'FAILED'
       AND jobs.type = ANY($1::text[])
       AND (connections.last_synced_at IS NULL
         OR coalesce(jobs.locked_at, jobs.run_at, jobs.created_at) > connections.last_synced_at)
     ORDER BY failed_at DESC, jobs.id DESC`,
    [
      manuallyRetryableJobTypes,
      activeConnectorEnvironment("SHOPIFY"),
      activeConnectorEnvironment("EBAY"),
      getConfig().APP_ENV === "production" ? "PRODUCTION" : "DEVELOPMENT",
    ],
  );
  return result.rows.map((row) => ({
    id: row.id,
    type: row.type,
    attempts: row.attempts,
    errorCode: row.last_error_code,
    failedAt: row.failed_at.toISOString(),
  }));
}

export async function retryFailedJob(id: unknown, actor: ConnectorActor) {
  const jobId = typeof id === "string" && /^\d+$/.test(id) ? id : "";
  if (!jobId) throw new AppError("CONFLICT_REVISION", 409);
  return withTransaction(async (client) => {
    const unlocked = await client.query<{ type: JobType }>(
      `SELECT type FROM jobs
       WHERE id = $1 AND status = 'FAILED' AND type = ANY($2::text[])`,
      [jobId, manuallyRetryableJobTypes],
    );
    if (!unlocked.rows[0]) throw new AppError("CONFLICT_REVISION", 409);
    const provider = unlocked.rows[0].type.startsWith("shopify")
      ? "SHOPIFY"
      : unlocked.rows[0].type.startsWith("ebay")
        ? "EBAY"
        : "ARUBA";
    const providerEnvironment =
      provider === "ARUBA"
        ? getConfig().APP_ENV === "production"
          ? "PRODUCTION"
          : "DEVELOPMENT"
        : activeConnectorEnvironment(provider);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('connector:' || $1))", [provider]);
    if (unlocked.rows[0].type === "ebay_preview_history") {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('ebay_preview_history'))");
    }
    const candidate = await client.query<{
      type: JobType;
      payload_json: Record<string, unknown>;
    }>(
      `SELECT type, payload_json FROM jobs
       WHERE id = $1 AND status = 'FAILED' AND type = ANY($2::text[])
       FOR UPDATE`,
      [jobId, manuallyRetryableJobTypes],
    );
    if (!candidate.rows[0]) throw new AppError("CONFLICT_REVISION", 409);
    const jobType = candidate.rows[0].type;
    const syncProvider =
      jobType === "shopify_sync_orders"
        ? "SHOPIFY"
        : jobType === "ebay_sync_orders"
          ? "EBAY"
          : null;
    if (syncProvider) {
      const ready = await client.query(
        `SELECT 1 FROM sync_cursors
         WHERE provider = $1 AND stream = 'history_import'`,
        [syncProvider],
      );
      if (!ready.rows[0]) throw new AppError("CONFLICT_REVISION", 409);
    }
    if (jobType === "ebay_preview_history") {
      const accountReference = candidate.rows[0].payload_json.accountReference;
      const currentImport =
        typeof accountReference === "string"
          ? await client.query(
              `SELECT 1 FROM connections
               WHERE provider = 'EBAY' AND environment = $1
                 AND status IN ('CONNECTED', 'ERROR')
                 AND account_reference = $2
                 AND NOT EXISTS (
                   SELECT 1 FROM sync_cursors
                   WHERE provider = 'EBAY' AND stream = 'history_import'
                 )`,
              [activeConnectorEnvironment("EBAY"), accountReference],
            )
          : null;
      if (!currentImport?.rows[0]) throw new AppError("CONFLICT_REVISION", 409);
      const activePreview = await client.query(
        `SELECT 1 FROM jobs
         WHERE type = 'ebay_preview_history' AND status IN ('PENDING', 'RUNNING')
         LIMIT 1`,
      );
      if (activePreview.rows[0]) throw new AppError("CONFLICT_REVISION", 409);
    } else {
      const runnable = await client.query(
        `SELECT 1 FROM connections
         WHERE provider = $1 AND environment = $2 AND status IN ('CONNECTED', 'ERROR')
           AND ($1 <> 'ARUBA' OR (
             encrypted_credentials IS NOT NULL AND credentials_verified_at IS NOT NULL
             AND inbound_enabled AND NOT api_paused
           ))`,
        [provider, providerEnvironment],
      );
      if (!runnable.rows[0]) throw new AppError("CONFLICT_REVISION", 409);
    }
    if (provider === "ARUBA") {
      await client.query(
        `UPDATE connections SET status = 'CONNECTED', last_error_code = NULL,
           last_error_message_sanitized = NULL, updated_at = now()
         WHERE provider = 'ARUBA' AND environment = $1 AND status = 'ERROR'`,
        [providerEnvironment],
      );
    }
    const retried = await client.query<{ id: string }>(
      `UPDATE jobs SET status = 'PENDING', run_at = now(), attempts = 0, completed_at = NULL,
         last_error_code = NULL
       WHERE id = $1 AND status = 'FAILED' RETURNING id`,
      [jobId],
    );
    if (!retried.rows[0]) throw new AppError("CONFLICT_REVISION", 409);
    await writeAudit(client, {
      actorType: actor.type,
      actorId: actor.id ? String(actor.id) : null,
      action: "CONNECTOR_JOB_RETRIED",
      eventClass: "OPERATIONAL",
      entityType: "JOB",
      entityId: retried.rows[0].id,
      requestId: actor.requestId,
    });
  });
}
