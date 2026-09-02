import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import type pg from "pg";

import {
  ARUBA_IMPORT_MAX_BYTES,
  arubaFileKindSchema,
  arubaModeSchema,
  effectiveArubaMode,
  notificationBelongsToDocument,
  notificationStatus,
  validateOfficialFile,
  type ArubaFileKind,
  type ArubaMode,
} from "../aruba.ts";
import { getConfig } from "../config.server.ts";
import { AppError } from "../errors.ts";
import { POSTGRES_INTEGER_MAX } from "../orders.ts";
import { writeAudit } from "./audit.server.ts";
import { customerEmailTriggerStatus, scheduleCustomerEmail } from "./email.server.ts";
import { getPool, registerJoinedTransactionFile, withTransaction } from "./client.server.ts";
import { createArubaApiBatch } from "./aruba-api-outbound.server.ts";
import { isDatabaseId } from "./database-id.ts";

export interface ArubaActor {
  id: number;
  canApprove: boolean;
  requestId: string;
}

function integer(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > POSTGRES_INTEGER_MAX) {
    throw new AppError("CONFLICT_REVISION", 409);
  }
  return parsed;
}

export async function getArubaSettings() {
  const config = getConfig();
  const result = await getPool().query<{ key: string; value_json: unknown; version: number }>(
    "SELECT key, value_json, version FROM settings WHERE key = 'aruba_mode'",
  );
  const settings = new Map(result.rows.map((row) => [row.key, row]));
  const mode = arubaModeSchema.parse(settings.get("aruba_mode")?.value_json ?? "DOCUMENT_ONLY");
  return {
    mode: {
      value: mode,
      version: settings.get("aruba_mode")?.version ?? 0,
    },
    effectiveMode: effectiveArubaMode(mode, config.ARUBA_SUBMISSION_ENABLED),
    transmissionForcedDocumentOnly: !config.ARUBA_SUBMISSION_ENABLED,
  };
}

export async function setArubaSettings(
  raw: { mode: unknown; modeVersion: unknown },
  actor: ArubaActor,
) {
  if (!actor.canApprove) throw new AppError("ARUBA_OPERATION_FORBIDDEN", 403);
  const mode = arubaModeSchema.safeParse(raw.mode);
  const modeVersion = integer(raw.modeVersion);
  if (!mode.success) throw new AppError("ARUBA_BATCH_INVALID", 422);
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('settings:aruba'))");
    const current = await client.query<{ key: string; version: number }>(
      "SELECT key, version FROM settings WHERE key = 'aruba_mode' FOR UPDATE",
    );
    const versions = new Map(current.rows.map((row) => [row.key, row.version]));
    if (versions.get("aruba_mode") !== modeVersion) {
      throw new AppError("CONFLICT_REVISION", 409);
    }
    await client.query(
      `UPDATE settings SET value_json = $2, version = version + 1, updated_at = now()
       WHERE key = $1`,
      ["aruba_mode", JSON.stringify(mode.data)],
    );
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "ARUBA_SETTINGS_CHANGED",
      eventClass: "CRITICAL",
      entityType: "SETTING",
      entityId: "aruba",
      after: { mode: mode.data },
      requestId: actor.requestId,
    });
  });
}

export async function createBatchForDocuments(
  documentIds: string[],
  actor: ArubaActor,
  confirmDocumentOnlyDowngrade = false,
) {
  if (!actor.canApprove) throw new AppError("ARUBA_OPERATION_FORBIDDEN", 403);
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
         AND documents.origin = 'HUB'
         AND aruba_batch_documents.document_id IS NULL
       FOR UPDATE OF documents`,
      [ids],
    );
    if (rows.rows.length !== ids.length) throw new AppError("ARUBA_BATCH_INVALID", 409);
    return createArubaApiBatch(
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
      confirmDocumentOnlyDowngrade,
    );
  });
}

function safeStoragePath(relativePath: string): string {
  const root = path.resolve(getConfig().DOCUMENT_STORAGE_ROOT);
  const absolute = path.resolve(root, relativePath);
  if (!absolute.startsWith(`${root}${path.sep}`))
    throw new AppError("DOCUMENT_STORAGE_FAILED", 500);
  return absolute;
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
         AND NOT refunds.applied_before_issue
         AND refunds.credit_document_id IS NULL
       ON CONFLICT DO NOTHING`,
      [documentId],
    );
    await scheduleCustomerEmail(client, documentId);
  }
  return row.id;
}

export async function listArubaBatches() {
  const result = await getPool().query<{
    id: string;
    environment: string;
    mode: ArubaMode;
    transport: "API" | "HELPER" | "MANUAL";
    status: string;
    document_count: number;
    created_at: string;
    last_readback_at: string | null;
    manifest_sha256: string;
    can_retry: boolean;
    qualification_status: string | null;
    can_authorize_dry_run: boolean;
    can_authorize_canary: boolean;
    canary_consumed: boolean;
    documents: Array<{
      id: string;
      fiscal_label: string;
      status: string;
      error_code: string | null;
      error_message: string | null;
    }>;
  }>(
    `SELECT batches.id, batches.environment, batches.mode, batches.transport, batches.status,
            batches.document_count, batches.created_at, batches.last_readback_at,
            batches.manifest_sha256,
            batches.status = 'RECONCILED' AND NOT EXISTS (
              SELECT 1 FROM aruba_submissions
              WHERE aruba_submissions.batch_id = batches.id
                AND aruba_submissions.status <> 'REMOVED'
            ) AS can_retry,
            (SELECT qualifications.status FROM aruba_dry_run_qualifications AS qualifications
             WHERE qualifications.batch_id = batches.id) AS qualification_status,
            batches.environment = 'PRODUCTION' AND batches.transport = 'API'
              AND batches.mode = 'DOCUMENT_ONLY' AND batches.status = 'DOCUMENT_ONLY'
              AND batches.document_count = 1 AND NOT EXISTS (
                SELECT 1 FROM aruba_dry_run_qualifications AS qualifications
                WHERE qualifications.batch_id = batches.id
              ) AS can_authorize_dry_run,
            batches.environment = 'PRODUCTION' AND batches.transport = 'API'
              AND batches.mode = 'DOCUMENT_ONLY' AND batches.status = 'DRY_RUN_VALIDATED'
              AND batches.document_count = 1
              AND bool_and(documents.document_type = 'TD01')
              AND bool_and(submissions.status = 'DRY_RUN_VALIDATED')
              AND EXISTS (
                SELECT 1 FROM aruba_dry_run_qualifications AS qualifications
                WHERE qualifications.batch_id = batches.id
                  AND qualifications.status = 'SUCCEEDED'
              )
              AND NOT EXISTS (
                SELECT 1 FROM aruba_canary_permits AS permits
                WHERE permits.consumed_at IS NOT NULL
                   OR (permits.consumed_at IS NULL AND permits.expired_at IS NULL
                     AND permits.expires_at > now())
              ) AS can_authorize_canary,
            EXISTS (
              SELECT 1 FROM aruba_canary_permits AS permits
              WHERE permits.batch_id = batches.id AND permits.consumed_at IS NOT NULL
            ) AS canary_consumed,
            coalesce(jsonb_agg(jsonb_build_object(
              'id', documents.id,
              'fiscal_label', documents.series || ' ' ||
                lpad(documents.fiscal_number::text, 4, '0') || '/' ||
                right(documents.fiscal_year::text, 2),
              'status', submissions.status,
              'error_code', submissions.error_code,
              'error_message', submissions.error_message_sanitized
            ) ORDER BY batch_documents.position), '[]'::jsonb) AS documents
     FROM aruba_batches AS batches
     JOIN aruba_batch_documents AS batch_documents ON batch_documents.batch_id = batches.id
     JOIN documents ON documents.id = batch_documents.document_id
     JOIN aruba_submissions AS submissions
       ON submissions.batch_id = batches.id
      AND submissions.document_id = batch_documents.document_id
      AND submissions.attempt_number = batches.attempt_number
     GROUP BY batches.id
     ORDER BY batches.created_at DESC LIMIT 100`,
  );
  return result.rows;
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
       AND documents.origin = 'HUB'
       AND NOT EXISTS (
         SELECT 1 FROM aruba_batch_documents
         WHERE aruba_batch_documents.document_id = documents.id
       )
     ORDER BY documents.id`,
  );
  return result.rows;
}

export async function storeImportedFile(documentId: string, kind: ArubaFileKind, bytes: Buffer) {
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
  registerJoinedTransactionFile(absolutePath);
  return { relativePath, absolutePath, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export async function importOfficialArubaFile(
  documentId: string,
  rawKind: unknown,
  bytes: Buffer,
  actor: ArubaActor,
) {
  if (!actor.canApprove) throw new AppError("ARUBA_OPERATION_FORBIDDEN", 403);
  return importOfficialFile(documentId, rawKind, bytes, {
    actorType: "ADMIN",
    actorId: String(actor.id),
    requestId: actor.requestId,
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
    if (
      !notificationBelongsToDocument(xml, {
        filename: current.filename,
        remoteId: current.remote_id,
      })
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

export async function listOfficialArubaFiles(documentIds: string[]) {
  if (!documentIds.length) return [];
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
     WHERE files.document_id = ANY($1::bigint[])
     ORDER BY files.imported_at DESC, files.id DESC`,
    [documentIds],
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
