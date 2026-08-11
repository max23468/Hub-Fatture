import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import type pg from "pg";

import {
  ARUBA_IMPORT_MAX_BYTES,
  ARUBA_PANEL_ORIGIN,
  ARUBA_UPLOAD_MAX_BYTES,
  arubaAuthProtectionSchema,
  arubaFileKindSchema,
  arubaModeSchema,
  effectiveArubaMode,
  helperEventSchema,
  manifestSha256,
  notificationStatus,
  validateOfficialFile,
  type ArubaFileKind,
  type ArubaManifest,
  type ArubaManifestDocument,
  type ArubaMode,
} from "../aruba.ts";
import { getConfig } from "../config.server.ts";
import { hashToken } from "../crypto.server.ts";
import { AppError } from "../errors.ts";
import { POSTGRES_INTEGER_MAX } from "../orders.ts";
import { writeAudit } from "./audit.server.ts";
import { customerEmailTriggerStatus, scheduleCustomerEmail } from "./email.server.ts";
import { getPool, withTransaction } from "./client.server.ts";
import { isDatabaseId } from "./order-commands.server.ts";

const HELPER_TOKEN_TTL_MS = 15 * 60_000;
const SEND_PERMIT_TTL_MS = 10 * 60_000;
const BATCH_MAX_BYTES = 30_000_000;

export interface ArubaActor {
  id: number;
  canApprove: boolean;
  requestId: string;
}

export interface ApprovedDocumentForBatch extends ArubaManifestDocument {}

interface BatchIdentity {
  id: string;
  environment: "MOCK" | "PRODUCTION";
  mode: ArubaMode;
  account_reference: string;
  manifest_sha256: string;
  document_count: number;
  attempt_number: number;
  status: string;
  requires_reconciliation: boolean;
}

interface TokenContext extends BatchIdentity {
  token_hash: string;
}

function panelUrl(environment: "MOCK" | "PRODUCTION"): string {
  return environment === "PRODUCTION"
    ? `${ARUBA_PANEL_ORIGIN}/`
    : new URL("/aruba-sintetica", getConfig().APP_BASE_URL).toString();
}

function manifestPayload(
  batchId: string,
  environment: "MOCK" | "PRODUCTION",
  mode: ArubaMode,
  accountReference: string,
  attemptNumber: number,
  documents: ArubaManifestDocument[],
) {
  return { batchId, environment, mode, accountReference, attemptNumber, documents };
}

function integer(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > POSTGRES_INTEGER_MAX) {
    throw new AppError("CONFLICT_REVISION", 409);
  }
  return parsed;
}

export async function getArubaSettings() {
  const result = await getPool().query<{ key: string; value_json: unknown; version: number }>(
    "SELECT key, value_json, version FROM settings WHERE key IN ('aruba_mode', 'aruba_auth_protection')",
  );
  const settings = new Map(result.rows.map((row) => [row.key, row]));
  const mode = arubaModeSchema.parse(settings.get("aruba_mode")?.value_json ?? "ASSISTED");
  const environment = getConfig().APP_ENV === "production" ? "PRODUCTION" : "MOCK";
  return {
    mode: {
      value: mode,
      version: settings.get("aruba_mode")?.version ?? 0,
    },
    effectiveMode: effectiveArubaMode(mode, environment, getConfig().ARUBA_SUBMISSION_ENABLED),
    automaticForcedAssisted: environment === "PRODUCTION" && !getConfig().ARUBA_SUBMISSION_ENABLED,
    authProtection: {
      value: arubaAuthProtectionSchema.parse(
        settings.get("aruba_auth_protection")?.value_json ?? "UNKNOWN",
      ),
      version: settings.get("aruba_auth_protection")?.version ?? 0,
    },
  };
}

export async function setArubaSettings(
  raw: { mode: unknown; modeVersion: unknown; authProtection: unknown; authVersion: unknown },
  actor: ArubaActor,
) {
  if (!actor.canApprove) throw new AppError("ARUBA_PERMIT_FORBIDDEN", 403);
  const mode = arubaModeSchema.safeParse(raw.mode);
  const auth = arubaAuthProtectionSchema.safeParse(raw.authProtection);
  const modeVersion = integer(raw.modeVersion);
  const authVersion = integer(raw.authVersion);
  if (!mode.success || !auth.success) throw new AppError("ARUBA_BATCH_INVALID", 422);
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('settings:aruba'))");
    const current = await client.query<{ key: string; version: number }>(
      `SELECT key, version FROM settings
       WHERE key IN ('aruba_mode', 'aruba_auth_protection') FOR UPDATE`,
    );
    const versions = new Map(current.rows.map((row) => [row.key, row.version]));
    if (
      versions.get("aruba_mode") !== modeVersion ||
      versions.get("aruba_auth_protection") !== authVersion
    ) {
      throw new AppError("CONFLICT_REVISION", 409);
    }
    await client.query(
      `UPDATE settings SET value_json = $2, version = version + 1, updated_at = now()
       WHERE key = $1`,
      ["aruba_mode", JSON.stringify(mode.data)],
    );
    await client.query(
      `UPDATE settings SET value_json = $2, version = version + 1, updated_at = now()
       WHERE key = $1`,
      ["aruba_auth_protection", JSON.stringify(auth.data)],
    );
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "ARUBA_SETTINGS_CHANGED",
      eventClass: "CRITICAL",
      entityType: "SETTING",
      entityId: "aruba",
      after: { mode: mode.data, authProtection: auth.data },
      requestId: actor.requestId,
    });
  });
}

async function currentMode(client: pg.PoolClient): Promise<ArubaMode> {
  const setting = await client.query<{ value_json: unknown }>(
    "SELECT value_json FROM settings WHERE key = 'aruba_mode' FOR UPDATE",
  );
  return arubaModeSchema.parse(setting.rows[0]?.value_json ?? "ASSISTED");
}

async function currentArubaAccount(client: pg.PoolClient) {
  const config = getConfig();
  const environment = config.APP_ENV === "production" ? "PRODUCTION" : "DEVELOPMENT";
  await client.query(
    `INSERT INTO connections
      (provider, environment, account_reference, encrypted_credentials, status, last_checked_at)
     VALUES ('ARUBA', $1, $2, NULL, 'CONNECTED', now())
     ON CONFLICT (provider, environment) DO UPDATE SET
       account_reference = EXCLUDED.account_reference, status = 'CONNECTED',
       last_checked_at = now(), updated_at = now(), last_error_code = NULL,
       last_error_message_sanitized = NULL`,
    [environment, config.ARUBA_ACCOUNT_REFERENCE],
  );
  return config.ARUBA_ACCOUNT_REFERENCE;
}

export async function createArubaBatch(
  client: pg.PoolClient,
  documents: ApprovedDocumentForBatch[],
  actor: ArubaActor,
  expectedMode?: unknown,
  attemptNumber = 1,
  preservedMode?: ArubaMode,
): Promise<string> {
  if (!actor.canApprove) throw new AppError("ARUBA_PERMIT_FORBIDDEN", 403);
  if (
    !documents.length ||
    documents.length > 300 ||
    documents.reduce((sum, document) => sum + document.sizeBytes, 0) > BATCH_MAX_BYTES
  ) {
    throw new AppError("ARUBA_BATCH_INVALID", 422);
  }
  const unique = new Set(documents.map((document) => document.id));
  if (unique.size !== documents.length) throw new AppError("ARUBA_BATCH_INVALID", 422);
  const configuredMode = await currentMode(client);
  const environment = getConfig().APP_ENV === "production" ? "PRODUCTION" : "MOCK";
  const effectiveMode = effectiveArubaMode(
    configuredMode,
    environment,
    getConfig().ARUBA_SUBMISSION_ENABLED,
  );
  if (expectedMode !== undefined && expectedMode !== effectiveMode) {
    throw new AppError("DOCUMENT_PROJECTION_STALE", 409);
  }
  if (preservedMode === "AUTOMATIC" && effectiveMode !== "AUTOMATIC") {
    throw new AppError("ARUBA_PERMIT_INVALID", 409);
  }
  const mode = preservedMode ?? effectiveMode;
  const accountReference = await currentArubaAccount(client);
  const batchId = randomUUID();
  const digest = manifestSha256(
    manifestPayload(batchId, environment, mode, accountReference, attemptNumber, documents),
  );
  await client.query(
    `INSERT INTO aruba_batches
      (id, environment, mode, account_reference, manifest_sha256, document_count,
       attempt_number, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      batchId,
      environment,
      mode,
      accountReference,
      digest,
      documents.length,
      attemptNumber,
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
    await client.query(
      `INSERT INTO aruba_submissions
        (batch_id, document_id, attempt_number, environment, mode, manifest_sha256, xml_sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [batchId, document.id, attemptNumber, environment, mode, digest, document.sha256],
    );
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
  if (mode === "AUTOMATIC") {
    const permitId = randomUUID();
    await client.query(
      `INSERT INTO aruba_send_permits
        (id, batch_id, manifest_sha256, document_count, mode, authorized_by, expires_at)
       VALUES ($1, $2, $3, $4, 'AUTOMATIC', $5, $6)`,
      [
        permitId,
        batchId,
        digest,
        documents.length,
        actor.id,
        new Date(Date.now() + SEND_PERMIT_TTL_MS),
      ],
    );
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "ARUBA_SEND_PERMIT_CREATED",
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
  }
  return batchId;
}

export async function createBatchForDocuments(documentIds: string[], actor: ArubaActor) {
  if (!actor.canApprove) throw new AppError("ARUBA_PERMIT_FORBIDDEN", 403);
  const ids = [...new Set(documentIds)];
  if (!ids.length || ids.length > 300 || ids.some((id) => !isDatabaseId(id))) {
    throw new AppError("ARUBA_BATCH_INVALID", 422);
  }
  return withTransaction(async (client) => {
    const locked = await client.query<{ id: string }>(
      `SELECT id FROM documents
       WHERE id = ANY($1::bigint[])
       ORDER BY id
       FOR UPDATE`,
      [ids],
    );
    if (locked.rows.length !== ids.length) throw new AppError("ARUBA_BATCH_INVALID", 409);
    const rows = await client.query<{
      id: string;
      draft_version: number;
      xml_sha256: string;
      size_bytes: number;
      series: string;
      fiscal_year: number;
      fiscal_number: number;
      document_date: string;
      total_amount: number;
    }>(
      `SELECT documents.id, documents.draft_version, documents.xml_sha256,
              storage_objects.size_bytes, documents.series, documents.fiscal_year,
              documents.fiscal_number, documents.document_date::text, documents.total_amount
       FROM documents
       JOIN storage_objects ON storage_objects.id = documents.storage_object_id
       LEFT JOIN aruba_batch_documents ON aruba_batch_documents.document_id = documents.id
       WHERE documents.id = ANY($1::bigint[]) AND documents.status = 'APPROVED'
         AND aruba_batch_documents.document_id IS NULL
       FOR UPDATE OF documents`,
      [ids],
    );
    if (rows.rows.length !== ids.length) throw new AppError("ARUBA_BATCH_INVALID", 409);
    return createArubaBatch(
      client,
      rows.rows.map((row) => ({
        id: row.id,
        revision: row.draft_version,
        sha256: row.xml_sha256,
        filename: `${row.series}-${String(row.fiscal_number).padStart(4, "0")}-${String(row.fiscal_year).slice(-2)}.xml`,
        sizeBytes: row.size_bytes,
        fiscalNumber: `${row.series} ${String(row.fiscal_number).padStart(4, "0")}/${String(row.fiscal_year).slice(-2)}`,
        documentDate: row.document_date,
        totalAmount: row.total_amount,
      })),
      actor,
      undefined,
      1,
      "ASSISTED",
    );
  });
}

async function loadToken(client: pg.Pool | pg.PoolClient, token: string, lock = false) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const result = await client.query<TokenContext>(
    `SELECT tokens.token_hash, batches.*
     FROM aruba_helper_tokens AS tokens
     JOIN aruba_batches AS batches ON batches.id = tokens.batch_id
     WHERE tokens.token_hash = $1 AND tokens.revoked_at IS NULL AND tokens.expires_at > now()
     ${lock ? "FOR UPDATE OF tokens, batches" : ""}`,
    [hashToken(token)],
  );
  return result.rows[0] ?? null;
}

export function helperBearer(request: Request): string {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new AppError("ARUBA_HELPER_TOKEN_INVALID", 401);
  return match[1]!;
}

export async function issueHelperToken(batchId: string, actor: ArubaActor) {
  if (!actor.canApprove) throw new AppError("ARUBA_PERMIT_FORBIDDEN", 403);
  if (!/^[0-9a-f-]{36}$/.test(batchId)) throw new AppError("ARUBA_BATCH_INVALID", 422);
  return withTransaction(async (client) => {
    const batch = await client.query<BatchIdentity>(
      "SELECT * FROM aruba_batches WHERE id = $1 FOR UPDATE",
      [batchId],
    );
    const current = batch.rows[0];
    if (!current || current.status === "CANCELLED") {
      throw new AppError("ARUBA_BATCH_INVALID", 409);
    }
    if (current.status === "RECONCILED") {
      const readbackNeeded = await client.query(
        `SELECT 1 FROM aruba_submissions
         WHERE batch_id = $1 AND status <> 'REMOVED' LIMIT 1`,
        [batchId],
      );
      if (!readbackNeeded.rowCount) throw new AppError("ARUBA_BATCH_INVALID", 409);
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + HELPER_TOKEN_TTL_MS);
    await client.query(
      "UPDATE aruba_helper_tokens SET revoked_at = now() WHERE batch_id = $1 AND revoked_at IS NULL",
      [batchId],
    );
    await client.query(
      `INSERT INTO aruba_helper_tokens (token_hash, batch_id, expires_at)
       VALUES ($1, $2, $3)`,
      [hashToken(token), batchId, expiresAt],
    );
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "ARUBA_HELPER_TOKEN_CREATED",
      eventClass: "CRITICAL",
      entityType: "ARUBA_BATCH",
      entityId: batchId,
      metadata: { batchId, manifestSha256: current.manifest_sha256 },
      requestId: actor.requestId,
    });
    return { token, expiresAt: expiresAt.toISOString() };
  });
}

async function batchDocuments(
  client: pg.Pool | pg.PoolClient,
  batchId: string,
): Promise<ArubaManifestDocument[]> {
  const result = await client.query<{
    id: string;
    document_revision: number;
    xml_sha256: string;
    current_revision: number;
    current_sha256: string;
    filename: string;
    size_bytes: number;
    series: string;
    fiscal_year: number;
    fiscal_number: number;
    document_date: string;
    total_amount: number;
  }>(
    `SELECT documents.id, batch_documents.document_revision, batch_documents.xml_sha256,
            documents.draft_version AS current_revision,
            documents.xml_sha256 AS current_sha256,
            batch_documents.filename, storage_objects.size_bytes, documents.series,
            documents.fiscal_year, documents.fiscal_number, documents.document_date::text,
            documents.total_amount
     FROM aruba_batch_documents AS batch_documents
     JOIN documents ON documents.id = batch_documents.document_id
     JOIN storage_objects ON storage_objects.id = documents.storage_object_id
     WHERE batch_documents.batch_id = $1
     ORDER BY batch_documents.position`,
    [batchId],
  );
  return result.rows.map((row) => {
    if (row.current_revision !== row.document_revision || row.current_sha256 !== row.xml_sha256) {
      throw new AppError("ARUBA_BATCH_INVALID", 409);
    }
    return {
      id: row.id,
      revision: row.document_revision,
      sha256: row.xml_sha256,
      filename: row.filename,
      sizeBytes: row.size_bytes,
      fiscalNumber: `${row.series} ${String(row.fiscal_number).padStart(4, "0")}/${String(row.fiscal_year).slice(-2)}`,
      documentDate: row.document_date,
      totalAmount: row.total_amount,
    };
  });
}

function verifyManifest(batch: BatchIdentity, documents: ArubaManifestDocument[]): void {
  const digest = manifestSha256(
    manifestPayload(
      batch.id,
      batch.environment,
      batch.mode,
      batch.account_reference,
      batch.attempt_number,
      documents,
    ),
  );
  if (documents.length !== batch.document_count || digest !== batch.manifest_sha256) {
    throw new AppError("ARUBA_BATCH_INVALID", 409);
  }
}

export async function helperManifest(token: string): Promise<ArubaManifest> {
  const context = await loadToken(getPool(), token);
  if (!context) throw new AppError("ARUBA_HELPER_TOKEN_INVALID", 401);
  const documents = await batchDocuments(getPool(), context.id);
  verifyManifest(context, documents);
  await getPool().query(
    "UPDATE aruba_helper_tokens SET last_seen_at = now() WHERE token_hash = $1",
    [context.token_hash],
  );
  return {
    ...manifestPayload(
      context.id,
      context.environment,
      context.mode,
      context.account_reference,
      context.attempt_number,
      documents,
    ),
    manifestSha256: context.manifest_sha256,
    panelUrl: panelUrl(context.environment),
    operation: context.status === "PREPARED" ? "UPLOAD" : "READBACK",
  };
}

function safeStoragePath(relativePath: string): string {
  const root = path.resolve(getConfig().DOCUMENT_STORAGE_ROOT);
  const absolute = path.resolve(root, relativePath);
  if (!absolute.startsWith(`${root}${path.sep}`))
    throw new AppError("DOCUMENT_STORAGE_FAILED", 500);
  return absolute;
}

export async function helperDocumentXml(token: string, documentId: string): Promise<Buffer> {
  if (!isDatabaseId(documentId)) throw new AppError("ARUBA_BATCH_INVALID", 404);
  const context = await loadToken(getPool(), token);
  if (!context) throw new AppError("ARUBA_HELPER_TOKEN_INVALID", 401);
  const result = await getPool().query<{
    relative_path: string;
    sha256: string;
    size_bytes: number;
    manifest_sha256: string;
  }>(
    `SELECT storage_objects.relative_path, storage_objects.sha256, storage_objects.size_bytes,
            batch_documents.xml_sha256 AS manifest_sha256
     FROM aruba_batch_documents AS batch_documents
     JOIN documents ON documents.id = batch_documents.document_id
     JOIN storage_objects ON storage_objects.id = documents.storage_object_id
     WHERE batch_documents.batch_id = $1 AND documents.id = $2`,
    [context.id, documentId],
  );
  const row = result.rows[0];
  if (!row || row.size_bytes > ARUBA_UPLOAD_MAX_BYTES || row.sha256 !== row.manifest_sha256) {
    throw new AppError("ARUBA_BATCH_INVALID", 409);
  }
  const bytes = await readFile(safeStoragePath(row.relative_path));
  if (
    bytes.byteLength !== row.size_bytes ||
    createHash("sha256").update(bytes).digest("hex") !== row.sha256
  ) {
    throw new AppError("DOCUMENT_STORAGE_FAILED", 500);
  }
  return bytes;
}

async function exactSubmissionDocuments(client: pg.PoolClient, batchId: string, ids: string[]) {
  const expected = (
    await client.query<{ document_id: string }>(
      "SELECT document_id FROM aruba_submissions WHERE batch_id = $1 ORDER BY document_id",
      [batchId],
    )
  ).rows.map((row) => row.document_id);
  const received = [...new Set(ids)].sort((left, right) => Number(left) - Number(right));
  if (expected.length !== received.length || expected.some((id, index) => id !== received[index])) {
    throw new AppError("ARUBA_BATCH_INVALID", 409);
  }
}

const stateRank: Record<string, number> = {
  PENDING: 0,
  UPLOADED: 1,
  VALIDATED: 2,
  READY_TO_SEND: 3,
  SUBMITTED: 4,
  RECONCILED: 5,
  SDI_PROCESSING: 6,
  NOT_DELIVERED: 7,
  DELIVERED: 7,
  REJECTED: 7,
  REMOVED: 7,
};

const allowedSubmissionTransitions: Record<string, ReadonlySet<string>> = {
  PENDING: new Set([
    "VALIDATED",
    "VALIDATION_FAILED",
    "UNKNOWN",
    "REMOVED",
    "RECONCILED",
    "DELIVERED",
    "NOT_DELIVERED",
    "REJECTED",
  ]),
  VALIDATION_FAILED: new Set(["VALIDATED", "UNKNOWN", "REMOVED"]),
  VALIDATED: new Set(["READY_TO_SEND", "UNKNOWN", "REMOVED"]),
  READY_TO_SEND: new Set([
    "SUBMITTED",
    "UNKNOWN",
    "REMOVED",
    "RECONCILED",
    "DELIVERED",
    "NOT_DELIVERED",
    "REJECTED",
  ]),
  UNKNOWN: new Set([
    "UPLOADED",
    "SUBMITTED",
    "RECONCILED",
    "DELIVERED",
    "NOT_DELIVERED",
    "REJECTED",
    "REMOVED",
  ]),
  UPLOADED: new Set(["SUBMITTED", "UNKNOWN", "REMOVED"]),
  SUBMITTED: new Set(["RECONCILED", "SDI_PROCESSING", "DELIVERED", "NOT_DELIVERED", "REJECTED"]),
  RECONCILED: new Set(["SDI_PROCESSING", "DELIVERED", "NOT_DELIVERED", "REJECTED"]),
  SDI_PROCESSING: new Set(["DELIVERED", "NOT_DELIVERED", "REJECTED"]),
  DELIVERED: new Set(),
  NOT_DELIVERED: new Set(),
  REJECTED: new Set(),
  REMOVED: new Set(),
};

async function monotonicSubmission(
  client: pg.PoolClient,
  batchId: string,
  documentId: string,
  next: string,
  remoteId?: string,
) {
  const current = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM aruba_submissions
     WHERE batch_id = $1 AND document_id = $2 FOR UPDATE`,
    [batchId, documentId],
  );
  const row = current.rows[0];
  if (!row) throw new AppError("ARUBA_BATCH_INVALID", 409);
  const currentRank = stateRank[row.status] ?? 0;
  const nextRank = stateRank[next] ?? 0;
  if (next === row.status || nextRank < currentRank) return row.id;
  if (["DELIVERED", "NOT_DELIVERED", "REJECTED", "REMOVED"].includes(row.status)) return row.id;
  if (!allowedSubmissionTransitions[row.status]?.has(next)) {
    throw new AppError("ARUBA_RECONCILIATION_REQUIRED", 409);
  }
  await client.query(
    `UPDATE aruba_submissions SET status = $2::text, remote_id = coalesce($3, remote_id),
       submitted_at = CASE WHEN $2::text = 'SUBMITTED' THEN coalesce(submitted_at, now()) ELSE submitted_at END,
       last_checked_at = now(), readback_metadata_json = jsonb_build_object('status', $2::text)
     WHERE id = $1`,
    [row.id, next, remoteId ?? null],
  );
  if (customerEmailTriggerStatus(next)) {
    await client.query(
      `INSERT INTO jobs (type, payload_json)
       SELECT 'process_refund', jsonb_build_object('refundId', refunds.id::text)
       FROM refunds
       JOIN document_orders
         ON document_orders.order_id = refunds.order_id
        AND document_orders.document_kind = 'INVOICE'
       WHERE document_orders.document_id = $1
         AND refunds.status IN ('COMPLETED', 'AMBIGUOUS')
         AND refunds.credit_document_id IS NULL
       ON CONFLICT DO NOTHING`,
      [documentId],
    );
    await scheduleCustomerEmail(client, documentId);
  }
  return row.id;
}

export async function recordHelperEvent(token: string, rawEvent: unknown): Promise<void> {
  const parsed = helperEventSchema.safeParse(rawEvent);
  if (!parsed.success) throw new AppError("ARUBA_BATCH_INVALID", 422);
  const event = parsed.data;
  await withTransaction(async (client) => {
    const context = await loadToken(client, token, true);
    if (!context) throw new AppError("ARUBA_HELPER_TOKEN_INVALID", 401);
    await client.query(
      "UPDATE aruba_helper_tokens SET last_seen_at = now() WHERE token_hash = $1",
      [context.token_hash],
    );
    if (event.type === "HELPER_STARTED") {
      if (context.status === "PREPARED") {
        await client.query(
          "UPDATE aruba_batches SET status = 'HELPER_ACTIVE', updated_at = now() WHERE id = $1",
          [context.id],
        );
      }
      await client.query(
        `UPDATE aruba_submissions SET helper_version = '0.0.0', browser_name = $2
         WHERE batch_id = $1`,
        [context.id, event.browser],
      );
      return;
    }
    if (context.requires_reconciliation && event.type !== "READBACK") {
      throw new AppError("ARUBA_RECONCILIATION_REQUIRED", 409);
    }
    if (event.type === "VALIDATION") {
      if (!["HELPER_ACTIVE", "VALIDATION_FAILED"].includes(context.status)) {
        throw new AppError("ARUBA_BATCH_INVALID", 409);
      }
      await exactSubmissionDocuments(
        client,
        context.id,
        event.documents.map((item) => item.id),
      );
      const failed = event.documents.some((item) => item.status === "INVALID");
      for (const item of event.documents) {
        await client.query(
          `UPDATE aruba_submissions SET status = $3, last_checked_at = now(),
             validation_metadata_json = jsonb_build_object('status', $2::text),
             error_code = CASE WHEN $2::text = 'INVALID' THEN 'ARUBA_VALIDATION_FAILED' END,
             error_message_sanitized = $4
           WHERE batch_id = $1 AND document_id = $5`,
          [
            context.id,
            item.status,
            item.status === "VALID" ? "VALIDATED" : "VALIDATION_FAILED",
            item.message ?? null,
            item.id,
          ],
        );
      }
      await client.query(
        `UPDATE aruba_batches SET status = $2, updated_at = now()
         WHERE id = $1`,
        [context.id, failed ? "VALIDATION_FAILED" : "HELPER_ACTIVE"],
      );
      await writeAudit(client, {
        actorType: "SYSTEM",
        action: failed ? "ARUBA_VALIDATION_FAILED" : "ARUBA_UPLOAD_VALIDATED",
        eventClass: "CRITICAL",
        entityType: "ARUBA_BATCH",
        entityId: context.id,
        metadata: {
          batchId: context.id,
          manifestSha256: context.manifest_sha256,
          documentCount: context.document_count,
          arubaMode: context.mode,
        },
        requestId: `aruba-helper:${context.id}`,
      });
      return;
    }
    if (event.type === "ASSISTED_STOP") {
      if (
        context.mode !== "ASSISTED" ||
        context.requires_reconciliation ||
        context.status !== "HELPER_ACTIVE"
      ) {
        throw new AppError("ARUBA_BATCH_INVALID", 409);
      }
      const invalid = await client.query(
        "SELECT 1 FROM aruba_submissions WHERE batch_id = $1 AND status <> 'VALIDATED' LIMIT 1",
        [context.id],
      );
      if (invalid.rowCount) throw new AppError("ARUBA_VALIDATION_FAILED", 409);
      await client.query(
        "UPDATE aruba_submissions SET status = 'READY_TO_SEND' WHERE batch_id = $1",
        [context.id],
      );
      await client.query(
        "UPDATE aruba_batches SET status = 'READY_ASSISTED', updated_at = now() WHERE id = $1",
        [context.id],
      );
      await writeAudit(client, {
        actorType: "SYSTEM",
        action: "ARUBA_ASSISTED_STOPPED",
        eventClass: "CRITICAL",
        entityType: "ARUBA_BATCH",
        entityId: context.id,
        metadata: { batchId: context.id, manifestSha256: context.manifest_sha256 },
        requestId: `aruba-helper:${context.id}`,
      });
      await client.query(
        "UPDATE aruba_helper_tokens SET revoked_at = now() WHERE token_hash = $1",
        [context.token_hash],
      );
      return;
    }
    if (event.type === "RECONCILIATION_REQUIRED") {
      if (
        !["HELPER_ACTIVE", "READY_ASSISTED", "PERMIT_CONSUMED", "SUBMITTED"].includes(
          context.status,
        )
      ) {
        throw new AppError("ARUBA_BATCH_INVALID", 409);
      }
      await client.query(
        `UPDATE aruba_batches SET status = 'RECONCILIATION_REQUIRED',
           requires_reconciliation = true, updated_at = now() WHERE id = $1`,
        [context.id],
      );
      await client.query(
        `UPDATE aruba_submissions SET
           status = CASE WHEN status IN ('PENDING', 'VALIDATED', 'VALIDATION_FAILED', 'READY_TO_SEND')
             THEN 'UNKNOWN' ELSE status END,
           error_code = 'ARUBA_RECONCILIATION_REQUIRED',
           error_message_sanitized = $2, last_checked_at = now() WHERE batch_id = $1`,
        [context.id, event.reason],
      );
      await writeAudit(client, {
        actorType: "SYSTEM",
        action: "ARUBA_RECONCILIATION_REQUIRED",
        eventClass: "CRITICAL",
        entityType: "ARUBA_BATCH",
        entityId: context.id,
        metadata: { batchId: context.id, manifestSha256: context.manifest_sha256 },
        requestId: `aruba-helper:${context.id}`,
      });
      return;
    }
    if (event.type === "SUBMITTED") {
      if (context.status !== "PERMIT_CONSUMED") throw new AppError("ARUBA_PERMIT_INVALID", 409);
      await exactSubmissionDocuments(client, context.id, Object.keys(event.remoteIds));
      await Promise.all(
        Object.entries(event.remoteIds).map(([documentId, remoteId]) =>
          monotonicSubmission(client, context.id, documentId, "SUBMITTED", remoteId),
        ),
      );
      await client.query(
        "UPDATE aruba_batches SET status = 'SUBMITTED', updated_at = now() WHERE id = $1",
        [context.id],
      );
      return;
    }
    await exactSubmissionDocuments(
      client,
      context.id,
      event.documents.map((item) => item.id),
    );
    const uncertain = event.documents.some((item) => item.status === "NOT_FOUND");
    await Promise.all(
      event.documents.map((item) =>
        item.status === "NOT_FOUND"
          ? undefined
          : monotonicSubmission(client, context.id, item.id, item.status, item.remoteId),
      ),
    );
    await client.query(
      `UPDATE aruba_batches SET status = $2, requires_reconciliation = $3,
         last_readback_at = now(), updated_at = now() WHERE id = $1`,
      [context.id, uncertain ? "RECONCILIATION_REQUIRED" : "RECONCILED", uncertain],
    );
    if (!uncertain) {
      await writeAudit(client, {
        actorType: "SYSTEM",
        action: "ARUBA_READBACK_RECONCILED",
        eventClass: "CRITICAL",
        entityType: "ARUBA_BATCH",
        entityId: context.id,
        metadata: { batchId: context.id, manifestSha256: context.manifest_sha256 },
        requestId: `aruba-helper:${context.id}`,
      });
    }
    await client.query("UPDATE aruba_helper_tokens SET revoked_at = now() WHERE token_hash = $1", [
      context.token_hash,
    ]);
  });
}

export async function consumeArubaPermit(token: string, manifestDigest: unknown): Promise<void> {
  await withTransaction(async (client) => {
    const context = await loadToken(client, token, true);
    if (!context) throw new AppError("ARUBA_HELPER_TOKEN_INVALID", 401);
    if (
      context.mode !== "AUTOMATIC" ||
      context.requires_reconciliation ||
      manifestDigest !== context.manifest_sha256
    ) {
      throw new AppError("ARUBA_PERMIT_INVALID", 409);
    }
    const documents = await batchDocuments(client, context.id);
    verifyManifest(context, documents);
    const notValidated = await client.query(
      "SELECT 1 FROM aruba_submissions WHERE batch_id = $1 AND status <> 'VALIDATED' LIMIT 1",
      [context.id],
    );
    if (notValidated.rowCount) throw new AppError("ARUBA_PERMIT_INVALID", 409);
    const permit = await client.query<{ id: string }>(
      `UPDATE aruba_send_permits SET consumed_at = now()
       WHERE batch_id = $1 AND manifest_sha256 = $2 AND document_count = $3
         AND mode = 'AUTOMATIC' AND consumed_at IS NULL AND expires_at > now()
         AND (
           $4::text = 'MOCK'
           OR (scope = 'ORDINARY' AND $5::boolean)
           OR scope = 'CANARY'
         )
       RETURNING id`,
      [
        context.id,
        context.manifest_sha256,
        context.document_count,
        context.environment,
        getConfig().ARUBA_SUBMISSION_ENABLED,
      ],
    );
    if (!permit.rows[0]) throw new AppError("ARUBA_PERMIT_INVALID", 409);
    await client.query(
      "UPDATE aruba_batches SET status = 'PERMIT_CONSUMED', updated_at = now() WHERE id = $1",
      [context.id],
    );
    await client.query(
      "UPDATE aruba_submissions SET status = 'READY_TO_SEND' WHERE batch_id = $1",
      [context.id],
    );
    await writeAudit(client, {
      actorType: "SYSTEM",
      action: "ARUBA_SEND_PERMIT_CONSUMED",
      eventClass: "CRITICAL",
      entityType: "ARUBA_BATCH",
      entityId: context.id,
      metadata: {
        batchId: context.id,
        manifestSha256: context.manifest_sha256,
        documentCount: context.document_count,
        arubaMode: context.mode,
      },
      requestId: `aruba-helper:${context.id}`,
    });
  });
}

export async function listArubaBatches() {
  const result = await getPool().query<{
    id: string;
    environment: string;
    mode: ArubaMode;
    status: string;
    document_count: number;
    created_at: string;
    last_readback_at: string | null;
    manifest_sha256: string;
    permit_consumed_at: string | null;
    can_retry: boolean;
  }>(
    `SELECT batches.id, batches.environment, batches.mode, batches.status,
            batches.document_count, batches.created_at, batches.last_readback_at,
            batches.manifest_sha256, permits.consumed_at AS permit_consumed_at,
            batches.status = 'RECONCILED' AND NOT EXISTS (
              SELECT 1 FROM aruba_submissions
              WHERE aruba_submissions.batch_id = batches.id
                AND aruba_submissions.status <> 'REMOVED'
            ) AS can_retry
     FROM aruba_batches AS batches
     LEFT JOIN aruba_send_permits AS permits ON permits.batch_id = batches.id
     ORDER BY batches.created_at DESC LIMIT 100`,
  );
  return result.rows;
}

export async function authorizeArubaPermit(batchId: string, actor: ArubaActor) {
  if (!actor.canApprove) throw new AppError("ARUBA_PERMIT_FORBIDDEN", 403);
  return withTransaction(async (client) => {
    const batch = await client.query<BatchIdentity>(
      "SELECT * FROM aruba_batches WHERE id = $1 FOR UPDATE",
      [batchId],
    );
    const current = batch.rows[0];
    if (
      !current ||
      current.mode !== "AUTOMATIC" ||
      (current.environment === "PRODUCTION" && !getConfig().ARUBA_SUBMISSION_ENABLED) ||
      current.requires_reconciliation ||
      !["PREPARED", "HELPER_ACTIVE", "VALIDATION_FAILED"].includes(current.status)
    ) {
      throw new AppError("ARUBA_PERMIT_INVALID", 409);
    }
    const documents = await batchDocuments(client, batchId);
    verifyManifest(current, documents);
    const permit = await client.query<{ consumed_at: string | null }>(
      "SELECT consumed_at FROM aruba_send_permits WHERE batch_id = $1 FOR UPDATE",
      [batchId],
    );
    if (permit.rows[0]?.consumed_at) throw new AppError("ARUBA_PERMIT_INVALID", 409);
    const expiresAt = new Date(Date.now() + SEND_PERMIT_TTL_MS);
    await client.query(
      `INSERT INTO aruba_send_permits
        (id, batch_id, manifest_sha256, document_count, mode, authorized_by, expires_at)
       VALUES ($1, $2, $3, $4, 'AUTOMATIC', $5, $6)
       ON CONFLICT (batch_id) DO UPDATE SET id = EXCLUDED.id,
         manifest_sha256 = EXCLUDED.manifest_sha256,
         document_count = EXCLUDED.document_count,
         mode = EXCLUDED.mode,
         scope = 'ORDINARY',
         authorized_by = EXCLUDED.authorized_by, authorized_at = now(),
         expires_at = EXCLUDED.expires_at`,
      [randomUUID(), batchId, current.manifest_sha256, current.document_count, actor.id, expiresAt],
    );
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "ARUBA_SEND_PERMIT_CREATED",
      eventClass: "CRITICAL",
      entityType: "ARUBA_BATCH",
      entityId: batchId,
      metadata: {
        batchId,
        manifestSha256: current.manifest_sha256,
        documentCount: current.document_count,
        arubaMode: current.mode,
      },
      requestId: actor.requestId,
    });
    return expiresAt.toISOString();
  });
}

export async function retryArubaBatch(batchId: string, actor: ArubaActor) {
  if (!actor.canApprove) throw new AppError("ARUBA_PERMIT_FORBIDDEN", 403);
  return withTransaction(async (client) => {
    const batch = await client.query<BatchIdentity>(
      "SELECT * FROM aruba_batches WHERE id = $1 FOR UPDATE",
      [batchId],
    );
    const current = batch.rows[0];
    if (!current || current.status !== "RECONCILED" || current.requires_reconciliation) {
      throw new AppError("ARUBA_RECONCILIATION_REQUIRED", 409);
    }
    const unsafe = await client.query(
      `SELECT 1 FROM aruba_submissions
       WHERE batch_id = $1 AND status <> 'REMOVED' LIMIT 1`,
      [batchId],
    );
    if (unsafe.rowCount) throw new AppError("ARUBA_RECONCILIATION_REQUIRED", 409);
    const retryBatchId = await createArubaBatch(
      client,
      await batchDocuments(client, batchId),
      actor,
      undefined,
      current.attempt_number + 1,
      current.mode,
    );
    await client.query(
      "UPDATE aruba_batches SET status = 'CANCELLED', updated_at = now() WHERE id = $1",
      [batchId],
    );
    return retryBatchId;
  });
}

export async function listUnbatchedApprovedDocuments() {
  const result = await getPool().query<{
    id: string;
    fiscal_label: string;
    customer_name: string;
    total_amount: number;
  }>(
    `SELECT documents.id,
            documents.series || ' ' || lpad(documents.fiscal_number::text, 4, '0') || '/' ||
              right(documents.fiscal_year::text, 2) AS fiscal_label,
            billing_cases.customer_snapshot_json ->> 'displayName' AS customer_name,
            documents.total_amount
     FROM documents
     JOIN billing_cases ON billing_cases.id = documents.billing_case_id
     WHERE documents.status = 'APPROVED'
       AND NOT EXISTS (
         SELECT 1 FROM aruba_batch_documents
         WHERE aruba_batch_documents.document_id = documents.id
       )
     ORDER BY documents.id`,
  );
  return result.rows;
}

async function storeImportedFile(documentId: string, kind: ArubaFileKind, bytes: Buffer) {
  const extension = {
    ARUBA_XML: "xml",
    ARUBA_P7M: "p7m",
    ARUBA_PDF: "pdf",
    SDI_NOTIFICATION: "xml",
  }[kind];
  const relativePath = path.posix.join("aruba", documentId, `${randomUUID()}.${extension}`);
  const absolutePath = safeStoragePath(relativePath);
  const temporaryPath = `${absolutePath}.tmp`;
  await mkdir(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, absolutePath);
  return { relativePath, absolutePath, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export async function importOfficialArubaFile(
  documentId: string,
  rawKind: unknown,
  bytes: Buffer,
  actor: ArubaActor,
) {
  if (!actor.canApprove) throw new AppError("ARUBA_PERMIT_FORBIDDEN", 403);
  return importOfficialFile(documentId, rawKind, bytes, {
    actorType: "ADMIN",
    actorId: String(actor.id),
    requestId: actor.requestId,
  });
}

export async function importOfficialArubaFileFromHelper(
  token: string,
  documentId: string,
  rawKind: unknown,
  bytes: Buffer,
) {
  const context = await loadToken(getPool(), token);
  if (!context) throw new AppError("ARUBA_HELPER_TOKEN_INVALID", 401);
  return importOfficialFile(documentId, rawKind, bytes, {
    actorType: "SYSTEM",
    requestId: `aruba-helper:${context.id}`,
    batchId: context.id,
  });
}

async function importOfficialFile(
  documentId: string,
  rawKind: unknown,
  bytes: Buffer,
  source: {
    actorType: "ADMIN" | "SYSTEM";
    actorId?: string;
    requestId: string;
    batchId?: string;
  },
) {
  const kind = arubaFileKindSchema.safeParse(rawKind);
  if (!kind.success || !isDatabaseId(documentId) || bytes.byteLength > ARUBA_IMPORT_MAX_BYTES) {
    throw new AppError("ARUBA_IMPORT_INVALID", 422);
  }
  try {
    validateOfficialFile(kind.data, bytes);
  } catch {
    throw new AppError("ARUBA_IMPORT_INVALID", 422);
  }
  const document = await getPool().query<{
    xml_sha256: string;
    submission_id: string;
    batch_id: string;
    remote_id: string | null;
    filename: string;
  }>(
    `SELECT documents.xml_sha256, submissions.id AS submission_id, submissions.batch_id,
            submissions.remote_id, batch_documents.filename
     FROM documents
     JOIN aruba_submissions AS submissions ON submissions.document_id = documents.id
     JOIN aruba_batch_documents AS batch_documents
       ON batch_documents.batch_id = submissions.batch_id
      AND batch_documents.document_id = documents.id
     WHERE documents.id = $1 AND documents.status = 'APPROVED'
       AND ($2::uuid IS NULL OR submissions.batch_id = $2)
     ORDER BY submissions.attempt_number DESC LIMIT 1`,
    [documentId, source.batchId ?? null],
  );
  const current = document.rows[0];
  if (!current) throw new AppError("ARUBA_IMPORT_INVALID", 409);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (kind.data === "ARUBA_XML" && digest !== current.xml_sha256) {
    throw new AppError("ARUBA_IMPORT_INVALID", 409);
  }
  if (kind.data === "SDI_NOTIFICATION") {
    const xml = bytes.toString("utf8");
    const filenames = [...xml.matchAll(/<(?:\w+:)?NomeFile>([^<]{1,255})<\//gi)].map((match) =>
      path.posix
        .basename(match[1]!.trim())
        .replace(/\.p7m$/i, "")
        .toLowerCase(),
    );
    const remoteIds = [
      ...xml.matchAll(/<(?:\w+:)?(?:IdentificativoSdI|IdSdI)>([^<]{1,200})<\//gi),
    ].map((match) => match[1]!.trim());
    const filenameMatches = filenames.includes(current.filename.toLowerCase());
    const remoteIdMatches = Boolean(current.remote_id && remoteIds.includes(current.remote_id));
    if (
      (!filenameMatches && !remoteIdMatches) ||
      (filenames.length > 0 && !filenameMatches) ||
      (current.remote_id && remoteIds.length > 0 && !remoteIdMatches)
    ) {
      throw new AppError("ARUBA_IMPORT_INVALID", 409);
    }
  }
  const stored = await storeImportedFile(documentId, kind.data, bytes);
  try {
    return await withTransaction(async (client) => {
      const contentType =
        kind.data === "ARUBA_PDF"
          ? "application/pdf"
          : kind.data === "ARUBA_P7M"
            ? "application/pkcs7-mime"
            : "application/xml";
      const storage = await client.query<{ id: string }>(
        `INSERT INTO storage_objects (kind, relative_path, sha256, size_bytes, content_type)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [kind.data, stored.relativePath, stored.sha256, bytes.byteLength, contentType],
      );
      const file = await client.query<{ id: string }>(
        `INSERT INTO aruba_files
          (document_id, submission_id, storage_object_id, kind, metadata_json)
         VALUES ($1, $2, $3, $4, jsonb_build_object('sha256', $5::text)) RETURNING id`,
        [documentId, current.submission_id, storage.rows[0]!.id, kind.data, stored.sha256],
      );
      if (kind.data === "SDI_NOTIFICATION") {
        const status = notificationStatus(bytes.toString("utf8"));
        const remoteNotificationId =
          /<(?:\w+:)?(?:IdentificativoSdI|IdSdI)>([^<]{1,200})<\//i
            .exec(bytes.toString("utf8"))?.[1]
            ?.trim() ?? null;
        await client.query(
          `INSERT INTO sdi_notifications
            (submission_id, remote_notification_id, type, status, storage_object_id, metadata_json)
           VALUES ($1, $2, $3, $3, $4, '{}')
           ON CONFLICT (submission_id, remote_notification_id) DO NOTHING`,
          [current.submission_id, remoteNotificationId, status, storage.rows[0]!.id],
        );
        await monotonicSubmission(client, current.batch_id, documentId, status);
        if (["DELIVERED", "NOT_DELIVERED", "REJECTED"].includes(status)) {
          const unresolved = await client.query(
            `SELECT 1 FROM aruba_submissions
             WHERE batch_id = $1
               AND status NOT IN ('DELIVERED', 'NOT_DELIVERED', 'REJECTED')
             LIMIT 1`,
            [current.batch_id],
          );
          const requiresReconciliation = Boolean(unresolved.rowCount);
          await client.query(
            `UPDATE aruba_batches
             SET status = CASE
                   WHEN $2::boolean THEN 'RECONCILIATION_REQUIRED'
                   ELSE 'RECONCILED'
                 END,
                 requires_reconciliation = $2,
                 last_readback_at = now(),
                 updated_at = now()
             WHERE id = $1`,
            [current.batch_id, requiresReconciliation],
          );
          await client.query(
            `UPDATE aruba_helper_tokens
             SET revoked_at = coalesce(revoked_at, now())
             WHERE batch_id = $1`,
            [current.batch_id],
          );
        }
      }
      if (kind.data === "ARUBA_PDF") await scheduleCustomerEmail(client, documentId);
      await writeAudit(client, {
        actorType: source.actorType,
        actorId: source.actorId,
        action: "ARUBA_FILE_IMPORTED",
        eventClass: "CRITICAL",
        entityType: "DOCUMENT",
        entityId: documentId,
        metadata: { fileKind: kind.data },
        requestId: source.requestId,
      });
      return file.rows[0]!.id;
    });
  } catch (error) {
    await unlink(stored.absolutePath).catch(() => undefined);
    throw error;
  }
}

export async function listOfficialArubaFiles() {
  const result = await getPool().query<{
    id: string;
    document_id: string;
    kind: ArubaFileKind;
    size_bytes: number;
    imported_at: string;
  }>(
    `SELECT files.id, files.document_id, files.kind, storage.size_bytes, files.imported_at
     FROM aruba_files AS files
     JOIN storage_objects AS storage ON storage.id = files.storage_object_id
     ORDER BY files.imported_at DESC, files.id DESC`,
  );
  return result.rows;
}

export async function readOfficialArubaFile(documentId: string, fileId: string) {
  if (!isDatabaseId(documentId) || !isDatabaseId(fileId)) {
    throw new AppError("ARUBA_IMPORT_INVALID", 404);
  }
  const result = await getPool().query<{
    relative_path: string;
    sha256: string;
    size_bytes: number;
    content_type: string;
    kind: ArubaFileKind;
  }>(
    `SELECT storage.relative_path, storage.sha256, storage.size_bytes, storage.content_type,
            files.kind
     FROM aruba_files AS files
     JOIN storage_objects AS storage ON storage.id = files.storage_object_id
     WHERE files.id = $1 AND files.document_id = $2`,
    [fileId, documentId],
  );
  const current = result.rows[0];
  if (!current) throw new AppError("ARUBA_IMPORT_INVALID", 404);
  const bytes = await readFile(safeStoragePath(current.relative_path));
  if (
    bytes.byteLength !== current.size_bytes ||
    createHash("sha256").update(bytes).digest("hex") !== current.sha256
  ) {
    throw new AppError("DOCUMENT_STORAGE_FAILED", 500);
  }
  return { ...current, bytes };
}
