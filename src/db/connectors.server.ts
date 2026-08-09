import { randomUUID } from "node:crypto";

import type pg from "pg";

import { getConfig } from "../config.server.ts";
import { decryptCredential, encryptCredential } from "../crypto.server.ts";
import { getPool, withTransaction } from "./client.server.ts";
import { AppError, type ErrorCode } from "../errors.ts";

export type Provider = "SHOPIFY" | "EBAY";
export type ConnectionEnvironment = "DEVELOPMENT" | "SANDBOX" | "PRODUCTION";
export type JobType = "shopify_sync_orders" | "shopify_process_webhook" | "ebay_sync_orders";

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
}

export interface ClaimedJob {
  id: string;
  type: JobType;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
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

export async function saveConnection<T>(input: {
  provider: Provider;
  environment: ConnectionEnvironment;
  accountReference: string;
  credentials: T;
}) {
  await withTransaction(async (client) => {
    const existing = await client.query<{ account_reference: string }>(
      `SELECT account_reference FROM connections
       WHERE provider = $1 AND environment = $2
       FOR UPDATE`,
      [input.provider, input.environment],
    );
    const accountChanged = existing.rows[0]?.account_reference !== input.accountReference;
    await client.query(
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
         last_error_code = NULL, last_error_message_sanitized = NULL`,
      [
        input.provider,
        input.environment,
        input.accountReference,
        encryptCredential(input.credentials, credentialsKey()),
      ],
    );
    if (accountChanged) {
      await client.query("DELETE FROM sync_cursors WHERE provider = $1", [input.provider]);
    }
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
     WHERE provider = $1 AND environment = $2 AND status = 'CONNECTED'
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
    `SELECT * FROM connections
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
  }));
}

export async function markConnectionSynced(provider: Provider) {
  await getPool().query(
    `UPDATE connections SET status = 'CONNECTED', last_checked_at = now(), last_synced_at = now(),
       last_error_code = NULL, last_error_message_sanitized = NULL, updated_at = now()
     WHERE provider = $1 AND environment = $2`,
    [provider, activeEnvironment(provider)],
  );
}

export async function markConnectionError(provider: Provider, code: ErrorCode, terminal = false) {
  const status = terminal
    ? "ERROR"
    : code === "AUTH_PROVIDER_EXPIRED"
      ? "REAUTH_REQUIRED"
      : code === "PROVIDER_RATE_LIMITED" || code === "PROVIDER_UNAVAILABLE"
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
  stream = "orders",
) {
  await getPool().query(
    `INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, stream) DO UPDATE SET
       cursor = EXCLUDED.cursor, overlap_from = EXCLUDED.overlap_from, updated_at = now()`,
    [provider, stream, cursor, overlapFrom],
  );
}

export async function enqueueJob(type: JobType, payload: Record<string, unknown> = {}) {
  await getPool().query("INSERT INTO jobs (type, payload_json) VALUES ($1, $2)", [
    type,
    JSON.stringify(payload),
  ]);
}

export async function scheduleDueSyncs() {
  await getPool().query(
    `INSERT INTO jobs (type)
     SELECT CASE provider
       WHEN 'SHOPIFY' THEN 'shopify_sync_orders'
       ELSE 'ebay_sync_orders'
     END
     FROM connections
     WHERE status = 'CONNECTED'
       AND ((provider = 'SHOPIFY' AND environment = $1)
         OR (provider = 'EBAY' AND environment = $2))
       AND (last_synced_at IS NULL OR last_synced_at <= now() - interval '10 minutes')
     ON CONFLICT DO NOTHING`,
    [activeEnvironment("SHOPIFY"), activeEnvironment("EBAY")],
  );
}

export async function claimJob(workerId: string = randomUUID()): Promise<ClaimedJob | null> {
  const result = await withTransaction((client) =>
    client.query<{
      id: string;
      type: JobType;
      payload_json: Record<string, unknown>;
      attempts: number;
      max_attempts: number;
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
         lease_expires_at = now() + interval '2 minutes', locked_by = $1
       FROM candidate WHERE jobs.id = candidate.id
       RETURNING jobs.id, jobs.type, jobs.payload_json, jobs.attempts, jobs.max_attempts`,
      [workerId],
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
      }
    : null;
}

export async function completeJob(job: ClaimedJob) {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE jobs SET status = 'COMPLETED', completed_at = now(), lease_expires_at = NULL,
         locked_by = NULL WHERE id = $1`,
      [job.id],
    );
    const eventId = Number(job.payload.webhookEventId);
    if (Number.isSafeInteger(eventId)) {
      await client.query(
        `UPDATE webhook_events SET status = 'PROCESSED', processed_at = now(),
           lease_expires_at = NULL WHERE id = $1`,
        [eventId],
      );
    }
  });
}

export async function failJob(job: ClaimedJob, code: ErrorCode) {
  const retryable = code === "PROVIDER_RATE_LIMITED" || code === "PROVIDER_UNAVAILABLE";
  const terminal = job.attempts >= job.maxAttempts || !retryable;
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE jobs SET status = $2, run_at = CASE WHEN $2 = 'PENDING'
           THEN now() + make_interval(secs => LEAST(900, 5 * power(2, attempts)::integer))
           ELSE run_at END,
         lease_expires_at = NULL, locked_by = NULL, last_error_code = $3
       WHERE id = $1`,
      [job.id, terminal ? "FAILED" : "PENDING", code],
    );
    const eventId = Number(job.payload.webhookEventId);
    if (terminal && Number.isSafeInteger(eventId)) {
      await client.query(
        "UPDATE webhook_events SET status = 'FAILED', error_code = $2 WHERE id = $1",
        [eventId, code],
      );
    }
  });
  return terminal;
}

export async function ingestShopifyWebhook(input: {
  externalEventId: string;
  topic: string;
  payloadSha256: string;
  orderId: string | null;
}) {
  return withTransaction(async (client) => {
    const event = await client.query<{ id: string; acquired: boolean }>(
      `INSERT INTO webhook_events
        (provider, external_event_id, topic, payload_sha256, claimed_at,
         lease_expires_at, attempt_count)
       VALUES ('SHOPIFY', $1, $2, $3, now(), now() + interval '2 minutes', 1)
       ON CONFLICT (provider, external_event_id) DO UPDATE SET
         claimed_at = now(), lease_expires_at = now() + interval '2 minutes',
         attempt_count = webhook_events.attempt_count + 1, status = 'PROCESSING', error_code = NULL
       WHERE webhook_events.status = 'FAILED'
          OR (webhook_events.status = 'PROCESSING' AND webhook_events.lease_expires_at <= now())
       RETURNING id, true AS acquired`,
      [input.externalEventId, input.topic, input.payloadSha256],
    );
    if (!event.rows[0]) return { duplicate: true };
    if (input.orderId) {
      await client.query(
        `INSERT INTO jobs (type, payload_json)
         VALUES ('shopify_process_webhook', $1)`,
        [JSON.stringify({ orderId: input.orderId, webhookEventId: event.rows[0].id })],
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

export async function revokeConnection(provider: Provider) {
  await getPool().query(
    `UPDATE connections SET encrypted_credentials = '', status = 'REVOKED', updated_at = now()
     WHERE provider = $1 AND environment = $2`,
    [provider, activeEnvironment(provider)],
  );
}

export async function recordShopifyDataRequest(input: {
  externalEventId: string;
  payloadSha256: string;
  customerIds: string[];
  orderIds: string[];
}) {
  const result = await getPool().query<{ id: string }>(
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
  return { duplicate: !result.rows[0] };
}

export async function pendingShopifyDataRequests() {
  const result = await getPool().query<{ external_event_id: string }>(
    `SELECT external_event_id FROM webhook_events
     WHERE provider = 'SHOPIFY' AND topic = 'CUSTOMERS_DATA_REQUEST' AND status = 'PENDING'
     ORDER BY received_at`,
  );
  return result.rows.map((row) => row.external_event_id);
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
     RETURNING id`,
    [provider, externalEventId, topic, payloadSha256],
  );
  return result.rows[0]?.id ?? null;
}

async function completeDeletionEvent(client: pg.PoolClient, id: string) {
  await client.query(
    `UPDATE webhook_events SET status = 'PROCESSED', processed_at = now(),
       lease_expires_at = NULL WHERE id = $1`,
    [id],
  );
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
