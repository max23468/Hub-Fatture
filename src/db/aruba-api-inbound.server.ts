import { createHash, randomUUID } from "node:crypto";

import type pg from "pg";
import { z } from "zod";

import { mapArubaApiInboundGroup, type ArubaApiInboundDocument } from "../aruba-api-inbound.ts";
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
import { getPool, withTransaction } from "./client.server.ts";
import type { ClaimedJob, JobType } from "./connectors.server.ts";

const FULL_HISTORY_START = new Date("2019-01-01T00:00:00.000Z");
const WINDOW_MS = 48 * 60 * 60_000;
const INCREMENTAL_OVERLAP_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_RATE_DELAY_MS = 5_100;
const REQUEST_LIMIT = 10_000;

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

async function reserveArubaApiAuthentication() {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('aruba-api-authentication'))");
    const latest = await client.query<{ attempted_at: Date }>(
      `SELECT attempted_at FROM aruba_api_auth_attempts
       ORDER BY attempted_at DESC LIMIT 1`,
    );
    if (latest.rows[0] && Date.now() - latest.rows[0].attempted_at.getTime() < 60_000) {
      throw new AppError("PROVIDER_RATE_LIMITED", 429);
    }
    await client.query("INSERT INTO aruba_api_auth_attempts DEFAULT VALUES");
    await client.query(
      "DELETE FROM aruba_api_auth_attempts WHERE attempted_at < now() - interval '1 day'",
    );
  });
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
        inventoryRequestsPerMinute: ARUBA_API_V2_CONTRACT.sentInvoiceSearchRequestsPerMinutePerIp,
        notificationRequestsPerMinute:
          ARUBA_API_V2_CONTRACT.sentNotificationSearchRequestsPerMinutePerIp,
      },
      latestRun: null,
      parity: null,
    };
  }
  const [latestRun, parity] = await Promise.all([
    getPool().query<ArubaSyncRunRow>(
      `SELECT * FROM aruba_sync_runs
       WHERE environment = $1 AND account_reference = $2
       ORDER BY started_at DESC LIMIT 1`,
      [inventoryEnvironment(), current.account_reference],
    ),
    getPool().query<{
      status: "MATCHED" | "DIVERGENT" | "INCOMPLETE";
      api_documents: number;
      browser_documents: number;
      matched_documents: number;
      created_at: Date;
    }>(
      `SELECT status, api_documents, browser_documents, matched_documents, created_at
       FROM aruba_inbound_parity_dossiers
       WHERE environment = $1 AND account_reference = $2
       ORDER BY created_at DESC LIMIT 1`,
      [inventoryEnvironment(), current.account_reference],
    ),
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
      inventoryRequestsPerMinute: ARUBA_API_V2_CONTRACT.sentInvoiceSearchRequestsPerMinutePerIp,
      notificationRequestsPerMinute:
        ARUBA_API_V2_CONTRACT.sentNotificationSearchRequestsPerMinutePerIp,
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
          checkpointPage: run.checkpoint_page,
          startedAt: run.started_at.toISOString(),
          completedAt: run.completed_at?.toISOString() ?? null,
        }
      : null,
    parity: dossier
      ? {
          status: dossier.status,
          apiDocuments: dossier.api_documents,
          browserDocuments: dossier.browser_documents,
          matchedDocuments: dossier.matched_documents,
          createdAt: dossier.created_at.toISOString(),
        }
      : null,
  };
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
  await reserveArubaApiAuthentication();
  await authenticateArubaApi({
    environment: parsed.data.apiEnvironment,
    credentials: parsed.data,
  });
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
    const active = await client.query<ArubaSyncRunRow>(
      `SELECT * FROM aruba_sync_runs
       WHERE environment = $1 AND account_reference = $2 AND status = 'RUNNING'
       FOR UPDATE`,
      [inventoryEnvironment(), current.account_reference],
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
         AND NOT EXISTS (
           SELECT 1 FROM aruba_sync_runs AS continuation
           WHERE continuation.continued_from_run_id = previous.id
         )
       ORDER BY previous.started_at DESC LIMIT 1 FOR UPDATE OF previous`,
      [inventoryEnvironment(), current.account_reference, kind],
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
         VALUES ($1, $2, $3, $4, $5, $6, 'SHADOW', $7, $8, $9, $10, $11,
           $12, $13, $14, $15, $16, $17, now() + interval '3 minutes')
         RETURNING *`,
        [
          continuationId,
          source.id,
          source.environment,
          credentials.apiEnvironment,
          source.account_reference,
          source.kind,
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
        "SHADOW",
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
    this.authenticationGate = new RateGate(Math.max(rateDelayMs, 60_100));
  }

  async current() {
    this.session ??= ArubaSessionManager.sessions.get(this.cacheKey) ?? null;
    if (!this.session || this.session.expiresAt <= Date.now() + 60_000) {
      await this.authenticationGate.wait();
      if (this.reserveAuthentication) await reserveArubaApiAuthentication();
      await reserveArubaApiRequests(this.runId, 2);
      this.session = await authenticateArubaApi({
        environment: this.environment,
        credentials: this.credentials,
      });
      ArubaSessionManager.sessions.set(this.cacheKey, this.session);
    }
    return this.session;
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
  notificationGate: RateGate,
  group: ReturnType<typeof apiGroupFromDetail>,
  knownDetail?: ArubaApiInvoiceDetail,
) {
  if (!knownDetail) await reserveArubaApiRequests(runId);
  const detail =
    knownDetail ?? (await readArubaApiInvoiceDetail(await manager.current(), group.id));
  await notificationGate.wait();
  await reserveArubaApiRequests(runId);
  const notifications = await readArubaApiNotifications(await manager.current(), group.id);
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
         checkpoint_page = CASE WHEN $4 THEN 1 ELSE $5 END,
         lease_expires_at = now() + interval '3 minutes'
       WHERE id = $1`,
      [run.id, groupCount, documents.length, terminal, page + 1],
    );
    return { repeated: false };
  });
}

async function persistApiPage(
  run: ArubaSyncRunRow,
  documents: ArubaApiInboundDocument[],
  groupCount: number,
  page: number,
  terminal: boolean,
) {
  await persistShadowPage(run, documents, groupCount, page, terminal);
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
  const browserSession = await getPool().query<{ started_at: Date; completed_at: Date }>(
    `SELECT started_at, completed_at FROM aruba_sync_sessions
     WHERE environment = $1 AND account_reference = $2 AND status = 'COMPLETED'
       AND is_full_scan AND completed_at IS NOT NULL
     ORDER BY completed_at DESC LIMIT 1`,
    [run.environment, run.account_reference],
  );
  const baseline = browserSession.rows[0];
  const api = await getPool().query<{
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
  }>(`SELECT * FROM aruba_api_shadow_documents WHERE sync_run_id = $1`, [run.id]);
  const browser = baseline
    ? await getPool().query<{
        id: string;
        document_type: string;
        fiscal_year: number;
        series: string | null;
        fiscal_number: string | null;
        document_date: string;
        total_amount: number;
        remote_status: string;
        file_hashes: Record<string, string[]>;
      }>(
        `SELECT remote.id, remote.document_type, remote.fiscal_year, remote.series,
                remote.fiscal_number, remote.document_date::text, remote.total_amount,
                remote.remote_status,
                coalesce(jsonb_object_agg(files.kind, files.hashes)
                  FILTER (WHERE files.kind IS NOT NULL), '{}') AS file_hashes
         FROM aruba_remote_documents AS remote
         LEFT JOIN LATERAL (
           SELECT aruba_files.kind, jsonb_agg(storage.sha256 ORDER BY storage.sha256) AS hashes
           FROM aruba_files
           JOIN storage_objects AS storage ON storage.id = aruba_files.storage_object_id
           WHERE aruba_files.remote_document_id = remote.id
           GROUP BY aruba_files.kind
         ) AS files ON true
         WHERE remote.environment = $1 AND remote.account_reference = $2
           AND remote.automatic_source <> 'API' AND remote.last_full_scan_at >= $3
         GROUP BY remote.id`,
        [run.environment, run.account_reference, baseline.started_at],
      )
    : { rows: [] as never[] };
  const apiParityDocuments: ArubaInboundParityDocument[] = api.rows.map((document) => ({
    documentType: document.document_type,
    fiscalYear: document.fiscal_year,
    series: document.series,
    fiscalNumber: document.fiscal_number,
    documentDate: document.document_date,
    totalAmount: document.total_amount,
    remoteStatus: document.remote_status,
    fileHashes: [
      document.xml_sha256,
      document.p7m_sha256,
      document.pdf_sha256,
      ...document.notification_hashes,
    ].filter((value): value is string => Boolean(value)),
  }));
  const browserParityDocuments: ArubaInboundParityDocument[] = browser.rows.map((document) => ({
    documentType: document.document_type,
    fiscalYear: document.fiscal_year,
    series: document.series,
    fiscalNumber: document.fiscal_number,
    documentDate: document.document_date,
    totalAmount: document.total_amount,
    remoteStatus: document.remote_status,
    fileHashes: Object.values(document.file_hashes).flat(),
  }));
  const comparison = compareArubaInboundParity({
    api: apiParityDocuments,
    browser: browserParityDocuments,
  });
  const status = !baseline ? "INCOMPLETE" : comparison.status;
  await getPool().query(
    `INSERT INTO aruba_inbound_parity_dossiers
      (id, sync_run_id, environment, account_reference, status, api_documents,
       browser_documents, matched_documents, missing_in_api, missing_in_browser,
       status_mismatches, file_mismatches, summary_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       jsonb_build_object('browserBaselineCompletedAt', $13::timestamptz))
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
  gate: RateGate,
) {
  const groups = await getPool().query<{ provider_group_id: string }>(
    `SELECT DISTINCT provider_group_id FROM aruba_remote_documents
     WHERE environment = $1 AND account_reference = $2
       AND provider_group_id IS NOT NULL
       AND remote_status IN ('SUBMITTED', 'SDI_PROCESSING', 'UNKNOWN')
     ORDER BY provider_group_id`,
    [run.environment, run.account_reference],
  );
  const documents: ArubaApiInboundDocument[] = [];
  for (const group of groups.rows) {
    await reserveArubaApiRequests(run.id);
    const detail = await readArubaApiInvoiceDetail(
      await manager.current(),
      group.provider_group_id,
    );
    documents.push(...(await readGroup(run.id, manager, gate, apiGroupFromDetail(detail), detail)));
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
  const rateDelayMs = options.rateDelayMs ?? DEFAULT_RATE_DELAY_MS;
  const manager = new ArubaSessionManager(
    credentials.apiEnvironment,
    credentials,
    `${current.id}:${current.credentials_rotated_at?.toISOString() ?? "initial"}`,
    run.id,
    rateDelayMs,
    options.rateDelayMs === undefined,
  );
  const searchGate = new RateGate(rateDelayMs);
  const notificationGate = new RateGate(rateDelayMs);
  try {
    if (kind === "TARGETED") {
      if (!(await runMayContinue(run))) {
        return { runId: run.id, kind, mode: run.authority_mode, stopped: true };
      }
      const targeted = await targetedDocuments(run, manager, notificationGate);
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
      await searchGate.wait();
      await reserveArubaApiRequests(run.id);
      const page = await readArubaApiInvoicePage({
        session: await manager.current(),
        page: checkpoint.checkpoint_page,
        windowStart: checkpoint.checkpoint_start,
        windowEnd: checkpoint.checkpoint_end,
      });
      const documents: ArubaApiInboundDocument[] = [];
      for (const group of page.groups) {
        if (!group.invoices.length) continue;
        documents.push(...(await readGroup(run.id, manager, notificationGate, group)));
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
      appError.code === "PROVIDER_RATE_LIMITED" || appError.code === "PROVIDER_UNAVAILABLE";
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
