import { createHash, randomUUID } from "node:crypto";

import type pg from "pg";
import { z } from "zod";

import {
  hasRequiredArubaApiFiles,
  mapArubaApiInboundGroup,
  type ArubaApiInboundDocument,
} from "../aruba-api-inbound.ts";
import { ARUBA_API_POLICY, type ArubaApiReadScope } from "../aruba-api-policy.ts";
import { calculateArubaBackfillProgress } from "../aruba-backfill-progress.ts";
import {
  compareArubaInboundParity,
  type ArubaInboundParityDocument,
} from "../aruba-inbound-parity.ts";
import { getConfig } from "../config.server.ts";
import { decryptCredential, encryptCredential } from "../crypto.server.ts";
import { AppError, type ErrorCode } from "../errors.ts";
import {
  ARUBA_API_V2_CONTRACT,
  authenticateArubaApi,
  readArubaApiInvoiceDetail,
  readArubaApiInvoicePage,
  readArubaApiNotifications,
  type ArubaApiCredentials,
  type ArubaApiEnvironment,
  type ArubaApiInvoiceDetail,
  type ArubaApiSession,
} from "../integrations/aruba-api.server.ts";
import { writeAudit } from "./audit.server.ts";
import {
  assertArubaApiCooldownInactive,
  getArubaApiTrafficStatus,
  recordArubaApiRateLimited,
  waitForArubaApiReadSlot,
} from "./aruba-api-traffic.server.ts";
import { commitArubaApiInventoryPage } from "./aruba-api-canonical-page.server.ts";
import { importArubaApiGroupFile } from "./aruba-api-group-file.server.ts";
import { importArubaRemoteOfficialFileFromApi } from "./aruba-inbound.server.ts";
import { stageApiPage } from "./aruba-api-stage.server.ts";
import { getPool, withJoinedTransaction, withTransaction } from "./client.server.ts";
import type { ClaimedJob, JobType } from "./connectors.server.ts";

const FULL_HISTORY_START = new Date("2019-01-01T00:00:00.000Z");
const WINDOW_MS = ARUBA_API_POLICY.backfillWindowMs;
const INCREMENTAL_OVERLAP_MS = 7 * 24 * 60 * 60_000;
const REQUEST_LIMIT = ARUBA_API_POLICY.requestLimitPerRun;

const storedCredentialsSchema = z.object({
  apiEnvironment: z.enum(["DEMO", "PRODUCTION"]),
  username: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(500),
  expectedTaxId: z.string().trim().min(1).max(64),
});

type StoredCredentials = z.infer<typeof storedCredentialsSchema>;
type RunKind = "BACKFILL" | "INCREMENTAL" | "TARGETED" | "FULL";
type AuthorityMode = "SHADOW" | "CANONICAL";

export interface ArubaApiActor {
  id: number;
  canApprove: boolean;
  requestId: string;
}

interface ArubaApiConnectionRow {
  id: string;
  environment: "DEVELOPMENT" | "PRODUCTION";
  account_reference: string;
  encrypted_credentials: string | null;
  status: "PAUSED" | "CONNECTED" | "REAUTH_REQUIRED" | "REVOKED" | "ERROR";
  api_paused: boolean;
  inbound_enabled: boolean;
  automatic_authority: "BROWSER" | "API";
  credentials_verified_at: Date | null;
  credentials_rotated_at: Date | null;
  credentials_revoked_at: Date | null;
  last_synced_at: Date | null;
  last_full_sync_at: Date | null;
  last_error_code: string | null;
}

interface ArubaSyncRunRow {
  id: string;
  continued_from_run_id: string | null;
  environment: "MOCK" | "PRODUCTION";
  api_environment: ArubaApiEnvironment;
  account_reference: string;
  kind: RunKind;
  authority_mode: AuthorityMode;
  status: "RUNNING" | "COMPLETED" | "FAILED" | "INCOMPLETE" | "CANCELLED";
  window_start: Date;
  window_end: Date;
  checkpoint_start: Date;
  checkpoint_end: Date;
  checkpoint_page: number;
  page_count: number;
  group_count: number;
  document_count: number;
  file_count: number;
  notification_count: number;
  request_count: number;
  request_limit: number;
  started_at: Date;
  completed_at: Date | null;
  lineage_started_at?: Date;
}

function connectionEnvironment(): ArubaApiConnectionRow["environment"] {
  return getConfig().APP_ENV === "production" ? "PRODUCTION" : "DEVELOPMENT";
}

function inventoryEnvironment(): ArubaSyncRunRow["environment"] {
  return getConfig().APP_ENV === "production" ? "PRODUCTION" : "MOCK";
}

function credentialsKey(): string {
  const value = getConfig().CREDENTIALS_ENCRYPTION_KEY;
  if (!value) throw new AppError("PROVIDER_NOT_CONFIGURED", 503);
  return value;
}

function requireOwner(actor: ArubaApiActor) {
  if (!actor.canApprove) throw new AppError("ARUBA_OPERATION_FORBIDDEN", 403);
}

function runKind(type: JobType): RunKind {
  if (type === "aruba_backfill_inventory") return "BACKFILL";
  if (type === "aruba_refresh_nonterminal") return "TARGETED";
  if (type === "aruba_full_inventory") return "FULL";
  if (type === "aruba_sync_inventory") return "INCREMENTAL";
  throw new AppError("PROVIDER_RESPONSE_INVALID", 422);
}

function runJobType(type: JobType): type is Extract<JobType, `aruba_${string}`> {
  return type.startsWith("aruba_");
}

function parseStoredCredentials(value: string): StoredCredentials {
  try {
    const parsed = storedCredentialsSchema.safeParse(
      decryptCredential<unknown>(value, credentialsKey()),
    );
    if (!parsed.success) throw new Error("invalid");
    return parsed.data;
  } catch {
    throw new AppError("PROVIDER_NOT_CONFIGURED", 503);
  }
}

function storedApiEnvironment(current: ArubaApiConnectionRow): ArubaApiEnvironment {
  if (current.encrypted_credentials) {
    try {
      return parseStoredCredentials(current.encrypted_credentials).apiEnvironment;
    } catch {
      // Lo stato deve restare consultabile anche con una credenziale non decifrabile.
    }
  }
  return getConfig().APP_ENV === "production" ? "PRODUCTION" : "DEMO";
}

async function reserveArubaApiAuthentication(environment: ArubaApiEnvironment) {
  await assertArubaApiCooldownInactive(environment);
  await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('aruba-api-authentication'))");
    await assertArubaApiCooldownInactive(environment, client);
    const latest = await client.query<{ attempted_at: Date }>(
      `SELECT attempted_at FROM aruba_api_auth_attempts
       ORDER BY attempted_at DESC LIMIT 1`,
    );
    if (
      latest.rows[0] &&
      Date.now() - latest.rows[0].attempted_at.getTime() < ARUBA_API_POLICY.authenticationIntervalMs
    ) {
      throw new AppError("ARUBA_API_COOLDOWN_ACTIVE", 429);
    }
    await client.query("INSERT INTO aruba_api_auth_attempts DEFAULT VALUES");
    await client.query(
      "DELETE FROM aruba_api_auth_attempts WHERE attempted_at < now() - interval '1 day'",
    );
  });
}

async function arubaProviderCall<T>(environment: ArubaApiEnvironment, call: () => Promise<T>) {
  try {
    return await call();
  } catch (error) {
    if (error instanceof AppError && error.code === "PROVIDER_RATE_LIMITED") {
      await recordArubaApiRateLimited(environment);
    }
    throw error;
  }
}

async function connection(client: pg.Pool | pg.PoolClient, lock = false) {
  const result = lock
    ? await client.query<ArubaApiConnectionRow>(
        `SELECT id, environment, account_reference, encrypted_credentials, status,
                api_paused, inbound_enabled, automatic_authority, credentials_verified_at,
                credentials_rotated_at, credentials_revoked_at, last_synced_at,
                last_full_sync_at, last_error_code
         FROM connections
         WHERE provider = 'ARUBA' AND environment = $1
         FOR UPDATE`,
        [connectionEnvironment()],
      )
    : await client.query<ArubaApiConnectionRow>(
        `SELECT id, environment, account_reference, encrypted_credentials, status,
                api_paused, inbound_enabled, automatic_authority, credentials_verified_at,
                credentials_rotated_at, credentials_revoked_at, last_synced_at,
                last_full_sync_at, last_error_code
         FROM connections
         WHERE provider = 'ARUBA' AND environment = $1`,
        [connectionEnvironment()],
      );
  return result.rows[0] ?? null;
}

export async function getArubaApiConnectionStatus() {
  const current = await connection(getPool());
  if (!current) {
    return {
      configured: false as const,
      status: "NOT_CONFIGURED" as const,
      apiPaused: true,
      inboundEnabled: false,
      automaticAuthority: "BROWSER" as const,
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
      parity: null,
    };
  }
  const [latestRun, parity, traffic] = await Promise.all([
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
    getPool().query<{
      status: "MATCHED" | "DIVERGENT" | "INCOMPLETE";
      api_documents: number;
      browser_documents: number;
      matched_documents: number;
      missing_in_api: number;
      missing_in_browser: number;
      status_mismatches: number;
      file_mismatches: number;
      summary_json: {
        unresolvedBrowserConflicts?: number;
        populationStreams?: string[];
        apiFileCoverage?: { xml?: number; p7m?: number; pdf?: number; notifications?: number };
        browserBaselineCompletedAt?: string | null;
      };
      created_at: Date;
    }>(
      `SELECT status, api_documents, browser_documents, matched_documents,
              missing_in_api, missing_in_browser, status_mismatches, file_mismatches,
              summary_json, created_at
       FROM aruba_inbound_parity_dossiers
       WHERE environment = $1 AND account_reference = $2
       ORDER BY created_at DESC LIMIT 1`,
      [inventoryEnvironment(), current.account_reference],
    ),
    getArubaApiTrafficStatus(storedApiEnvironment(current)),
  ]);
  const run = latestRun.rows[0];
  const dossier = parity.rows[0];
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
    parity: dossier
      ? {
          status: dossier.status,
          apiDocuments: dossier.api_documents,
          browserDocuments: dossier.browser_documents,
          matchedDocuments: dossier.matched_documents,
          missingInApi: dossier.missing_in_api,
          missingInBrowser: dossier.missing_in_browser,
          statusMismatches: dossier.status_mismatches,
          fileMismatches: dossier.file_mismatches,
          unresolvedBrowserConflicts: dossier.summary_json.unresolvedBrowserConflicts ?? 0,
          populationStreams: dossier.summary_json.populationStreams ?? [],
          apiFileCoverage: {
            xml: dossier.summary_json.apiFileCoverage?.xml ?? 0,
            p7m: dossier.summary_json.apiFileCoverage?.p7m ?? 0,
            pdf: dossier.summary_json.apiFileCoverage?.pdf ?? 0,
            notifications: dossier.summary_json.apiFileCoverage?.notifications ?? 0,
          },
          browserBaselineCompletedAt: dossier.summary_json.browserBaselineCompletedAt ?? null,
          createdAt: dossier.created_at.toISOString(),
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
       SELECT last_synced_at FROM connections
       WHERE provider = 'ARUBA' AND environment = $1
     ), classified AS (
       SELECT jobs.status, jobs.last_error_code, jobs.lease_expires_at,
              coalesce(jobs.locked_at, jobs.run_at, jobs.created_at) AS observed_at,
              connection.last_synced_at
       FROM jobs
       CROSS JOIN aruba_connection AS connection
       WHERE jobs.type IN ('aruba_backfill_inventory', 'aruba_sync_inventory',
         'aruba_refresh_nonterminal', 'aruba_full_inventory')
     ), recovery AS (
       SELECT greatest(
         max(last_synced_at),
         max(observed_at) FILTER (WHERE status = 'COMPLETED'),
         max(observed_at) FILTER (WHERE status = 'RUNNING' AND lease_expires_at > now())
       ) AS recovered_at
       FROM classified
     ), code_counts AS (
       SELECT coalesce(last_error_code, 'UNKNOWN') AS code, count(*)::int AS count
       FROM classified
       WHERE status = 'FAILED'
         AND (SELECT recovered_at FROM recovery) IS DISTINCT FROM greatest(
           (SELECT recovered_at FROM recovery), observed_at
         )
       GROUP BY coalesce(last_error_code, 'UNKNOWN')
     )
     SELECT
       count(*) FILTER (WHERE status IN ('PENDING', 'RUNNING'))::int AS active_jobs,
       count(*) FILTER (WHERE status = 'FAILED'
         AND (SELECT recovered_at FROM recovery) IS DISTINCT FROM greatest(
           (SELECT recovered_at FROM recovery), observed_at
         ))::int AS actionable_failures,
       count(*) FILTER (WHERE status = 'FAILED'
         AND (SELECT recovered_at FROM recovery) IS NOT DISTINCT FROM greatest(
           (SELECT recovered_at FROM recovery), observed_at
         ))::int AS historical_failures,
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

const arubaFallbackDecisionSchema = z.enum(["KEEP_TRANSITIONAL_FALLBACK", "RETIRE_BROWSER_HELPER"]);

export type ArubaInboundClosureGate =
  | "CONNECTION_READY"
  | "BACKFILL_COMPLETE"
  | "NO_ACTIVE_JOBS"
  | "NO_ACTIONABLE_FAILURES"
  | "PARITY_MATCHED"
  | "BROWSER_BASELINE_CURRENT"
  | "NORMALIZED_DIVERGENCES_ZERO"
  | "OFFICIAL_FILES_COMPLETE"
  | "NOTIFICATIONS_VERIFIED"
  | "BROWSER_CONFLICTS_ZERO"
  | "TRAFFIC_GUARD_CLEAR"
  | "BROWSER_STILL_AUTHORITATIVE";

interface ArubaInboundClosureRow {
  connection_ready: boolean;
  automatic_authority: "BROWSER" | "API";
  backfill_complete: boolean;
  parity_status: "MATCHED" | "DIVERGENT" | "INCOMPLETE" | null;
  browser_baseline_current: boolean;
  api_documents: number;
  missing_in_api: number;
  missing_in_browser: number;
  status_mismatches: number;
  file_mismatches: number;
  unresolved_browser_conflicts: number;
  documents_without_official_payload: number;
  documents_without_notification: number;
}

async function arubaInboundClosureReadiness(client: pg.Pool | pg.PoolClient) {
  const result = await client.query<ArubaInboundClosureRow>(
    `WITH current_connection AS (
         SELECT account_reference, status = 'CONNECTED' AND encrypted_credentials IS NOT NULL
                  AND credentials_verified_at IS NOT NULL AND inbound_enabled AND NOT api_paused
                  AS connection_ready,
                automatic_authority
         FROM connections WHERE provider = 'ARUBA' AND environment = $1
       ), completed_backfill AS (
         SELECT runs.id FROM aruba_sync_runs runs
         JOIN current_connection connection
           ON connection.account_reference = runs.account_reference
         WHERE runs.environment = $2 AND runs.kind = 'BACKFILL'
           AND runs.authority_mode = 'SHADOW' AND runs.status = 'COMPLETED'
         ORDER BY runs.completed_at DESC LIMIT 1
       ), candidate AS (
         SELECT runs.* FROM aruba_sync_runs runs
         JOIN current_connection connection
           ON connection.account_reference = runs.account_reference
         WHERE runs.environment = $2 AND runs.kind IN ('BACKFILL', 'FULL')
           AND runs.authority_mode = 'SHADOW' AND runs.status = 'COMPLETED'
         ORDER BY runs.completed_at DESC, runs.started_at DESC, runs.id DESC LIMIT 1
       ), browser_baseline AS (
         SELECT sessions.id
         FROM aruba_sync_sessions sessions
         JOIN current_connection connection
           ON connection.account_reference = sessions.account_reference
         WHERE sessions.environment = $2 AND sessions.status = 'COMPLETED'
           AND sessions.is_full_scan AND sessions.completed_at IS NOT NULL
           AND sessions.full_scan_completed_at IS NOT NULL
           AND EXISTS (SELECT 1 FROM aruba_sync_pages pages
             WHERE pages.sync_session_id = sessions.id AND pages.full_scan)
         ORDER BY sessions.full_scan_completed_at DESC LIMIT 1
       ), dossier AS (
         SELECT dossiers.* FROM aruba_inbound_parity_dossiers dossiers
         JOIN candidate ON candidate.id = dossiers.sync_run_id
         WHERE NOT EXISTS (SELECT 1 FROM aruba_sync_runs later
           WHERE later.environment = candidate.environment
             AND later.account_reference = candidate.account_reference
             AND later.authority_mode = 'SHADOW' AND later.status = 'COMPLETED'
             AND (later.completed_at, later.started_at, later.id) >
               (candidate.completed_at, candidate.started_at, candidate.id))
       )
       SELECT
         coalesce(connection.connection_ready, false) AS connection_ready,
         coalesce(connection.automatic_authority, 'BROWSER') AS automatic_authority,
         completed_backfill.id IS NOT NULL AS backfill_complete,
         dossier.status AS parity_status,
         coalesce(
           dossier.summary_json->>'browserBaselineSessionId' = browser_baseline.id::text,
           false
         ) AS browser_baseline_current,
         coalesce(dossier.api_documents, 0)::integer AS api_documents,
         coalesce(dossier.missing_in_api, 0)::integer AS missing_in_api,
         coalesce(dossier.missing_in_browser, 0)::integer AS missing_in_browser,
         coalesce(dossier.status_mismatches, 0)::integer AS status_mismatches,
         coalesce(dossier.file_mismatches, 0)::integer AS file_mismatches,
         coalesce((dossier.summary_json->>'unresolvedBrowserConflicts')::integer, 0)
           AS unresolved_browser_conflicts,
         coalesce((SELECT count(*)::integer FROM aruba_api_shadow_documents documents
           WHERE documents.sync_run_id = candidate.id
             AND documents.xml_sha256 IS NULL AND documents.p7m_sha256 IS NULL
             AND NOT EXISTS (SELECT 1 FROM aruba_api_shadow_group_files group_files
               WHERE group_files.sync_run_id = documents.sync_run_id
                 AND group_files.provider_group_id = documents.provider_group_id
                 AND group_files.kind IN ('ARUBA_XML', 'ARUBA_P7M'))), 0)
           AS documents_without_official_payload,
         coalesce((SELECT count(*)::integer FROM aruba_api_shadow_documents documents
           WHERE documents.sync_run_id = candidate.id
             AND jsonb_array_length(documents.notification_hashes) = 0), 0)
           AS documents_without_notification
       FROM current_connection connection
       LEFT JOIN candidate ON true
       LEFT JOIN completed_backfill ON true
       LEFT JOIN dossier ON true
       LEFT JOIN browser_baseline ON true`,
    [connectionEnvironment(), inventoryEnvironment()],
  );
  const jobs = await arubaBackfillReadiness(client);
  const traffic = await client.query<{ cooling_down: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM aruba_api_traffic_limits
        WHERE api_environment = $1 AND cooldown_until > now()) AS cooling_down`,
    [getConfig().APP_ENV === "production" ? "PRODUCTION" : "DEMO"],
  );
  const row = result.rows[0] ?? {
    connection_ready: false,
    automatic_authority: "BROWSER" as const,
    backfill_complete: false,
    parity_status: null,
    browser_baseline_current: false,
    api_documents: 0,
    missing_in_api: 0,
    missing_in_browser: 0,
    status_mismatches: 0,
    file_mismatches: 0,
    unresolved_browser_conflicts: 0,
    documents_without_official_payload: 0,
    documents_without_notification: 0,
  };
  const gates: Record<ArubaInboundClosureGate, boolean> = {
    CONNECTION_READY: row.connection_ready,
    BACKFILL_COMPLETE: row.backfill_complete,
    NO_ACTIVE_JOBS: jobs.activeJobs === 0,
    NO_ACTIONABLE_FAILURES: jobs.actionableFailures === 0,
    PARITY_MATCHED: row.parity_status === "MATCHED",
    BROWSER_BASELINE_CURRENT: row.browser_baseline_current,
    NORMALIZED_DIVERGENCES_ZERO:
      row.api_documents > 0 &&
      row.missing_in_api === 0 &&
      row.missing_in_browser === 0 &&
      row.status_mismatches === 0 &&
      row.file_mismatches === 0,
    OFFICIAL_FILES_COMPLETE: row.api_documents > 0 && row.documents_without_official_payload === 0,
    NOTIFICATIONS_VERIFIED: row.api_documents > 0 && row.documents_without_notification === 0,
    BROWSER_CONFLICTS_ZERO: row.unresolved_browser_conflicts === 0,
    TRAFFIC_GUARD_CLEAR: traffic.rows[0]?.cooling_down !== true,
    BROWSER_STILL_AUTHORITATIVE: row.automatic_authority === "BROWSER",
  };
  const blockers: ArubaInboundClosureGate[] = [];
  for (const [gate, passed] of Object.entries(gates) as Array<[ArubaInboundClosureGate, boolean]>) {
    if (!passed) blockers.push(gate);
  }
  return {
    readyForAuthoritySwitch: blockers.length === 0,
    gates,
    blockers,
    actionableFailures: jobs.actionableFailures,
    historicalFailures: jobs.historicalFailures,
  };
}

export async function getArubaInboundClosureReadiness() {
  return arubaInboundClosureReadiness(getPool());
}

export async function promoteArubaApiAuthority(
  input: { fallbackDecision: unknown },
  actor: ArubaApiActor,
) {
  requireOwner(actor);
  const fallbackDecision = arubaFallbackDecisionSchema.safeParse(input.fallbackDecision);
  if (!fallbackDecision.success) throw new AppError("ARUBA_INVENTORY_INVALID", 422);
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('connector:ARUBA'))");
    const current = await connection(client, true);
    if (!current) throw new AppError("PROVIDER_NOT_CONFIGURED", 404);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `aruba-read:${inventoryEnvironment()}:${current.account_reference}`,
    ]);
    const readiness = await arubaInboundClosureReadiness(client);
    if (!readiness.readyForAuthoritySwitch) {
      throw new AppError("ARUBA_INVENTORY_BLOCKED", 409);
    }
    await client.query(
      `UPDATE connections SET automatic_authority = 'API', updated_at = now()
       WHERE id = $1 AND automatic_authority = 'BROWSER'`,
      [current.id],
    );
    await client.query(
      `UPDATE aruba_sync_sessions SET status = 'REVOKED', lease_expires_at = NULL
       WHERE environment = $1 AND account_reference = $2
         AND source = 'HELPER' AND status IN ('ACTIVE', 'SCANNING')`,
      [inventoryEnvironment(), current.account_reference],
    );
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "ARUBA_API_AUTHORITY_CHANGED",
      eventClass: "CRITICAL",
      entityType: "CONNECTION",
      entityId: current.id,
      metadata: { provider: "ARUBA", scope: fallbackDecision.data },
      before: { automaticAuthority: "BROWSER" },
      after: { automaticAuthority: "API" },
      requestId: actor.requestId,
    });
    return { automaticAuthority: "API" as const, fallbackDecision: fallbackDecision.data };
  });
}

export async function getArubaApiCredentialIdentity(actor: ArubaApiActor) {
  requireOwner(actor);
  const current = await connection(getPool());
  if (!current?.encrypted_credentials) return null;
  try {
    const credentials = parseStoredCredentials(current.encrypted_credentials);
    return {
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
  await arubaProviderCall(parsed.data.apiEnvironment, () =>
    authenticateArubaApi({
      environment: parsed.data.apiEnvironment,
      credentials: parsed.data,
    }),
  );
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('connector:ARUBA'))");
    const existing = await connection(client, true);
    const saved = await client.query<{ id: string }>(
      `INSERT INTO connections
        (provider, environment, account_reference, encrypted_credentials, status,
         api_paused, inbound_enabled, automatic_authority, last_checked_at,
         credentials_verified_at, credentials_rotated_at, credentials_revoked_at)
       VALUES ('ARUBA', $1, $2, $3, 'PAUSED', true, false, 'BROWSER', now(), now(), now(), NULL)
       ON CONFLICT (provider, environment) DO UPDATE SET
         account_reference = EXCLUDED.account_reference,
         encrypted_credentials = EXCLUDED.encrypted_credentials,
         status = 'PAUSED', api_paused = true, inbound_enabled = false,
         automatic_authority = CASE
           WHEN connections.account_reference = EXCLUDED.account_reference
             THEN connections.automatic_authority
           ELSE 'BROWSER'
         END,
         last_checked_at = now(), credentials_verified_at = now(),
         credentials_rotated_at = now(), credentials_revoked_at = NULL,
         last_error_code = NULL, last_error_message_sanitized = NULL, updated_at = now()
       RETURNING id`,
      [
        connectionEnvironment(),
        getConfig().ARUBA_ACCOUNT_REFERENCE,
        encryptCredential(parsed.data, credentialsKey()),
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
}

export async function revokeArubaApiCredentials(actor: ArubaApiActor) {
  requireOwner(actor);
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('connector:ARUBA'))");
    const current = await connection(client, true);
    if (!current) throw new AppError("PROVIDER_NOT_CONFIGURED", 404);
    await client.query(
      `UPDATE connections SET encrypted_credentials = NULL, status = 'REVOKED',
         api_paused = true, inbound_enabled = false, automatic_authority = 'BROWSER',
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

export async function requestArubaApiSync(actor: ArubaApiActor) {
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
      [type, String(actor.id), current.credentials_verified_at],
    );
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "ARUBA_API_SYNC_REQUESTED",
      eventClass: "OPERATIONAL",
      entityType: "CONNECTION",
      entityId: current.id,
      metadata: { provider: "ARUBA" },
      requestId: actor.requestId,
    });
    return { queued: Boolean(inserted.rows[0]), jobId: inserted.rows[0]?.id ?? null };
  });
}

async function runnableConnection() {
  const current = await connection(getPool());
  if (
    !current?.encrypted_credentials ||
    !current.credentials_verified_at ||
    current.api_paused ||
    !current.inbound_enabled ||
    current.status !== "CONNECTED"
  ) {
    throw new AppError("PROVIDER_NOT_CONFIGURED", 503);
  }
  return { current, credentials: parseStoredCredentials(current.encrypted_credentials) };
}

async function runMayContinue(run: ArubaSyncRunRow): Promise<boolean> {
  const active = await getPool().query(
    `SELECT 1 FROM connections
     WHERE provider = 'ARUBA' AND environment = $1 AND account_reference = $2
       AND status = 'CONNECTED' AND encrypted_credentials IS NOT NULL
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
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('aruba-api-run'))");
    const expectedAuthority: AuthorityMode =
      current.automatic_authority === "API" ? "CANONICAL" : "SHADOW";
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
         AND previous.kind = $3 AND previous.status = 'INCOMPLETE'
         AND previous.last_error_code = 'ARUBA_API_BUDGET_EXHAUSTED'
         AND previous.authority_mode = $4
         AND NOT EXISTS (
           SELECT 1 FROM aruba_sync_runs AS continuation
           WHERE continuation.continued_from_run_id = previous.id
         )
       ORDER BY previous.started_at DESC LIMIT 1 FOR UPDATE OF previous`,
      [inventoryEnvironment(), current.account_reference, kind, expectedAuthority],
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
        `INSERT INTO aruba_api_shadow_documents
          (sync_run_id, provider_group_id, remote_key, document_type, fiscal_year,
           series, fiscal_number, document_date, total_amount, remote_status,
           xml_sha256, p7m_sha256, pdf_sha256, notification_hashes, observed_at)
         SELECT $1, provider_group_id, remote_key, document_type, fiscal_year,
           series, fiscal_number, document_date, total_amount, remote_status,
           xml_sha256, p7m_sha256, pdf_sha256, notification_hashes, observed_at
         FROM aruba_api_shadow_documents WHERE sync_run_id = $2`,
        [continuationId, source.id],
      );
      await client.query(
        `INSERT INTO aruba_api_shadow_group_files
          (sync_run_id, provider_group_id, kind, sha256)
         SELECT $1, provider_group_id, kind, sha256
         FROM aruba_api_shadow_group_files WHERE sync_run_id = $2`,
        [continuationId, source.id],
      );
      return inserted.rows[0]!;
    }
    let windowStart = FULL_HISTORY_START;
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
          FULL_HISTORY_START.getTime(),
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

async function persistShadowPage(
  run: ArubaSyncRunRow,
  documents: ArubaApiInboundDocument[],
  groupCount: number,
  page: number,
  terminal: boolean,
) {
  const uniqueFiles = new Map(
    documents.flatMap((document) =>
      document.files.map(
        (file) => [`${file.providerGroupId}:${file.kind}:${file.sha256}`, file] as const,
      ),
    ),
  );
  const groupFiles = new Map<string, ArubaApiInboundDocument["groupFiles"][number]>();
  for (const document of documents) {
    for (const file of document.groupFiles) {
      const key = `${file.providerGroupId}:${file.kind}`;
      const previous = groupFiles.get(key);
      if (previous && previous.sha256 !== file.sha256) {
        throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
      }
      groupFiles.set(key, file);
    }
  }
  const fileCount = uniqueFiles.size + groupFiles.size;
  const notificationCount = [...uniqueFiles.values()].filter(
    (file) => file.kind === "SDI_NOTIFICATION",
  ).length;
  return withTransaction(async (client) => {
    const locked = await client.query<ArubaSyncRunRow>(
      `SELECT * FROM aruba_sync_runs WHERE id = $1 AND status = 'RUNNING' FOR UPDATE`,
      [run.id],
    );
    const current = locked.rows[0];
    if (!current || current.authority_mode !== "SHADOW") {
      throw new AppError("CONFLICT_REVISION", 409);
    }
    const digest = createHash("sha256")
      .update(JSON.stringify(documents.map((document) => document.remote)))
      .digest("hex");
    const existing = await client.query<{ payload_digest: string }>(
      `SELECT payload_digest FROM aruba_sync_run_pages
       WHERE sync_run_id = $1 AND window_start = $2 AND window_end = $3
         AND page_ordinal = $4`,
      [run.id, current.checkpoint_start, current.checkpoint_end, page],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].payload_digest !== digest) {
        throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
      }
      return { repeated: true };
    }
    for (const file of groupFiles.values()) {
      const stored = await client.query(
        `INSERT INTO aruba_api_shadow_group_files
          (sync_run_id, provider_group_id, kind, sha256)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (sync_run_id, provider_group_id, kind) DO UPDATE
           SET sha256 = aruba_api_shadow_group_files.sha256
           WHERE aruba_api_shadow_group_files.sha256 = EXCLUDED.sha256
         RETURNING sync_run_id`,
        [run.id, file.providerGroupId, file.kind, file.sha256],
      );
      if (!stored.rows[0]) throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
    }
    for (const document of documents) {
      let xmlSha256: string | null = null;
      let p7mSha256: string | null = null;
      let pdfSha256: string | null = null;
      const notificationHashes: string[] = [];
      for (const file of document.files) {
        if (file.kind === "ARUBA_XML") xmlSha256 ??= file.sha256;
        if (file.kind === "ARUBA_P7M") p7mSha256 ??= file.sha256;
        if (file.kind === "ARUBA_PDF") pdfSha256 ??= file.sha256;
        if (file.kind === "SDI_NOTIFICATION") notificationHashes.push(file.sha256);
      }
      await client.query(
        `INSERT INTO aruba_api_shadow_documents
          (sync_run_id, provider_group_id, remote_key, document_type, fiscal_year, series,
           fiscal_number, document_date, total_amount, remote_status, xml_sha256, p7m_sha256,
           pdf_sha256, notification_hashes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (sync_run_id, remote_key) DO UPDATE SET
           remote_status = EXCLUDED.remote_status, xml_sha256 = EXCLUDED.xml_sha256,
           p7m_sha256 = EXCLUDED.p7m_sha256, pdf_sha256 = EXCLUDED.pdf_sha256,
           notification_hashes = EXCLUDED.notification_hashes, observed_at = now()`,
        [
          run.id,
          document.providerGroupId,
          document.remoteKey,
          document.remote.documentType,
          document.remote.fiscalYear,
          document.remote.series,
          document.remote.fiscalNumber,
          document.remote.documentDate,
          document.remote.totalAmount,
          document.remote.status,
          xmlSha256,
          p7mSha256,
          pdfSha256,
          JSON.stringify(notificationHashes.toSorted()),
        ],
      );
    }
    await client.query(
      `INSERT INTO aruba_sync_run_pages
        (sync_run_id, window_start, window_end, page_ordinal, terminal,
         group_count, document_count, payload_digest)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        run.id,
        current.checkpoint_start,
        current.checkpoint_end,
        page,
        terminal,
        groupCount,
        documents.length,
        digest,
      ],
    );
    await client.query(
      `UPDATE aruba_sync_runs SET page_count = page_count + 1,
         group_count = group_count + $2, document_count = document_count + $3,
         file_count = file_count + $4, notification_count = notification_count + $5,
         checkpoint_page = CASE WHEN $6 THEN 1 ELSE $7 END,
         lease_expires_at = now() + interval '3 minutes'
       WHERE id = $1`,
      [run.id, groupCount, documents.length, fileCount, notificationCount, terminal, page + 1],
    );
    return { repeated: false };
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
    const remoteDocumentId = remoteDocumentIds.get(document.remote.remoteId);
    if (!remoteDocumentId) throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
    for (const file of document.files) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- I file appartengono alla pagina canonica appena acquisita e vanno validati e persistiti in ordine prima del checkpoint successivo.
      await importArubaRemoteOfficialFileFromApi(remoteDocumentId, file.kind, file.bytes, {
        type: "API",
        runId: run.id,
        providerGroupId: document.providerGroupId,
        providerFilename: file.filename,
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
) {
  return withJoinedTransaction(() =>
    persistCanonicalPageContents(run, documents, groupCount, page, terminal),
  );
}

async function persistApiPage(
  run: ArubaSyncRunRow,
  documents: ArubaApiInboundDocument[],
  groupCount: number,
  page: number,
  terminal: boolean,
) {
  if (run.authority_mode === "CANONICAL") {
    await persistCanonicalPage(run, documents, groupCount, page, terminal);
  } else {
    await persistShadowPage(run, documents, groupCount, page, terminal);
  }
}

async function advanceWindow(runId: string) {
  return withTransaction(async (client) => {
    const result = await client.query<ArubaSyncRunRow>(
      `SELECT * FROM aruba_sync_runs WHERE id = $1 AND status = 'RUNNING' FOR UPDATE`,
      [runId],
    );
    const run = result.rows[0];
    if (!run) throw new AppError("CONFLICT_REVISION", 409);
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

async function createParityDossier(run: ArubaSyncRunRow) {
  const browserSession = await getPool().query<{
    id: string;
    started_at: Date;
    completed_at: Date;
    scan_ordinal: number;
  }>(
    `SELECT sessions.id, sessions.started_at, sessions.completed_at,
            full_scan.scan_ordinal
     FROM aruba_sync_sessions AS sessions
     JOIN LATERAL (
       SELECT max(pages.scan_ordinal)::integer AS scan_ordinal
       FROM aruba_sync_pages AS pages
       WHERE pages.sync_session_id = sessions.id AND pages.full_scan
       HAVING max(pages.scan_ordinal) IS NOT NULL
     ) AS full_scan ON true
     WHERE sessions.environment = $1 AND sessions.account_reference = $2
       AND sessions.status = 'COMPLETED' AND sessions.is_full_scan
       AND sessions.completed_at IS NOT NULL AND sessions.full_scan_completed_at IS NOT NULL
     ORDER BY sessions.full_scan_completed_at DESC LIMIT 1`,
    [run.environment, run.account_reference],
  );
  const baseline = browserSession.rows[0];
  const populationStreams = baseline
    ? (
        await getPool().query<{ stream: string }>(
          `SELECT DISTINCT stream FROM aruba_sync_pages
           WHERE sync_session_id = $1
             AND scan_ordinal = $2
             AND stream ~ '^(invoices|credit-notes):[0-9]{4}$'
           ORDER BY stream`,
          [baseline.id, baseline.scan_ordinal],
        )
      ).rows.map((row) => row.stream)
    : [];
  const unresolvedBrowserConflicts = baseline
    ? Number(
        (
          await getPool().query<{ count: number }>(
            `SELECT count(*)::int AS count FROM aruba_deduplication_conflicts
             WHERE sync_session_id = $1 AND resolved_at IS NULL`,
            [baseline.id],
          )
        ).rows[0]?.count ?? 0,
      )
    : 0;
  const api = baseline
    ? await getPool().query<{
        document_type: string;
        fiscal_year: number;
        series: string | null;
        fiscal_number: string | null;
        document_date: string;
        total_amount: number;
        remote_status: string;
        xml_sha256: string | null;
        p7m_sha256: string | null;
        pdf_sha256: string | null;
        notification_hashes: string[];
        group_xml_sha256: string | null;
        group_p7m_sha256: string | null;
        group_pdf_sha256: string | null;
      }>(
        `SELECT shadow.document_type, shadow.fiscal_year, shadow.series,
                shadow.fiscal_number, shadow.document_date::text AS document_date,
                shadow.total_amount, shadow.remote_status, shadow.xml_sha256,
                shadow.p7m_sha256, shadow.pdf_sha256, shadow.notification_hashes,
                group_files.xml_sha256 AS group_xml_sha256,
                group_files.p7m_sha256 AS group_p7m_sha256,
                group_files.pdf_sha256 AS group_pdf_sha256
         FROM aruba_api_shadow_documents AS shadow
         LEFT JOIN LATERAL (
           SELECT max(sha256) FILTER (WHERE kind = 'ARUBA_XML') AS xml_sha256,
                  max(sha256) FILTER (WHERE kind = 'ARUBA_P7M') AS p7m_sha256,
                  max(sha256) FILTER (WHERE kind = 'ARUBA_PDF') AS pdf_sha256
           FROM aruba_api_shadow_group_files
           WHERE sync_run_id = shadow.sync_run_id
             AND provider_group_id = shadow.provider_group_id
         ) group_files ON true
         WHERE shadow.sync_run_id = $1
           AND concat(
             CASE shadow.document_type WHEN 'TD01' THEN 'invoices:' ELSE 'credit-notes:' END,
             shadow.fiscal_year
           ) = ANY($2::text[])`,
        [run.id, populationStreams],
      )
    : { rows: [] as never[] };
  const browser = baseline
    ? await getPool().query<{
        document_type: string;
        fiscal_year: number;
        series: string | null;
        fiscal_number: string | null;
        document_date: string;
        total_amount: number;
        remote_status: string;
        file_hashes: string[];
      }>(
        `SELECT document->>'documentType' AS document_type,
                (document->>'fiscalYear')::integer AS fiscal_year,
                nullif(document->>'series', '') AS series,
                nullif(document->>'fiscalNumber', '') AS fiscal_number,
                document->>'documentDate' AS document_date,
                (document->>'totalAmount')::integer AS total_amount,
                document->>'status' AS remote_status,
                coalesce(official_files.hashes, ARRAY[]::text[]) AS file_hashes
         FROM aruba_sync_pages AS pages
         CROSS JOIN LATERAL jsonb_array_elements(pages.documents_json) AS item(document)
         LEFT JOIN LATERAL (
           SELECT array_agg(DISTINCT storage.sha256 ORDER BY storage.sha256) AS hashes
           FROM aruba_remote_documents AS remote
           JOIN aruba_files AS files ON files.remote_document_id = remote.id
           JOIN storage_objects AS storage ON storage.id = files.storage_object_id
           WHERE remote.environment = $4 AND remote.account_reference = $5
             AND remote.remote_id = document->>'remoteId'
             AND files.kind IN ('ARUBA_XML', 'ARUBA_P7M')
         ) AS official_files ON true
         WHERE pages.sync_session_id = $1 AND pages.scan_ordinal = $2
           AND pages.stream = ANY($3::text[])`,
        [
          baseline.id,
          baseline.scan_ordinal,
          populationStreams,
          run.environment,
          run.account_reference,
        ],
      )
    : { rows: [] as never[] };
  const groupFileHashes = new Set(
    api.rows.flatMap((document) =>
      [document.group_xml_sha256, document.group_p7m_sha256].filter((value): value is string =>
        Boolean(value),
      ),
    ),
  );
  const browserFileHashes = new Set(browser.rows.flatMap((document) => document.file_hashes));
  const groupFileMismatches = [...groupFileHashes].filter(
    (hash) => !browserFileHashes.has(hash),
  ).length;
  const apiParityDocuments: ArubaInboundParityDocument[] = api.rows.map((document) => ({
    documentType: document.document_type,
    fiscalYear: document.fiscal_year,
    series: document.series,
    fiscalNumber: document.fiscal_number,
    documentDate: document.document_date,
    totalAmount: document.total_amount,
    remoteStatus: document.remote_status,
    fileHashes: [document.xml_sha256, document.p7m_sha256].filter((value): value is string =>
      Boolean(value),
    ),
  }));
  const browserParityDocuments: ArubaInboundParityDocument[] = browser.rows.map((document) => ({
    documentType: document.document_type,
    fiscalYear: document.fiscal_year,
    series: document.series,
    fiscalNumber: document.fiscal_number,
    documentDate: document.document_date,
    totalAmount: document.total_amount,
    remoteStatus: document.remote_status,
    fileHashes: document.file_hashes.filter((hash) => !groupFileHashes.has(hash)),
  }));
  const documentComparison = compareArubaInboundParity({
    api: apiParityDocuments,
    browser: browserParityDocuments,
  });
  const comparison = {
    ...documentComparison,
    status:
      documentComparison.status === "DIVERGENT" || groupFileMismatches > 0
        ? ("DIVERGENT" as const)
        : ("MATCHED" as const),
    fileMismatches: documentComparison.fileMismatches + groupFileMismatches,
  };
  const status =
    !baseline || populationStreams.length === 0
      ? "INCOMPLETE"
      : unresolvedBrowserConflicts > 0
        ? "DIVERGENT"
        : comparison.status;
  const apiFileCoverage = {
    xml: api.rows.filter(
      (document) => document.xml_sha256 !== null || document.group_xml_sha256 !== null,
    ).length,
    p7m: api.rows.filter(
      (document) => document.p7m_sha256 !== null || document.group_p7m_sha256 !== null,
    ).length,
    pdf: api.rows.filter(
      (document) => document.pdf_sha256 !== null || document.group_pdf_sha256 !== null,
    ).length,
    notifications: api.rows.reduce(
      (count, document) => count + document.notification_hashes.length,
      0,
    ),
  };
  await getPool().query(
    `INSERT INTO aruba_inbound_parity_dossiers
      (id, sync_run_id, environment, account_reference, status, api_documents,
       browser_documents, matched_documents, missing_in_api, missing_in_browser,
       status_mismatches, file_mismatches, summary_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       jsonb_build_object(
         'browserBaselineCompletedAt', $13::timestamptz,
         'populationStreams', $14::jsonb,
         'unresolvedBrowserConflicts', $15::integer,
         'apiFileCoverage', $16::jsonb,
         'browserBaselineScanOrdinal', $17::integer,
         'browserBaselineSessionId', $18::uuid,
         'groupFileMismatches', $19::integer
       ))
     ON CONFLICT (sync_run_id) DO NOTHING`,
    [
      randomUUID(),
      run.id,
      run.environment,
      run.account_reference,
      status,
      comparison.apiDocuments,
      comparison.browserDocuments,
      comparison.matchedDocuments,
      comparison.missingInApi,
      comparison.missingInBrowser,
      comparison.statusMismatches,
      comparison.fileMismatches,
      baseline?.completed_at ?? null,
      JSON.stringify(populationStreams),
      unresolvedBrowserConflicts,
      JSON.stringify(apiFileCoverage),
      baseline?.scan_ordinal ?? null,
      baseline?.id ?? null,
      groupFileMismatches,
    ],
  );
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
    return run;
  });
  if (
    completed.authority_mode === "SHADOW" &&
    (completed.kind === "BACKFILL" || completed.kind === "FULL")
  ) {
    await createParityDossier(completed);
  }
  return completed;
}

async function targetedDocuments(
  run: ArubaSyncRunRow,
  manager: ArubaSessionManager,
  waitForRead: (scope: ArubaApiReadScope) => Promise<void>,
) {
  const groups = await getPool().query<{ provider_group_id: string }>(
    run.authority_mode === "CANONICAL"
      ? `SELECT DISTINCT provider_group_id FROM aruba_remote_documents
     WHERE environment = $1 AND account_reference = $2
       AND automatic_source = 'API' AND provider_group_id IS NOT NULL
       AND remote_status IN ('SUBMITTED', 'SDI_PROCESSING', 'UNKNOWN')
     ORDER BY provider_group_id`
      : `SELECT DISTINCT provider_group_id FROM aruba_api_latest_shadow_documents
     WHERE environment = $1 AND account_reference = $2
       AND remote_status IN ('SUBMITTED', 'SDI_PROCESSING', 'UNKNOWN')
     ORDER BY provider_group_id`,
    [run.environment, run.account_reference],
  );
  const documents: ArubaApiInboundDocument[] = [];
  for (const group of groups.rows) {
    await waitForRead("INVOICE_READ");
    await reserveArubaApiRequests(run.id);
    const detail = await arubaProviderCall(manager.environmentName(), async () =>
      readArubaApiInvoiceDetail(await manager.current(), group.provider_group_id),
    );
    documents.push(
      ...(await readGroup(run.id, manager, waitForRead, apiGroupFromDetail(detail), detail)),
    );
  }
  return { documents: documents.flat(), groupCount: groups.rows.length };
}

export async function runArubaApiInboundJob(
  job: ClaimedJob,
  options: { rateDelayMs?: number; now?: Date } = {},
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
  try {
    if (kind === "TARGETED") {
      if (!(await runMayContinue(run))) {
        return { runId: run.id, kind, mode: run.authority_mode, stopped: true };
      }
      const targeted = await targetedDocuments(run, manager, waitForRead);
      await persistApiPage(run, targeted.documents, targeted.groupCount, 1, true);
      await completeRun(run.id);
      return { runId: run.id, kind, documents: targeted.documents.length };
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
      if (!page.terminal) continue;
      if (await advanceWindow(run.id)) continue;
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
