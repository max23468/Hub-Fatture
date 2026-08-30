import type pg from "pg";

import { getConfig } from "../config.server.ts";
import { decryptCredential, encryptCredential } from "../crypto.server.ts";
import { AppError, type ErrorCode } from "../errors.ts";
import { writeAudit } from "./audit.server.ts";
import { getPool, withTransaction } from "./client.server.ts";
import { activeConnectorEnvironment } from "./connector-environment.server.ts";
import { assertJobLease } from "./connector-jobs.server.ts";
import type {
  ClaimedJob,
  ConnectionEnvironment,
  ConnectorActor,
  HistoryImportResult,
  Provider,
} from "./connector-types.server.ts";

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

function credentialsKey(): string {
  const value = getConfig().CREDENTIALS_ENCRYPTION_KEY;
  if (!value) throw new AppError("PROVIDER_NOT_CONFIGURED", 503);
  return value;
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
    [provider, activeConnectorEnvironment(provider)],
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
    [activeConnectorEnvironment("SHOPIFY"), activeConnectorEnvironment("EBAY")],
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
    [provider, activeConnectorEnvironment(provider)],
  );
  if (!result.rows[0]) throw new AppError("PROVIDER_NOT_CONFIGURED", 503);
  return result.rows[0].pending;
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
    [provider, activeConnectorEnvironment(provider), accountReference],
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
    [provider, activeConnectorEnvironment(provider), accountReference],
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
      [provider, activeConnectorEnvironment(provider)],
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
            code === "ARUBA_API_AUTH_INTERVAL_ACTIVE" ||
            code === "PROVIDER_UNAVAILABLE"
          ? "CONNECTED"
          : "ERROR";
  await getPool().query(
    `UPDATE connections SET status = $2, last_checked_at = now(), last_error_code = $3,
       last_error_message_sanitized = $3, updated_at = now()
     WHERE provider = $1 AND environment = $4`,
    [provider, status, code, activeConnectorEnvironment(provider)],
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
      [activeConnectorEnvironment("EBAY")],
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
    [activeConnectorEnvironment("EBAY")],
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
