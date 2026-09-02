import type pg from "pg";

import { writeAudit } from "./audit.server.ts";

const determinedStatuses = new Set([
  "SUBMITTED",
  "SDI_PROCESSING",
  "DELIVERED",
  "NOT_DELIVERED",
  "REJECTED",
]);

export async function reconcileCanarySubmissionReadback(
  client: pg.PoolClient,
  remoteDocumentId: string,
) {
  const result = await client.query<{
    submission_id: string;
    batch_id: string;
    remote_id: string;
    remote_status: string;
    manifest_sha256: string;
    file_count: number;
  }>(
    `SELECT submissions.id AS submission_id, submissions.batch_id, remote.remote_id,
            remote.remote_status, permits.manifest_sha256,
            (SELECT count(*)::integer FROM aruba_files
             WHERE remote_document_id = remote.id) AS file_count
     FROM aruba_remote_documents AS remote
     JOIN aruba_canary_permits AS permits
       ON permits.environment = remote.environment
      AND permits.account_reference = remote.account_reference
      AND permits.xml_sha256 = remote.xml_sha256
      AND permits.consumed_at IS NOT NULL
     JOIN aruba_submissions AS submissions
       ON submissions.batch_id = permits.batch_id
      AND submissions.document_id = permits.document_id
      AND submissions.xml_sha256 = permits.xml_sha256
     WHERE remote.id = $1 AND submissions.status IN (
       'SUBMITTED', 'SDI_PROCESSING', 'DELIVERED', 'NOT_DELIVERED',
       'REJECTED', 'UNKNOWN_REMOTE_STATE'
     )
     FOR UPDATE OF remote, submissions`,
    [remoteDocumentId],
  );
  const current = result.rows[0];
  if (!current) return null;
  const determined = determinedStatuses.has(current.remote_status);
  const submissionStatus = determined ? current.remote_status : "UNKNOWN_REMOTE_STATE";
  await client.query(`UPDATE aruba_remote_documents SET origin = 'HUB_SUBMISSION' WHERE id = $1`, [
    remoteDocumentId,
  ]);
  await client.query(
    `UPDATE aruba_submissions SET remote_id = $2, status = $3,
       last_checked_at = now(), readback_metadata_json = jsonb_build_object(
         'status', $3::text, 'officialFileCount', $4::integer),
       error_code = CASE WHEN $5 THEN NULL ELSE 'ARUBA_SUBMISSION_UNKNOWN' END,
       error_message_sanitized = CASE WHEN $5 THEN NULL ELSE 'Stato remoto non determinato' END
     WHERE id = $1`,
    [current.submission_id, current.remote_id, submissionStatus, current.file_count, determined],
  );
  await client.query(
    `UPDATE aruba_submission_attempts SET
       status = CASE WHEN $2 THEN 'SUCCEEDED' ELSE 'UNKNOWN_REMOTE_STATE' END,
       provider_reference = $3,
       response_metadata_json = jsonb_build_object(
         'status', $4::text, 'officialFileCount', $5::integer),
       error_code = CASE WHEN $2 THEN NULL ELSE 'ARUBA_SUBMISSION_UNKNOWN' END,
       error_message_sanitized = CASE WHEN $2 THEN NULL ELSE 'Stato remoto non determinato' END,
       started_at = coalesce(started_at, now()), completed_at = now()
     WHERE submission_id = $1 AND operation = 'READBACK' AND status = 'PENDING'`,
    [
      current.submission_id,
      determined,
      current.remote_id,
      current.remote_status,
      current.file_count,
    ],
  );
  await client.query(
    `UPDATE aruba_batches SET status = CASE WHEN $2 THEN 'RECONCILED' ELSE 'UNKNOWN_REMOTE_STATE' END,
       requires_reconciliation = NOT $2, last_readback_at = now(), updated_at = now()
     WHERE id = $1`,
    [current.batch_id, determined],
  );
  await writeAudit(client, {
    actorType: "SYSTEM",
    action: determined ? "ARUBA_API_CANARY_READBACK" : "ARUBA_API_CANARY_UNKNOWN",
    eventClass: "CRITICAL",
    entityType: "ARUBA_SUBMISSION",
    entityId: current.submission_id,
    metadata: {
      batchId: current.batch_id,
      manifestSha256: current.manifest_sha256,
      provider: "ARUBA",
      affectedCount: current.file_count,
    },
    requestId: `aruba-canary-readback:${current.submission_id}`,
  });
  return {
    submissionId: current.submission_id,
    batchId: current.batch_id,
    status: submissionStatus,
    officialFileCount: current.file_count,
  };
}
