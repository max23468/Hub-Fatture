import { randomUUID } from "node:crypto";

import type pg from "pg";

import { ARUBA_API_POLICY } from "../aruba-api-policy.ts";
import { getConfig } from "../config.server.ts";
import { decryptCredential, encryptCredential } from "../crypto.server.ts";
import { AppError, type ErrorCode } from "../errors.ts";
import { writeAudit } from "./audit.server.ts";
import { getPool, withTransaction } from "./client.server.ts";

export type Provider = "SHOPIFY" | "EBAY";
export type ConnectionEnvironment = "DEVELOPMENT" | "SANDBOX" | "PRODUCTION";
export type JobType =
  | "shopify_sync_orders"
  | "shopify_process_webhook"
  | "ebay_sync_orders"
  | "ebay_preview_history"
  | "process_refund"
  | "send_customer_email"
  | "aruba_backfill_inventory"
  | "aruba_sync_inventory"
  | "aruba_refresh_nonterminal"
  | "aruba_full_inventory";

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

export interface ConnectorActor {
  type: "ADMIN" | "SYSTEM";
  id?: number;
  requestId: string;
}

interface ConnectionRow {
  id: string;
  provider: Provider;
  environment: ConnectionEnvironment;
  account_reference: string;
  encrypted_credentials: string;
  status: "CONNECTED" | "REAUTH_REQUIRED" | "REVOKED" | "ERROR";
  last_checked_at: Date | null;
  last_synced_at: Date | null;
  last_error_code: string | null;
  created_at: Date;
  history_imported?: boolean;
}

export interface HistoryImportResult {
  count: number;
  reviewRequired: number;
  imported: number;
  updated: number;
  ignored: number;
}

export interface ClaimedJob {
  id: string;
  type: JobType;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  workerId: string;
  claimToken: string;
}

function credentialsKey(): string {
  const value = getConfig().CREDENTIALS_ENCRYPTION_KEY;
  if (!value) throw new AppError("PROVIDER_NOT_CONFIGURED", 503);
  return value;
}

function activeEnvironment(provider: Provider): ConnectionEnvironment {
  const config = getConfig();
  if (provider === "SHOPIFY") {
    return config.APP_ENV === "production" ? "PRODUCTION" : "DEVELOPMENT";
  }
  return config.EBAY_ENVIRONMENT === "production" ? "PRODUCTION" : "SANDBOX";
}

export async function saveConnection<T>(
  input: {
    provider: Provider;
    environment: ConnectionEnvironment;
    accountReference: string;
    credentials: T;
  },
  actor: ConnectorActor,
) {
  await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('connector:' || $1))", [
      input.provider,
    ]);
    const existing = await client.query<{ account_reference: string }>(
      `SELECT account_reference FROM connections
       WHERE provider = $1 AND environment = $2
       FOR UPDATE`,
      [input.provider, input.environment],
    );
    const accountChanged = existing.rows[0]?.account_reference !== input.accountReference;
    const saved = await client.query<{ id: string }>(
      `INSERT INTO connections
        (provider, environment, account_reference, encrypted_credentials, status, last_checked_at)
       VALUES ($1, $2, $3, $4, 'CONNECTED', now())
       ON CONFLICT (provider, environment) DO UPDATE SET
         account_reference = EXCLUDED.account_reference,
         encrypted_credentials = EXCLUDED.encrypted_credentials,
         status = 'CONNECTED', last_checked_at = now(), updated_at = now(),
         last_synced_at = CASE
           WHEN connections.account_reference = EXCLUDED.account_reference
             THEN connections.last_synced_at
           ELSE NULL
         END,
         created_at = CASE
           WHEN connections.account_reference = EXCLUDED.account_reference
             THEN connections.created_at
           ELSE now()
         END,
         last_error_code = NULL, last_error_message_sanitized = NULL
       RETURNING id`,
      [
        input.provider,
        input.environment,
        input.accountReference,
        encryptCredential(input.credentials, credentialsKey()),
      ],
    );
    if (accountChanged) {
      await client.query(
        `WITH obsolete AS (
           UPDATE jobs SET status = 'COMPLETED', completed_at = now(),
             lease_expires_at = NULL, locked_by = NULL, claim_token = NULL,
             result_json = '{"obsoleteAccount":true}'::jsonb, last_error_code = NULL
           WHERE status IN ('PENDING', 'RUNNING', 'FAILED')
             AND (($1 = 'SHOPIFY'
                 AND type IN ('shopify_sync_orders', 'shopify_process_webhook'))
               OR ($1 = 'EBAY' AND type IN ('ebay_sync_orders', 'ebay_preview_history')))
           RETURNING CASE WHEN payload_json ->> 'webhookEventId' ~ '^[0-9]+$'
             THEN (payload_json ->> 'webhookEventId')::bigint END AS webhook_event_id
         )
         UPDATE webhook_events SET status = 'PROCESSED', processed_at = now(),
           lease_expires_at = NULL, error_code = NULL
         WHERE id IN (
           SELECT webhook_event_id FROM obsolete WHERE webhook_event_id IS NOT NULL
         )`,
        [input.provider],
      );
      await client.query("DELETE FROM sync_cursors WHERE provider = $1", [input.provider]);
    }
    await writeAudit(client, {
      actorType: actor.type,
      actorId: actor.id ? String(actor.id) : null,
      action: "PROVIDER_CONNECTED",
      eventClass: "CRITICAL",
      entityType: "CONNECTION",
      entityId: saved.rows[0]!.id,
      metadata: { provider: input.provider },
      requestId: actor.requestId,
    });
  });
}

export async function loadConnection<T>(provider: Provider): Promise<{
  id: string;
  environment: ConnectionEnvironment;
  accountReference: string;
  credentials: T;
}> {
  const result = await getPool().query<ConnectionRow>(
    `SELECT * FROM connections
     WHERE provider = $1 AND environment = $2 AND status IN ('CONNECTED', 'ERROR')
     LIMIT 1`,
    [provider, activeEnvironment(provider)],
  );
  const connection = result.rows[0];
  if (!connection) throw new AppError("PROVIDER_NOT_CONFIGURED", 503);
  return {
    id: connection.id,
    environment: connection.environment,
    accountReference: connection.account_reference,
    credentials: decryptCredential<T>(connection.encrypted_credentials, credentialsKey()),
  };
}

export async function connectionSummaries() {
  const result = await getPool().query<ConnectionRow>(
    `SELECT connections.*,
            EXISTS (
              SELECT 1 FROM sync_cursors
              WHERE sync_cursors.provider = connections.provider
                AND sync_cursors.stream = 'history_import'
            ) AS history_imported
     FROM connections
     WHERE (provider = 'SHOPIFY' AND environment = $1)
        OR (provider = 'EBAY' AND environment = $2)
     ORDER BY provider`,
    [activeEnvironment("SHOPIFY"), activeEnvironment("EBAY")],
  );
  return result.rows.map((row) => ({
    provider: row.provider,
    environment: row.environment,
    accountReference: row.account_reference,
    status: row.status,
    lastCheckedAt: row.last_checked_at?.toISOString() ?? null,
    lastSyncedAt: row.last_synced_at?.toISOString() ?? null,
    lastErrorCode: row.last_error_code,
    connectedAt: row.created_at.toISOString(),
    historyImported: Boolean(row.history_imported),
  }));
}

export async function historyImportPending(provider: Provider) {
  const result = await getPool().query<{ pending: boolean }>(
    `SELECT NOT EXISTS (
       SELECT 1 FROM sync_cursors WHERE provider = $1 AND stream = 'history_import'
     ) AS pending
     FROM connections
     WHERE provider = $1 AND environment = $2 AND status IN ('CONNECTED', 'ERROR')`,
    [provider, activeEnvironment(provider)],
  );
  if (!result.rows[0]) throw new AppError("PROVIDER_NOT_CONFIGURED", 503);
  return result.rows[0].pending;
}

export async function completeHistoryImport(
  provider: Provider,
  accountReference: string,
  cursor: string,
  overlapFrom: string,
  job?: ClaimedJob,
) {
  await withTransaction(async (client) => {
    await lockHistoryImportConnection(client, provider, accountReference, job);
    await completeHistoryImportInTransaction(
      client,
      provider,
      accountReference,
      cursor,
      overlapFrom,
      job,
    );
  });
}

export async function lockHistoryImportConnection(
  client: pg.PoolClient,
  provider: Provider,
  accountReference: string,
  job?: ClaimedJob,
) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('connector:' || $1))", [provider]);
  const connection = await client.query(
    `SELECT id FROM connections
     WHERE provider = $1 AND environment = $2 AND status IN ('CONNECTED', 'ERROR')
       AND account_reference = $3
       AND NOT EXISTS (
         SELECT 1 FROM sync_cursors
         WHERE sync_cursors.provider = $1 AND sync_cursors.stream = 'history_import'
       )
     FOR UPDATE`,
    [provider, activeEnvironment(provider), accountReference],
  );
  if (!connection.rowCount) throw new AppError("CONFLICT_REVISION", 409);
  if (job) await assertJobLease(client, job);
}

export async function completeHistoryImportInTransaction(
  client: pg.PoolClient,
  provider: Provider,
  accountReference: string,
  cursor: string,
  overlapFrom: string,
  job?: ClaimedJob,
  result?: HistoryImportResult,
) {
  if (job) await assertJobLease(client, job);
  await client.query(
    `INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
     VALUES ($1, 'orders', $2, $3), ($1, 'history_import', $2, $3)
     ON CONFLICT (provider, stream) DO UPDATE SET
       cursor = EXCLUDED.cursor, overlap_from = EXCLUDED.overlap_from, updated_at = now()`,
    [provider, cursor, overlapFrom],
  );
  const updated = await client.query(
    `UPDATE connections SET status = 'CONNECTED', last_checked_at = now(),
       last_synced_at = now(), updated_at = now(),
       last_error_code = NULL, last_error_message_sanitized = NULL
     WHERE provider = $1 AND environment = $2 AND status IN ('CONNECTED', 'ERROR')
       AND account_reference = $3`,
    [provider, activeEnvironment(provider), accountReference],
  );
  if (updated.rowCount !== 1) throw new AppError("CONFLICT_REVISION", 409);
  if (job && result) {
    await client.query(
      `UPDATE jobs SET result_json = $4
       WHERE id = $1 AND status = 'RUNNING' AND locked_by = $2 AND claim_token = $3`,
      [
        job.id,
        job.workerId,
        job.claimToken,
        JSON.stringify({ ...result, historyImportCompleted: provider }),
      ],
    );
  }
}

export async function completedHistoryImportResult(
  provider: Provider,
  job: ClaimedJob,
): Promise<HistoryImportResult | null> {
  const result = await getPool().query<{ result_json: Record<string, unknown> }>(
    `SELECT jobs.result_json FROM jobs
     WHERE jobs.id = $1 AND jobs.status = 'RUNNING' AND jobs.locked_by = $2
       AND jobs.claim_token = $3 AND jobs.lease_expires_at > now()
       AND jobs.result_json ->> 'historyImportCompleted' = $4
       AND EXISTS (
         SELECT 1 FROM sync_cursors
         WHERE sync_cursors.provider = $4 AND sync_cursors.stream = 'history_import'
       )`,
    [job.id, job.workerId, job.claimToken, provider],
  );
  const stored = result.rows[0]?.result_json;
  return stored
    ? {
        count: Number(stored.count ?? 0),
        reviewRequired: Number(stored.reviewRequired ?? 0),
        imported: Number(stored.imported ?? 0),
        updated: Number(stored.updated ?? 0),
        ignored: Number(stored.ignored ?? 0),
      }
    : null;
}

export async function markConnectionSynced(provider: Provider, job?: ClaimedJob) {
  await withTransaction(async (client) => {
    if (job) await assertJobLease(client, job);
    await client.query(
      `UPDATE connections SET status = 'CONNECTED', last_checked_at = now(), last_synced_at = now(),
         last_error_code = NULL, last_error_message_sanitized = NULL, updated_at = now()
       WHERE provider = $1 AND environment = $2`,
      [provider, activeEnvironment(provider)],
    );
  });
}

export async function markConnectionError(provider: Provider, code: ErrorCode, terminal = false) {
  const status =
    code === "AUTH_PROVIDER_EXPIRED"
      ? "REAUTH_REQUIRED"
      : terminal
        ? "ERROR"
        : code === "PROVIDER_RATE_LIMITED" ||
            code === "ARUBA_API_COOLDOWN_ACTIVE" ||
            code === "PROVIDER_UNAVAILABLE"
          ? "CONNECTED"
          : "ERROR";
  await getPool().query(
    `UPDATE connections SET status = $2, last_checked_at = now(), last_error_code = $3,
       last_error_message_sanitized = $3, updated_at = now()
     WHERE provider = $1 AND environment = $4`,
    [provider, status, code, activeEnvironment(provider)],
  );
}

export async function readCursor(provider: Provider, stream = "orders") {
  const result = await getPool().query<{ cursor: string | null; overlap_from: Date | null }>(
    "SELECT cursor, overlap_from FROM sync_cursors WHERE provider = $1 AND stream = $2",
    [provider, stream],
  );
  return {
    cursor: result.rows[0]?.cursor ?? null,
    overlapFrom: result.rows[0]?.overlap_from?.toISOString() ?? null,
  };
}

export async function writeCursor(
  provider: Provider,
  cursor: string | null,
  overlapFrom: string,
  job?: ClaimedJob,
  stream = "orders",
) {
  await withTransaction(async (client) => {
    if (job) await assertJobLease(client, job);
    await client.query(
      `INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (provider, stream) DO UPDATE SET
         cursor = EXCLUDED.cursor, overlap_from = EXCLUDED.overlap_from, updated_at = now()`,
      [provider, stream, cursor, overlapFrom],
    );
  });
}

export async function enqueueJob(type: JobType, payload: Record<string, unknown> = {}) {
  await getPool().query("INSERT INTO jobs (type, payload_json) VALUES ($1, $2)", [
    type,
    JSON.stringify(payload),
  ]);
}

export async function enqueueEbayHistory(startDate: string, mode: "PREVIEW" | "IMPORT") {
  await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ebay_preview_history'))");
    const connection = await client.query<{
      account_reference: string;
      pending: boolean;
    }>(
      `SELECT account_reference, NOT EXISTS (
         SELECT 1 FROM sync_cursors
         WHERE provider = 'EBAY' AND stream = 'history_import'
       ) AS pending
       FROM connections
       WHERE provider = 'EBAY' AND environment = $1
       FOR SHARE`,
      [activeEnvironment("EBAY")],
    );
    if (!connection.rows[0]) throw new AppError("PROVIDER_NOT_CONFIGURED", 503);
    if (!connection.rows[0].pending) return;
    const payload = {
      startDate,
      mode,
      accountReference: connection.rows[0].account_reference,
    };
    const active = await client.query<{
      payload_json: Record<string, unknown>;
    }>(
      `SELECT payload_json FROM jobs
       WHERE type = 'ebay_preview_history' AND status IN ('PENDING', 'RUNNING')
       LIMIT 1 FOR UPDATE`,
    );
    if (active.rows[0]) {
      const current = active.rows[0].payload_json;
      if (
        current.startDate === payload.startDate &&
        current.mode === payload.mode &&
        current.accountReference === payload.accountReference
      ) {
        return;
      }
      throw new AppError("CONFLICT_REVISION", 409);
    }
    await client.query(
      `INSERT INTO jobs (type, payload_json)
       VALUES ('ebay_preview_history', $1)`,
      [JSON.stringify(payload)],
    );
  });
}

export async function latestEbayHistory() {
  const result = await getPool().query<{
    id: string;
    status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
    payload_json: { mode?: unknown; startDate?: unknown };
    result_json: {
      count?: unknown;
      reviewRequired?: unknown;
      imported?: unknown;
      updated?: unknown;
      ignored?: unknown;
    };
    last_error_code: string | null;
    created_at: Date;
    completed_at: Date | null;
  }>(
    `SELECT jobs.id, jobs.status, jobs.payload_json, jobs.result_json, jobs.last_error_code,
            jobs.created_at, jobs.completed_at
     FROM jobs JOIN connections ON connections.provider = 'EBAY'
       AND connections.environment = $1
       AND connections.account_reference = jobs.payload_json ->> 'accountReference'
     WHERE jobs.type = 'ebay_preview_history'
     ORDER BY jobs.created_at DESC, jobs.id DESC LIMIT 1`,
    [activeEnvironment("EBAY")],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    mode: row.payload_json.mode === "IMPORT" ? "IMPORT" : "PREVIEW",
    startDate: typeof row.payload_json.startDate === "string" ? row.payload_json.startDate : null,
    count: Number(row.result_json.count ?? 0),
    reviewRequired: Number(row.result_json.reviewRequired ?? 0),
    imported: Number(row.result_json.imported ?? 0),
    updated: Number(row.result_json.updated ?? 0),
    ignored: Number(row.result_json.ignored ?? 0),
    errorCode: row.last_error_code,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

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
      [activeEnvironment("SHOPIFY"), activeEnvironment("EBAY")],
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
         WHEN EXISTS (
           SELECT 1 FROM aruba_remote_documents
           WHERE environment = CASE WHEN connections.environment = 'PRODUCTION'
             THEN 'PRODUCTION' ELSE 'MOCK' END
             AND account_reference = connections.account_reference
             AND remote_status IN ('SUBMITTED', 'SDI_PROCESSING', 'UNKNOWN')
         ) AND EXISTS (
           SELECT 1 FROM aruba_api_latest_shadow_documents
           WHERE environment = CASE WHEN connections.environment = 'PRODUCTION'
             THEN 'PRODUCTION' ELSE 'MOCK' END
             AND account_reference = connections.account_reference
             AND remote_status IN ('SUBMITTED', 'SDI_PROCESSING', 'UNKNOWN')
         ) AND NOT EXISTS (
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
        [provider, activeEnvironment(provider)],
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
    code === "PROVIDER_UNAVAILABLE" ||
    code === "EMAIL_DELIVERY_TEMPORARY";
  const terminal = budgetContinuation ? false : job.attempts >= job.maxAttempts || !retryable;
  const arubaCooldown =
    job.type.startsWith("aruba_") &&
    (code === "PROVIDER_RATE_LIMITED" || code === "ARUBA_API_COOLDOWN_ACTIVE");
  return withTransaction(async (client) => {
    const failed = await client.query(
      `UPDATE jobs SET status = $5, run_at = CASE WHEN $5 = 'PENDING'
           THEN CASE WHEN $4 = 'ARUBA_API_BUDGET_EXHAUSTED' THEN now()
             WHEN $6 THEN now() + make_interval(secs => $7::double precision / 1000)
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
        arubaCooldown,
        ARUBA_API_POLICY.providerCooldownMs,
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
      activeEnvironment("SHOPIFY"),
      activeEnvironment("EBAY"),
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
        : activeEnvironment(provider);
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
              [activeEnvironment("EBAY"), accountReference],
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

export async function ingestShopifyWebhook(input: {
  externalEventId: string;
  topic: string;
  payloadSha256: string;
  orderId: string | null;
}) {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('connector:SHOPIFY'))");
    const event = await client.query<{ id: string; acquired: boolean }>(
      `INSERT INTO webhook_events
        (provider, external_event_id, topic, payload_sha256, claimed_at,
         lease_expires_at, attempt_count)
       VALUES ('SHOPIFY', $1, $2, $3, now(), now() + interval '2 minutes', 1)
       ON CONFLICT (provider, external_event_id) DO UPDATE SET
         claimed_at = now(), lease_expires_at = now() + interval '2 minutes',
         attempt_count = webhook_events.attempt_count + 1, status = 'PROCESSING', error_code = NULL
       WHERE (webhook_events.status = 'FAILED'
          OR (webhook_events.status = 'PROCESSING' AND webhook_events.lease_expires_at <= now()))
         AND webhook_events.topic = EXCLUDED.topic
         AND webhook_events.payload_sha256 = EXCLUDED.payload_sha256
       RETURNING id, true AS acquired`,
      [input.externalEventId, input.topic, input.payloadSha256],
    );
    if (!event.rows[0]) {
      await assertWebhookIdentity(
        client,
        "SHOPIFY",
        input.externalEventId,
        input.topic,
        input.payloadSha256,
      );
      return { duplicate: true };
    }
    if (input.orderId) {
      const history = await client.query<{ pending: boolean }>(
        `SELECT NOT EXISTS (
           SELECT 1 FROM sync_cursors
           WHERE provider = 'SHOPIFY' AND stream = 'history_import'
         ) AS pending`,
      );
      await client.query(
        `INSERT INTO jobs (type, payload_json)
         VALUES ('shopify_process_webhook', $1)`,
        [
          JSON.stringify({
            orderId: input.orderId,
            webhookEventId: event.rows[0].id,
            historical: history.rows[0]!.pending,
          }),
        ],
      );
    } else {
      await client.query(
        `UPDATE webhook_events SET status = 'PROCESSED', processed_at = now(),
           lease_expires_at = NULL WHERE id = $1`,
        [event.rows[0].id],
      );
    }
    return { duplicate: false };
  });
}

export async function recordShopifyDataRequest(input: {
  externalEventId: string;
  payloadSha256: string;
  customerIds: string[];
  orderIds: string[];
}) {
  return withTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO webhook_events
        (provider, external_event_id, topic, payload_sha256, request_payload_json,
         status, attempt_count)
       VALUES ('SHOPIFY', $1, 'CUSTOMERS_DATA_REQUEST', $2, $3, 'PENDING', 1)
       ON CONFLICT (provider, external_event_id) DO NOTHING
       RETURNING id`,
      [
        input.externalEventId,
        input.payloadSha256,
        JSON.stringify({ customerIds: input.customerIds, orderIds: input.orderIds }),
      ],
    );
    if (!result.rows[0]) {
      await assertWebhookIdentity(
        client,
        "SHOPIFY",
        input.externalEventId,
        "CUSTOMERS_DATA_REQUEST",
        input.payloadSha256,
      );
    }
    return { duplicate: !result.rows[0] };
  });
}

export async function pendingShopifyDataRequests() {
  const result = await getPool().query<{
    external_event_id: string;
    received_at: Date;
    request_payload_json: { customerIds?: unknown[]; orderIds?: unknown[] };
  }>(
    `SELECT external_event_id, received_at, request_payload_json FROM webhook_events
     WHERE provider = 'SHOPIFY' AND topic = 'CUSTOMERS_DATA_REQUEST' AND status = 'PENDING'
     ORDER BY received_at`,
  );
  return result.rows.map((row) => ({
    externalEventId: row.external_event_id,
    receivedAt: row.received_at.toISOString(),
    customerIds: deletionIdentifiers(row.request_payload_json.customerIds ?? []),
    orderIds: deletionIdentifiers(row.request_payload_json.orderIds ?? []),
  }));
}

export async function completeShopifyDataRequest(
  externalEventId: unknown,
  actor: { id: number; requestId: string },
) {
  const eventId = typeof externalEventId === "string" ? externalEventId.trim() : "";
  if (!eventId) throw new AppError("CONFLICT_REVISION", 409);
  return withTransaction(async (client) => {
    const completed = await client.query<{ id: string }>(
      `UPDATE webhook_events
       SET status = 'PROCESSED', processed_at = now(), lease_expires_at = NULL,
         request_payload_json = '{}'
       WHERE provider = 'SHOPIFY' AND topic = 'CUSTOMERS_DATA_REQUEST'
         AND external_event_id = $1 AND status = 'PENDING'
       RETURNING id`,
      [eventId],
    );
    if (!completed.rows[0]) throw new AppError("CONFLICT_REVISION", 409);
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "SHOPIFY_DATA_REQUEST_COMPLETED",
      eventClass: "CRITICAL",
      entityType: "WEBHOOK_EVENT",
      entityId: completed.rows[0].id,
      metadata: { provider: "SHOPIFY" },
      requestId: actor.requestId,
    });
  });
}

function deletionIdentifiers(values: unknown[]): string[] {
  return values.filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
}

async function deleteUnissuedCustomerData(
  client: pg.PoolClient,
  provider: Provider,
  identifiers: string[],
) {
  if (!identifiers.length) return 0;
  const result = await client.query<{ id: string }>(
    `DELETE FROM orders
     WHERE provider = $1
       AND customer_id IN (
         SELECT customer_id FROM customer_source_records
         WHERE provider = $1 AND external_customer_id = ANY($2::text[])
       )
       AND (billing_case_id IS NULL OR billing_case_id IN (
         SELECT id FROM billing_cases
         WHERE status IN ('DRAFT', 'NEEDS_REVIEW', 'READY', 'DO_NOT_TRANSMIT')
       ))
     RETURNING id`,
    [provider, identifiers],
  );
  await client.query(
    `DELETE FROM customer_source_records
     WHERE provider = $1 AND external_customer_id = ANY($2::text[])`,
    [provider, identifiers],
  );
  await client.query(
    `DELETE FROM billing_cases
     WHERE status IN ('DRAFT', 'NEEDS_REVIEW', 'READY', 'DO_NOT_TRANSMIT')
       AND NOT EXISTS (SELECT 1 FROM orders WHERE orders.billing_case_id = billing_cases.id)`,
  );
  await client.query(
    `DELETE FROM customers WHERE NOT EXISTS (
       SELECT 1 FROM orders WHERE orders.customer_id = customers.id
     ) AND NOT EXISTS (
       SELECT 1 FROM customer_source_records WHERE customer_source_records.customer_id = customers.id
     )`,
  );
  return result.rowCount ?? 0;
}

async function acquireDeletionEvent(
  client: pg.PoolClient,
  provider: Provider,
  externalEventId: string,
  topic: string,
  payloadSha256: string,
) {
  const result = await client.query<{ id: string }>(
    `INSERT INTO webhook_events
      (provider, external_event_id, topic, payload_sha256, claimed_at, lease_expires_at,
       status, attempt_count)
     VALUES ($1, $2, $3, $4, now(), now() + interval '2 minutes', 'PROCESSING', 1)
     ON CONFLICT (provider, external_event_id) DO UPDATE SET
       claimed_at = now(), lease_expires_at = now() + interval '2 minutes',
       attempt_count = webhook_events.attempt_count + 1
     WHERE webhook_events.status <> 'PROCESSED'
       AND (webhook_events.status = 'FAILED' OR webhook_events.lease_expires_at <= now())
       AND webhook_events.topic = EXCLUDED.topic
       AND webhook_events.payload_sha256 = EXCLUDED.payload_sha256
     RETURNING id`,
    [provider, externalEventId, topic, payloadSha256],
  );
  if (!result.rows[0]) {
    await assertWebhookIdentity(client, provider, externalEventId, topic, payloadSha256);
  }
  return result.rows[0]?.id ?? null;
}

async function assertWebhookIdentity(
  client: pg.PoolClient,
  provider: Provider,
  externalEventId: string,
  topic: string,
  payloadSha256: string,
): Promise<void> {
  const existing = await client.query<{ topic: string; payload_sha256: string }>(
    `SELECT topic, payload_sha256 FROM webhook_events
     WHERE provider = $1 AND external_event_id = $2`,
    [provider, externalEventId],
  );
  if (
    !existing.rows[0] ||
    existing.rows[0].topic !== topic ||
    existing.rows[0].payload_sha256 !== payloadSha256
  ) {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 400);
  }
}

async function completeDeletionEvent(client: pg.PoolClient, id: string) {
  await client.query(
    `UPDATE webhook_events SET status = 'PROCESSED', processed_at = now(),
       lease_expires_at = NULL WHERE id = $1`,
    [id],
  );
}

export async function processShopifyUninstallRecord(input: {
  externalEventId: string;
  payloadSha256: string;
}) {
  return withTransaction(async (client) => {
    const eventId = await acquireDeletionEvent(
      client,
      "SHOPIFY",
      input.externalEventId,
      "APP_UNINSTALLED",
      input.payloadSha256,
    );
    if (!eventId) return { duplicate: true };
    const revoked = await client.query<{ id: string }>(
      `UPDATE connections SET encrypted_credentials = '', status = 'REVOKED', updated_at = now()
       WHERE provider = 'SHOPIFY' AND environment = $1 RETURNING id`,
      [activeEnvironment("SHOPIFY")],
    );
    if (revoked.rows[0]) {
      await writeAudit(client, {
        actorType: "SYSTEM",
        action: "PROVIDER_REVOKED",
        eventClass: "CRITICAL",
        entityType: "CONNECTION",
        entityId: revoked.rows[0].id,
        metadata: { provider: "SHOPIFY" },
        requestId: `shopify-webhook:${input.externalEventId}`,
      });
    }
    await completeDeletionEvent(client, eventId);
    return { duplicate: false };
  });
}

export async function processEbayDeletionRecord(input: {
  externalEventId: string;
  payloadSha256: string;
  identifiers: unknown[];
}) {
  return withTransaction(async (client) => {
    const eventId = await acquireDeletionEvent(
      client,
      "EBAY",
      input.externalEventId,
      "MARKETPLACE_ACCOUNT_DELETION",
      input.payloadSha256,
    );
    if (!eventId) return { duplicate: true, deletedOrders: 0 };
    const deletedOrders = await deleteUnissuedCustomerData(
      client,
      "EBAY",
      deletionIdentifiers(input.identifiers),
    );
    await completeDeletionEvent(client, eventId);
    return { duplicate: false, deletedOrders };
  });
}

export async function processShopifyPrivacyRecord(input: {
  externalEventId: string;
  topic: string;
  payloadSha256: string;
  customerIds?: unknown[];
}) {
  return withTransaction(async (client) => {
    const eventId = await acquireDeletionEvent(
      client,
      "SHOPIFY",
      input.externalEventId,
      input.topic,
      input.payloadSha256,
    );
    if (!eventId) return { duplicate: true, deletedOrders: 0 };
    let deletedOrders = 0;
    if (input.topic === "CUSTOMERS_REDACT") {
      deletedOrders = await deleteUnissuedCustomerData(
        client,
        "SHOPIFY",
        deletionIdentifiers(input.customerIds ?? []),
      );
    }
    if (input.topic === "SHOP_REDACT") {
      const result = await client.query(
        `DELETE FROM orders
         WHERE provider = 'SHOPIFY'
           AND (billing_case_id IS NULL OR billing_case_id IN (
             SELECT id FROM billing_cases
             WHERE status IN ('DRAFT', 'NEEDS_REVIEW', 'READY', 'DO_NOT_TRANSMIT')
           ))`,
      );
      deletedOrders = result.rowCount ?? 0;
      await client.query("DELETE FROM customer_source_records WHERE provider = 'SHOPIFY'");
      await client.query(
        `DELETE FROM billing_cases
         WHERE status IN ('DRAFT', 'NEEDS_REVIEW', 'READY', 'DO_NOT_TRANSMIT')
           AND NOT EXISTS (SELECT 1 FROM orders WHERE orders.billing_case_id = billing_cases.id)`,
      );
      await client.query(
        `DELETE FROM customers WHERE NOT EXISTS (
           SELECT 1 FROM orders WHERE orders.customer_id = customers.id
         ) AND NOT EXISTS (
           SELECT 1 FROM customer_source_records WHERE customer_source_records.customer_id = customers.id
         )`,
      );
      await client.query(
        `UPDATE connections SET encrypted_credentials = '', status = 'REVOKED', updated_at = now()
         WHERE provider = 'SHOPIFY'`,
      );
    }
    await completeDeletionEvent(client, eventId);
    return { duplicate: false, deletedOrders };
  });
}
