import type pg from "pg";
import { z } from "zod";
import { ARUBA_API_POLICY } from "../aruba-api-policy.ts";
import { calculateArubaBackfillProgress } from "../aruba-backfill-progress.ts";
import { getConfig } from "../config.server.ts";
import { encryptCredential } from "../crypto.server.ts";
import { AppError } from "../errors.ts";
import {
  ARUBA_API_V2_CONTRACT,
  arubaApiAccountInfoSchema,
  authenticateArubaApiWithAccount,
} from "../integrations/aruba-api.server.ts";
import { invalidateConfiguredArubaApiSession } from "./aruba-api-connection.server.ts";
import { writeAudit } from "./audit.server.ts";
import { reserveArubaApiAuthentication } from "./aruba-api-authentication.server.ts";
import { getArubaApiTrafficStatus } from "./aruba-api-traffic.server.ts";
import { getPool, withTransaction } from "./client.server.ts";
import {
  arubaProviderCall,
  connection,
  connectionEnvironment,
  credentialsKey,
  inventoryEnvironment,
  parseStoredCredentials,
  requireOwner,
  storedApiEnvironment,
  storedCredentialsSchema,
  type ArubaApiActor,
  type ArubaSyncRunRow,
} from "./aruba-api-context.server.ts";

export async function getArubaApiConnectionStatus() {
  const current = await connection(getPool());
  if (!current) {
    return {
      configured: false as const,
      status: "NOT_CONFIGURED" as const,
      apiPaused: true,
      inboundEnabled: false,
      automaticAuthority: "API" as const,
      credentialsVerifiedAt: null,
      credentialsRotatedAt: null,
      lastSyncedAt: null,
      lastFullSyncAt: null,
      lastErrorCode: null,
      limits: {
        inventoryRequestsPerMinute: Math.floor(60_000 / ARUBA_API_POLICY.invoiceReadIntervalMs),
        notificationRequestsPerMinute: Math.floor(
          60_000 / ARUBA_API_POLICY.notificationReadIntervalMs,
        ),
        providerInventoryRequestsPerMinute:
          ARUBA_API_V2_CONTRACT.sentInvoiceSearchRequestsPerMinutePerIp,
        providerNotificationRequestsPerMinute:
          ARUBA_API_V2_CONTRACT.sentNotificationSearchRequestsPerMinutePerIp,
        cooldownUntil: null,
        lastRateLimitedAt: null,
      },
      latestRun: null,
      account: null,
    };
  }
  const [latestRun, traffic] = await Promise.all([
    getPool().query<ArubaSyncRunRow>(
      `WITH RECURSIVE latest AS (
         SELECT * FROM aruba_sync_runs
         WHERE environment = $1 AND account_reference = $2
         ORDER BY started_at DESC LIMIT 1
       ), lineage AS (
         SELECT id, continued_from_run_id, started_at FROM latest
         UNION ALL
         SELECT parent.id, parent.continued_from_run_id, parent.started_at
         FROM aruba_sync_runs AS parent
         JOIN lineage AS child ON parent.id = child.continued_from_run_id
       )
       SELECT latest.*, (SELECT min(started_at) FROM lineage) AS lineage_started_at
       FROM latest`,
      [inventoryEnvironment(), current.account_reference],
    ),
    getArubaApiTrafficStatus(storedApiEnvironment(current)),
  ]);
  const run = latestRun.rows[0];
  const account = arubaApiAccountInfoSchema.safeParse(current.account_info_json);
  return {
    configured: current.encrypted_credentials !== null,
    status: current.status,
    apiPaused: current.api_paused,
    inboundEnabled: current.inbound_enabled,
    automaticAuthority: current.automatic_authority,
    credentialsVerifiedAt: current.credentials_verified_at?.toISOString() ?? null,
    credentialsRotatedAt: current.credentials_rotated_at?.toISOString() ?? null,
    lastSyncedAt: current.last_synced_at?.toISOString() ?? null,
    lastFullSyncAt: current.last_full_sync_at?.toISOString() ?? null,
    lastErrorCode: current.last_error_code,
    account: account.success
      ? {
          ...account.data,
          checkedAt: current.account_info_checked_at?.toISOString() ?? null,
          usagePercent: Math.round(
            (account.data.usageStatus.usedSpaceKB / account.data.usageStatus.maxSpaceKB) * 100,
          ),
          expirationDays: Math.ceil(
            (new Date(`${account.data.accountStatus.expirationDate}T23:59:59.999Z`).getTime() -
              Date.now()) /
              86_400_000,
          ),
        }
      : null,
    limits: {
      inventoryRequestsPerMinute: Math.floor(60_000 / ARUBA_API_POLICY.invoiceReadIntervalMs),
      notificationRequestsPerMinute: Math.floor(
        60_000 / ARUBA_API_POLICY.notificationReadIntervalMs,
      ),
      providerInventoryRequestsPerMinute:
        ARUBA_API_V2_CONTRACT.sentInvoiceSearchRequestsPerMinutePerIp,
      providerNotificationRequestsPerMinute:
        ARUBA_API_V2_CONTRACT.sentNotificationSearchRequestsPerMinutePerIp,
      cooldownUntil: traffic.cooldownUntil,
      lastRateLimitedAt: traffic.lastRateLimitedAt,
    },
    latestRun: run
      ? {
          id: run.id,
          kind: run.kind,
          mode: run.authority_mode,
          status: run.status,
          documents: run.document_count,
          groups: run.group_count,
          pages: run.page_count,
          files: run.file_count,
          notifications: run.notification_count,
          requests: run.request_count,
          requestLimit: run.request_limit,
          checkpointEnd: run.checkpoint_end.toISOString(),
          checkpointStart: run.checkpoint_start.toISOString(),
          checkpointPage: run.checkpoint_page,
          windowStart: run.window_start.toISOString(),
          windowEnd: run.window_end.toISOString(),
          startedAt: run.started_at.toISOString(),
          completedAt: run.completed_at?.toISOString() ?? null,
          progress: calculateArubaBackfillProgress({
            kind: run.kind,
            status: run.status,
            windowStart: run.window_start,
            windowEnd: run.window_end,
            checkpointStart: run.checkpoint_start,
            lineageStartedAt: run.lineage_started_at ?? run.started_at,
            completedAt: run.completed_at,
          }),
        }
      : null,
  };
}

async function arubaBackfillReadiness(client: pg.Pool | pg.PoolClient) {
  const result = await client.query<{
    active_jobs: number;
    actionable_failures: number;
    historical_failures: number;
    failure_codes: Array<{ code: string; count: number }>;
  }>(
    `WITH aruba_connection AS (
       SELECT account_reference,
         CASE WHEN environment = 'PRODUCTION' THEN 'PRODUCTION' ELSE 'MOCK' END AS inventory_environment
       FROM connections
       WHERE provider = 'ARUBA' AND environment = $1
     ), classified AS (
       SELECT jobs.type, jobs.status, jobs.last_error_code, jobs.lease_expires_at,
              coalesce(jobs.locked_at, jobs.run_at, jobs.created_at) AS observed_at
       FROM jobs
       WHERE jobs.type IN ('aruba_backfill_inventory', 'aruba_sync_inventory',
         'aruba_refresh_nonterminal', 'aruba_full_inventory')
     ), recovered AS (
       SELECT failed.observed_at, failed.last_error_code,
         EXISTS (
           SELECT 1 FROM aruba_sync_runs runs
           CROSS JOIN aruba_connection connection
           WHERE runs.status = 'COMPLETED' AND runs.completed_at > failed.observed_at
             AND runs.environment = connection.inventory_environment
             AND runs.account_reference = connection.account_reference
             AND CASE failed.type
               WHEN 'aruba_backfill_inventory' THEN runs.kind = 'BACKFILL'
               WHEN 'aruba_full_inventory' THEN runs.kind IN ('BACKFILL', 'FULL')
               WHEN 'aruba_sync_inventory' THEN runs.kind IN ('BACKFILL', 'FULL', 'INCREMENTAL')
               WHEN 'aruba_refresh_nonterminal' THEN runs.kind IN ('BACKFILL', 'FULL', 'TARGETED')
               ELSE false
             END
         ) AS recovered
       FROM classified failed
       WHERE failed.status = 'FAILED'
     ), code_counts AS (
       SELECT coalesce(last_error_code, 'UNKNOWN') AS code, count(*)::int AS count
       FROM recovered WHERE NOT recovered
       GROUP BY coalesce(last_error_code, 'UNKNOWN')
     )
     SELECT
       count(*) FILTER (WHERE status IN ('PENDING', 'RUNNING'))::int AS active_jobs,
       (SELECT count(*)::int FROM recovered WHERE NOT recovered) AS actionable_failures,
       (SELECT count(*)::int FROM recovered WHERE recovered) AS historical_failures,
       coalesce((SELECT jsonb_agg(jsonb_build_object('code', code, 'count', count)
         ORDER BY count DESC, code) FROM code_counts), '[]'::jsonb) AS failure_codes
     FROM classified`,
    [connectionEnvironment()],
  );
  const row = result.rows[0];
  return {
    activeJobs: row?.active_jobs ?? 0,
    actionableFailures: row?.actionable_failures ?? 0,
    historicalFailures: row?.historical_failures ?? 0,
    failureCodes: row?.failure_codes ?? [],
  };
}

export async function getArubaBackfillReadiness() {
  return arubaBackfillReadiness(getPool());
}

export async function getArubaApiCredentialIdentity(actor: ArubaApiActor) {
  requireOwner(actor);
  const current = await connection(getPool());
  if (!current?.encrypted_credentials) return null;
  try {
    const credentials = parseStoredCredentials(current.encrypted_credentials);
    return {
      apiEnvironment: credentials.apiEnvironment,
      username: credentials.username,
      expectedTaxId: credentials.expectedTaxId,
    };
  } catch (error) {
    if (error instanceof AppError && error.code === "PROVIDER_NOT_CONFIGURED") return null;
    throw error;
  }
}

export async function saveArubaApiCredentials(
  input: {
    apiEnvironment: unknown;
    username: unknown;
    password: unknown;
    expectedTaxId: unknown;
  },
  actor: ArubaApiActor,
) {
  requireOwner(actor);
  const parsed = storedCredentialsSchema.safeParse(input);
  if (!parsed.success) throw new AppError("AUTH_INVALID_CREDENTIALS", 422);
  await reserveArubaApiAuthentication(parsed.data.apiEnvironment);
  const authenticated = await arubaProviderCall(parsed.data.apiEnvironment, "AUTH", () =>
    authenticateArubaApiWithAccount({
      environment: parsed.data.apiEnvironment,
      credentials: parsed.data,
    }),
  );
  const saved = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('connector:ARUBA'))");
    const existing = await connection(client, true);
    const saved = await client.query<{ id: string }>(
      `INSERT INTO connections
        (provider, environment, account_reference, encrypted_credentials, status,
         api_paused, inbound_enabled, automatic_authority, last_checked_at,
         credentials_verified_at, credentials_rotated_at, credentials_revoked_at,
         account_info_json, account_info_checked_at)
       VALUES ('ARUBA', $1, $2, $3, 'PAUSED', true, false, 'API', now(), now(), now(), NULL,
         $4::jsonb, now())
       ON CONFLICT (provider, environment) DO UPDATE SET
         account_reference = EXCLUDED.account_reference,
         encrypted_credentials = EXCLUDED.encrypted_credentials,
         status = 'PAUSED', api_paused = true, inbound_enabled = false,
         automatic_authority = 'API',
         last_checked_at = now(), credentials_verified_at = now(),
         credentials_rotated_at = now(), credentials_revoked_at = NULL,
         account_info_json = EXCLUDED.account_info_json,
         account_info_checked_at = EXCLUDED.account_info_checked_at,
         last_error_code = NULL, last_error_message_sanitized = NULL, updated_at = now()
       RETURNING id`,
      [
        connectionEnvironment(),
        getConfig().ARUBA_ACCOUNT_REFERENCE,
        encryptCredential(parsed.data, credentialsKey()),
        JSON.stringify(authenticated.account),
      ],
    );
    if (existing && existing.account_reference !== getConfig().ARUBA_ACCOUNT_REFERENCE) {
      await client.query(
        `UPDATE aruba_sync_runs SET status = 'CANCELLED', completed_at = NULL,
           lease_expires_at = now(), last_error_code = 'ARUBA_ACCOUNT_MISMATCH',
           last_error_message_sanitized = 'Account Aruba sostituito'
         WHERE environment = $1 AND account_reference = $2 AND status = 'RUNNING'`,
        [inventoryEnvironment(), existing.account_reference],
      );
    }
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "ARUBA_API_CREDENTIALS_CHANGED",
      eventClass: "CRITICAL",
      entityType: "CONNECTION",
      entityId: saved.rows[0]!.id,
      metadata: {
        provider: "ARUBA",
        credentialOperation: existing ? "ROTATED" : "CONFIGURED",
      },
      requestId: actor.requestId,
    });
    return { saved: true, initiallyPaused: true };
  });
  invalidateConfiguredArubaApiSession();
  return saved;
}

export async function revokeArubaApiCredentials(actor: ArubaApiActor) {
  requireOwner(actor);
  const revoked = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('connector:ARUBA'))");
    const current = await connection(client, true);
    if (!current) throw new AppError("PROVIDER_NOT_CONFIGURED", 404);
    await client.query(
      `UPDATE connections SET encrypted_credentials = NULL, status = 'REVOKED',
         api_paused = true, inbound_enabled = false, automatic_authority = 'API',
         credentials_revoked_at = now(), updated_at = now()
       WHERE id = $1`,
      [current.id],
    );
    await client.query(
      `UPDATE aruba_sync_runs SET status = 'CANCELLED', lease_expires_at = now(),
         last_error_code = 'PROVIDER_NOT_CONFIGURED',
         last_error_message_sanitized = 'Credenziale Aruba revocata'
       WHERE environment = $1 AND account_reference = $2 AND status = 'RUNNING'`,
      [inventoryEnvironment(), current.account_reference],
    );
    await client.query(
      `UPDATE jobs SET status = 'COMPLETED', completed_at = now(), lease_expires_at = NULL,
         locked_by = NULL, claim_token = NULL, result_json = '{"credentialsRevoked":true}'::jsonb
       WHERE type IN ('aruba_backfill_inventory', 'aruba_sync_inventory',
         'aruba_refresh_nonterminal', 'aruba_full_inventory')
         AND status IN ('PENDING', 'RUNNING')`,
    );
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "ARUBA_API_CREDENTIALS_CHANGED",
      eventClass: "CRITICAL",
      entityType: "CONNECTION",
      entityId: current.id,
      metadata: { provider: "ARUBA", credentialOperation: "REVOKED" },
      requestId: actor.requestId,
    });
    return { revoked: true };
  });
  invalidateConfiguredArubaApiSession();
  return revoked;
}

export async function setArubaApiControls(
  input: { apiPaused: unknown; inboundEnabled: unknown },
  actor: ArubaApiActor,
) {
  requireOwner(actor);
  const parsed = z
    .object({
      apiPaused: z.union([z.boolean(), z.enum(["true", "false"])]).transform(String),
      inboundEnabled: z.union([z.boolean(), z.enum(["true", "false"])]).transform(String),
    })
    .safeParse(input);
  if (!parsed.success) throw new AppError("ARUBA_INVENTORY_INVALID", 422);
  const apiPaused = parsed.data.apiPaused === "true";
  const inboundEnabled = parsed.data.inboundEnabled === "true";
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('connector:ARUBA'))");
    const current = await connection(client, true);
    if (!current?.encrypted_credentials || !current.credentials_verified_at) {
      throw new AppError("PROVIDER_NOT_CONFIGURED", 503);
    }
    await client.query(
      `UPDATE connections SET api_paused = $2, inbound_enabled = $3,
         status = CASE WHEN $2 OR NOT $3 THEN 'PAUSED' ELSE 'CONNECTED' END,
         updated_at = now() WHERE id = $1`,
      [current.id, apiPaused, inboundEnabled],
    );
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "ARUBA_API_CONTROLS_CHANGED",
      eventClass: "CRITICAL",
      entityType: "CONNECTION",
      entityId: current.id,
      metadata: { provider: "ARUBA" },
      before: { apiPaused: current.api_paused, inboundEnabled: current.inbound_enabled },
      after: { apiPaused, inboundEnabled },
      requestId: actor.requestId,
    });
    return { apiPaused, inboundEnabled };
  });
}

export async function requestArubaApiSync(actor?: ArubaApiActor) {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('connector:ARUBA'))");
    const current = await connection(client, true);
    if (
      !current?.encrypted_credentials ||
      !current.credentials_verified_at ||
      current.api_paused ||
      !current.inbound_enabled ||
      current.status !== "CONNECTED"
    ) {
      throw new AppError("PROVIDER_NOT_CONFIGURED", 503);
    }
    const backfill = await client.query(
      `SELECT 1 FROM aruba_sync_runs
       WHERE environment = $1 AND account_reference = $2
         AND kind = 'BACKFILL' AND status = 'COMPLETED'`,
      [inventoryEnvironment(), current.account_reference],
    );
    const type = backfill.rows[0] ? "aruba_sync_inventory" : "aruba_backfill_inventory";
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO jobs (type, payload_json, run_at)
       VALUES ($1, jsonb_build_object('requestedBy', $2::text),
         greatest(now(), $3::timestamptz + interval '61 seconds'))
       ON CONFLICT DO NOTHING RETURNING id`,
      [type, actor ? String(actor.id) : null, current.credentials_verified_at],
    );
    if (inserted.rows[0])
      await writeAudit(client, {
        actorType: actor ? "ADMIN" : "SYSTEM",
        actorId: actor ? String(actor.id) : undefined,
        action: "ARUBA_API_SYNC_REQUESTED",
        eventClass: "OPERATIONAL",
        entityType: "CONNECTION",
        entityId: current.id,
        metadata: { provider: "ARUBA" },
        requestId: actor?.requestId ?? "aruba-inventory-before-send",
      });
    return { queued: Boolean(inserted.rows[0]), jobId: inserted.rows[0]?.id ?? null };
  });
}
