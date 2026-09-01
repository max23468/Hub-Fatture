import type pg from "pg";

import { getPool } from "./client.server.ts";

export interface ReleaseCandidateReadinessState {
  unsafeApprovedDocuments: number;
  completedDryRunQualifications: number;
  unreconciledHistory: number;
  pendingHistoryImports: number;
  openArubaBatches: number;
}

const terminalQualificationSql = `
  SELECT batches.id AS batch_id, batch_documents.document_id
  FROM aruba_batches AS batches
  JOIN aruba_batch_documents AS batch_documents ON batch_documents.batch_id = batches.id
  JOIN documents ON documents.id = batch_documents.document_id
  JOIN aruba_submissions AS submissions
    ON submissions.batch_id = batches.id
   AND submissions.document_id = batch_documents.document_id
   AND submissions.attempt_number = batches.attempt_number
  JOIN aruba_dry_run_qualifications AS qualifications
    ON qualifications.batch_id = batches.id
  JOIN aruba_submission_attempts AS attempts
    ON attempts.submission_id = submissions.id
   AND attempts.operation = 'DRY_RUN'
   AND attempts.attempt_number = batches.attempt_number
  WHERE documents.status = 'APPROVED'
    AND documents.origin = 'HUB'
    AND batches.environment = 'PRODUCTION'
    AND batches.mode = 'DOCUMENT_ONLY'
    AND batches.transport = 'API'
    AND batches.document_count = 1
    AND batches.attempt_number = 1
    AND batches.status = 'DRY_RUN_VALIDATED'
    AND batches.requires_reconciliation = false
    AND submissions.environment = batches.environment
    AND submissions.mode = batches.mode
    AND submissions.transport = batches.transport
    AND submissions.manifest_sha256 = batches.manifest_sha256
    AND submissions.xml_sha256 = batch_documents.xml_sha256
    AND submissions.status = 'DRY_RUN_VALIDATED'
    AND submissions.remote_id IS NULL
    AND submissions.submitted_at IS NULL
    AND submissions.error_code IS NULL
    AND batch_documents.document_revision = documents.draft_version
    AND batch_documents.xml_sha256 = documents.xml_sha256
    AND qualifications.environment = batches.environment
    AND qualifications.account_reference = batches.account_reference
    AND qualifications.manifest_sha256 = batches.manifest_sha256
    AND qualifications.endpoint = '/services/invoice/upload'
    AND qualifications.request_limit = 1
    AND qualifications.status = 'SUCCEEDED'
    AND qualifications.consumed_at IS NOT NULL
    AND qualifications.completed_at IS NOT NULL
    AND attempts.xml_sha256 = submissions.xml_sha256
    AND attempts.status = 'SUCCEEDED'
    AND attempts.error_code IS NULL
    AND attempts.completed_at IS NOT NULL
    AND (SELECT count(*) FROM aruba_batch_documents AS manifest_documents
         WHERE manifest_documents.batch_id = batches.id) = 1
    AND (SELECT count(*) FROM aruba_submissions AS batch_submissions
         WHERE batch_submissions.batch_id = batches.id) = 1
    AND NOT EXISTS (
      SELECT 1 FROM aruba_files WHERE aruba_files.submission_id = submissions.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM sdi_notifications WHERE sdi_notifications.submission_id = submissions.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM jobs
      WHERE jobs.type = 'aruba_dry_run_submission'
        AND jobs.payload_json ->> 'submissionId' = submissions.id::text
        AND jobs.status <> 'COMPLETED'
    )`;

export async function releaseCandidateReadinessState(
  client: pg.Pool | pg.PoolClient = getPool(),
): Promise<ReleaseCandidateReadinessState> {
  const result = await client.query<{
    unsafe_approved_documents: string;
    completed_dry_run_qualifications: string;
    unreconciled_history: string;
    pending_history_imports: string;
    open_aruba_batches: string;
  }>(
    `WITH terminal_qualifications AS (${terminalQualificationSql})
     SELECT
       (SELECT count(*) FROM documents
        WHERE documents.status = 'APPROVED' AND documents.origin = 'HUB'
          AND NOT EXISTS (
            SELECT 1 FROM terminal_qualifications
            WHERE terminal_qualifications.document_id = documents.id
          ))::text AS unsafe_approved_documents,
       (SELECT count(*) FROM terminal_qualifications)::text
         AS completed_dry_run_qualifications,
       (SELECT count(*) FROM orders
        WHERE coalesce((normalized_snapshot_json ->> 'historical')::boolean, false)
          AND ((historical_reconciliation_outcome IS NULL
              AND (trigger_status <> 'LEGACY_BILLING_REVIEW'
                OR historical_reconciled_at IS NOT NULL
                OR billing_case_id IS NOT NULL
                OR EXISTS (
                  SELECT 1 FROM document_orders
                  WHERE document_orders.order_id = orders.id)))
            OR (historical_reconciliation_outcome = 'ALREADY_INVOICED'
              AND NOT EXISTS (
                SELECT 1 FROM document_orders
                JOIN documents ON documents.id = document_orders.document_id
                WHERE document_orders.order_id = orders.id
                  AND documents.origin = 'ARUBA_HISTORY'))))::text
         AS unreconciled_history,
       (SELECT count(*) FROM (VALUES ('SHOPIFY'), ('EBAY')) AS expected(provider)
        WHERE NOT EXISTS (
          SELECT 1 FROM connections
          WHERE connections.provider = expected.provider
            AND connections.environment = 'PRODUCTION'
            AND connections.status = 'CONNECTED'
            AND EXISTS (
              SELECT 1 FROM sync_cursors
              WHERE sync_cursors.provider = connections.provider
                AND sync_cursors.stream = 'history_import')))::text
         AS pending_history_imports,
       (SELECT count(*) FROM aruba_batches
        WHERE aruba_batches.status NOT IN ('RECONCILED', 'CANCELLED')
          AND NOT EXISTS (
            SELECT 1 FROM terminal_qualifications
            WHERE terminal_qualifications.batch_id = aruba_batches.id
          ))::text AS open_aruba_batches`,
  );
  const row = result.rows[0]!;
  return {
    unsafeApprovedDocuments: Number(row.unsafe_approved_documents),
    completedDryRunQualifications: Number(row.completed_dry_run_qualifications),
    unreconciledHistory: Number(row.unreconciled_history),
    pendingHistoryImports: Number(row.pending_history_imports),
    openArubaBatches: Number(row.open_aruba_batches),
  };
}
