import type pg from "pg";

import {
  arubaModeSchema,
  manifestSha256,
  type ArubaManifestDocument,
  type ArubaMode,
} from "../aruba.ts";
import { AppError } from "../errors.ts";

export interface ArubaOutboundActor {
  id: number;
  canApprove: boolean;
  requestId: string;
}

export async function currentArubaMode(client: pg.PoolClient): Promise<ArubaMode> {
  const result = await client.query<{ value_json: unknown }>(
    "SELECT value_json FROM settings WHERE key = 'aruba_mode' FOR UPDATE",
  );
  return arubaModeSchema.parse(result.rows[0]?.value_json ?? "DOCUMENT_ONLY");
}

export async function arubaOutboundConnectionReady(
  client: pg.PoolClient,
  environment: "MOCK" | "PRODUCTION",
  accountReference: string,
) {
  const result = await client.query(
    `SELECT 1 FROM connections
     WHERE provider = 'ARUBA'
       AND environment = CASE WHEN $1 = 'PRODUCTION' THEN 'PRODUCTION' ELSE 'DEVELOPMENT' END
       AND account_reference = $2 AND status = 'CONNECTED'
       AND encrypted_credentials IS NOT NULL AND credentials_verified_at IS NOT NULL
       AND NOT api_paused`,
    [environment, accountReference],
  );
  return Boolean(result.rows[0]);
}

export function arubaApiManifestPayload(
  batchId: string,
  environment: "MOCK" | "PRODUCTION",
  mode: ArubaMode,
  accountReference: string,
  documents: ArubaManifestDocument[],
) {
  return {
    batchId,
    environment,
    mode,
    accountReference,
    attemptNumber: 1,
    documents,
  };
}

interface BatchInvariant {
  id: string;
  environment: "MOCK" | "PRODUCTION";
  mode: ArubaMode;
  account_reference: string;
  manifest_sha256: string;
  document_count: number;
  attempt_number: number;
}

export async function assertArubaBatchManifestCurrent(client: pg.PoolClient, batchId: string) {
  const batch = await client.query<BatchInvariant & { created_by_can_approve: boolean }>(
    `SELECT batches.id, batches.environment, batches.mode, batches.account_reference,
            batches.manifest_sha256, batches.document_count, batches.attempt_number,
            users.can_approve AS created_by_can_approve
     FROM aruba_batches AS batches
     JOIN users ON users.id = batches.created_by
     WHERE batches.id = $1`,
    [batchId],
  );
  const current = batch.rows[0];
  if (!current || !current.created_by_can_approve || current.attempt_number !== 1) {
    throw new AppError("ARUBA_BATCH_INVALID", 409);
  }
  const rows = await client.query<{
    id: string;
    revision: number;
    sha256: string;
    filename: string;
    size_bytes: number;
    fiscal_number: string;
    document_date: string;
    total_amount: number;
    status: string;
    submission_environment: string;
    submission_mode: string;
    submission_manifest_sha256: string;
    submission_xml_sha256: string;
    submission_source_filename: string | null;
  }>(
    `SELECT documents.id, batch_documents.document_revision AS revision,
            batch_documents.xml_sha256 AS sha256, batch_documents.filename,
            storage.size_bytes,
            documents.series || ' ' || lpad(documents.fiscal_number::text, 4, '0') || '/' ||
              right(documents.fiscal_year::text, 2) AS fiscal_number,
            documents.document_date::text, documents.total_amount, documents.status,
            submissions.environment AS submission_environment,
            submissions.mode AS submission_mode,
            submissions.manifest_sha256 AS submission_manifest_sha256,
            submissions.xml_sha256 AS submission_xml_sha256,
            submissions.source_filename AS submission_source_filename
     FROM aruba_batch_documents AS batch_documents
     JOIN documents ON documents.id = batch_documents.document_id
     JOIN storage_objects AS storage ON storage.id = documents.storage_object_id
     JOIN aruba_submissions AS submissions
       ON submissions.batch_id = batch_documents.batch_id
      AND submissions.document_id = batch_documents.document_id
      AND submissions.attempt_number = $2
     WHERE batch_documents.batch_id = $1
     ORDER BY batch_documents.position`,
    [batchId, current.attempt_number],
  );
  if (
    rows.rows.length !== current.document_count ||
    rows.rows.some(
      (row) =>
        row.status !== "APPROVED" ||
        row.submission_environment !== current.environment ||
        row.submission_mode !== current.mode ||
        row.submission_manifest_sha256 !== current.manifest_sha256 ||
        row.submission_xml_sha256 !== row.sha256 ||
        row.submission_source_filename !== row.filename,
    )
  ) {
    throw new AppError("ARUBA_BATCH_INVALID", 409);
  }
  const documents: ArubaManifestDocument[] = rows.rows.map((row) => ({
    id: row.id,
    revision: row.revision,
    sha256: row.sha256,
    filename: row.filename,
    sizeBytes: row.size_bytes,
    fiscalNumber: row.fiscal_number,
    documentDate: row.document_date,
    totalAmount: row.total_amount,
  }));
  const digest = manifestSha256(
    arubaApiManifestPayload(
      current.id,
      current.environment,
      current.mode,
      current.account_reference,
      documents,
    ),
  );
  if (digest !== current.manifest_sha256) throw new AppError("ARUBA_BATCH_INVALID", 409);
}

export async function enqueueArubaReadback(
  client: pg.PoolClient,
  submissionId: string,
  delay: "INITIAL" | "RETRY" = "INITIAL",
) {
  await client.query(
    `INSERT INTO jobs (type, payload_json, max_attempts, run_at, priority)
     VALUES ('aruba_readback_submission', jsonb_build_object(
       'readbackKind', 'submission', 'submissionId', $1::text), 1,
       now() + CASE WHEN $2 = 'INITIAL' THEN interval '2 minutes' ELSE interval '15 minutes' END,
       CASE WHEN $2 = 'INITIAL' THEN 20 ELSE 30 END)
     ON CONFLICT DO NOTHING`,
    [submissionId, delay],
  );
}

export async function refreshArubaApiBatchStatus(client: pg.PoolClient, batchId: string) {
  const summary = await client.query<{
    pending: string;
    sendPending: string;
    sendFailed: string;
    accepted: string;
    failed: string;
    unknown: string;
  }>(
    `SELECT count(*) FILTER (WHERE status = 'DRY_RUN_PENDING')::text AS pending,
            count(*) FILTER (WHERE status = 'SEND_PENDING')::text AS "sendPending",
            count(*) FILTER (WHERE status = 'SEND_FAILED')::text AS "sendFailed",
            count(*) FILTER (WHERE status IN ('ARUBA_ACCEPTED', 'SDI_PROCESSING', 'SUBMITTED',
              'DELIVERED', 'NOT_DELIVERED', 'REJECTED'))::text AS accepted,
            count(*) FILTER (WHERE status = 'DRY_RUN_FAILED')::text AS failed,
            count(*) FILTER (WHERE status = 'UNKNOWN_REMOTE_STATE')::text AS unknown
     FROM aruba_submissions WHERE batch_id = $1`,
    [batchId],
  );
  const counts = summary.rows[0]!;
  if (Number(counts.unknown) > 0) {
    await client.query(
      `UPDATE aruba_batches SET status = 'UNKNOWN_REMOTE_STATE',
         requires_reconciliation = true, updated_at = now() WHERE id = $1`,
      [batchId],
    );
    return;
  }
  if (Number(counts.pending) > 0) return;
  if (Number(counts.sendPending) > 0) {
    await client.query(
      "UPDATE aruba_batches SET status = 'SEND_PENDING', updated_at = now() WHERE id = $1",
      [batchId],
    );
    return;
  }
  await client.query(
    `UPDATE aruba_batches SET status = $2, requires_reconciliation = false, updated_at = now()
     WHERE id = $1`,
    [
      batchId,
      Number(counts.failed) > 0
        ? "DRY_RUN_FAILED"
        : Number(counts.sendFailed) > 0
          ? "SEND_FAILED"
          : Number(counts.accepted) > 0
            ? "ARUBA_ACCEPTED"
            : "DRY_RUN_VALIDATED",
    ],
  );
}
