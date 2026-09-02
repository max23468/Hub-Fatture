import { getConfig } from "../config.server.ts";
import { getPool } from "./client.server.ts";

export async function arubaCanaryReadinessState() {
  const result = await getPool().query<{
    permit_count: number;
    consumed_permits: number;
    active_permits: number;
    expired_permits: number;
    batch_status: string | null;
    submission_status: string | null;
    remote_status: string | null;
    dry_run_succeeded: number;
    send_succeeded: number;
    send_unknown: number;
    send_attempts: number;
    readback_succeeded: number;
    official_files: number;
    xml_or_p7m_files: number;
    pdf_files: number;
    notification_files: number;
    active_jobs: number;
  }>(
    `SELECT
       (SELECT count(*)::integer FROM aruba_canary_permits) AS permit_count,
       (SELECT count(*)::integer FROM aruba_canary_permits
        WHERE consumed_at IS NOT NULL) AS consumed_permits,
       (SELECT count(*)::integer FROM aruba_canary_permits
        WHERE consumed_at IS NULL AND expired_at IS NULL AND expires_at > now()) AS active_permits,
       (SELECT count(*)::integer FROM aruba_canary_permits
        WHERE expired_at IS NOT NULL OR (consumed_at IS NULL AND expires_at <= now())) AS expired_permits,
       batches.status AS batch_status,
       submissions.status AS submission_status,
       remote.remote_status,
       count(*) FILTER (WHERE attempts.operation = 'DRY_RUN'
         AND attempts.status = 'SUCCEEDED')::integer AS dry_run_succeeded,
       count(*) FILTER (WHERE attempts.operation = 'SEND'
         AND attempts.status = 'SUCCEEDED')::integer AS send_succeeded,
       count(*) FILTER (WHERE attempts.operation = 'SEND'
         AND attempts.status = 'UNKNOWN_REMOTE_STATE')::integer AS send_unknown,
       count(*) FILTER (WHERE attempts.operation = 'SEND')::integer AS send_attempts,
       count(*) FILTER (WHERE attempts.operation = 'READBACK'
         AND attempts.status = 'SUCCEEDED')::integer AS readback_succeeded,
       (SELECT count(*)::integer FROM aruba_files
        WHERE remote_document_id = remote.id) AS official_files,
       (SELECT count(*)::integer FROM aruba_files
        WHERE remote_document_id = remote.id AND kind IN ('ARUBA_XML', 'ARUBA_P7M'))
         AS xml_or_p7m_files,
       (SELECT count(*)::integer FROM aruba_files
        WHERE remote_document_id = remote.id AND kind = 'ARUBA_PDF') AS pdf_files,
       (SELECT count(*)::integer FROM aruba_files
        WHERE remote_document_id = remote.id AND kind = 'SDI_NOTIFICATION') AS notification_files,
       (SELECT count(*)::integer FROM jobs
        WHERE type IN ('aruba_send_submission', 'aruba_sync_inventory',
          'aruba_refresh_nonterminal') AND status IN ('PENDING', 'RUNNING')) AS active_jobs
     FROM aruba_canary_permits AS permits
     JOIN aruba_batches AS batches ON batches.id = permits.batch_id
     JOIN aruba_submissions AS submissions
       ON submissions.batch_id = batches.id AND submissions.document_id = permits.document_id
     LEFT JOIN aruba_submission_attempts AS attempts ON attempts.submission_id = submissions.id
     LEFT JOIN aruba_remote_documents AS remote
       ON remote.environment = permits.environment
      AND remote.account_reference = permits.account_reference
      AND remote.remote_id = submissions.remote_id
     GROUP BY batches.status, submissions.status, remote.id, remote.remote_status
     ORDER BY max(permits.created_at) DESC LIMIT 1`,
  );
  const current = result.rows[0];
  const config = getConfig();
  const canaryEnabled = config.ARUBA_CANARY_ENABLED;
  const submissionEnabled = config.ARUBA_SUBMISSION_ENABLED;
  if (!current) {
    return {
      state: canaryEnabled ? ("NOT_AUTHORIZED" as const) : ("SKIPPED" as const),
      canaryEnabled,
      submissionEnabled,
      permitCount: 0,
      consumedPermits: 0,
      activePermits: 0,
      activeJobs: 0,
    };
  }
  const complete =
    current.permit_count === 1 &&
    current.consumed_permits === 1 &&
    current.active_permits === 0 &&
    current.batch_status === "RECONCILED" &&
    current.submission_status !== "UNKNOWN_REMOTE_STATE" &&
    current.remote_status !== null &&
    current.dry_run_succeeded === 1 &&
    current.send_attempts === 1 &&
    current.send_succeeded + current.send_unknown === 1 &&
    current.readback_succeeded === 1 &&
    current.xml_or_p7m_files >= 1 &&
    current.active_jobs === 0 &&
    !canaryEnabled &&
    !submissionEnabled;
  const skipped =
    !canaryEnabled &&
    current.consumed_permits === 0 &&
    current.active_permits === 0 &&
    current.send_attempts === 0;
  return {
    state: complete
      ? ("COMPLETE" as const)
      : skipped
        ? ("SKIPPED" as const)
        : ("INCOMPLETE" as const),
    canaryEnabled,
    submissionEnabled,
    permitCount: current.permit_count,
    consumedPermits: current.consumed_permits,
    activePermits: current.active_permits,
    expiredPermits: current.expired_permits,
    batchStatus: current.batch_status,
    submissionStatus: current.submission_status,
    remoteStatus: current.remote_status,
    dryRunSucceeded: current.dry_run_succeeded,
    sendSucceeded: current.send_succeeded,
    sendUnknown: current.send_unknown,
    sendAttempts: current.send_attempts,
    readbackSucceeded: current.readback_succeeded,
    officialFiles: current.official_files,
    xmlOrP7mFiles: current.xml_or_p7m_files,
    pdfFiles: current.pdf_files,
    notificationFiles: current.notification_files,
    activeJobs: current.active_jobs,
  };
}
