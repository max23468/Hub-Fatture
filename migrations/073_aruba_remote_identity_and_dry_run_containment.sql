DROP INDEX aruba_remote_documents_fiscal_identity_idx;
DROP INDEX aruba_remote_documents_xml_idx;

CREATE INDEX aruba_remote_documents_fiscal_identity_idx
  ON aruba_remote_documents (
    environment, account_reference, fiscal_year, upper(series), upper(fiscal_number), document_type
  )
  WHERE series IS NOT NULL AND fiscal_number IS NOT NULL;

CREATE INDEX aruba_remote_documents_xml_idx
  ON aruba_remote_documents (environment, account_reference, xml_sha256)
  WHERE xml_sha256 IS NOT NULL;

UPDATE jobs
SET status = 'FAILED', completed_at = now(), lease_expires_at = NULL,
    locked_at = NULL, locked_by = NULL,
    last_error_code = 'ARUBA_SEND_NOT_AUTHORIZED'
WHERE type = 'aruba_dry_run_submission' AND status IN ('PENDING', 'RUNNING');

UPDATE aruba_dry_run_qualifications
SET status = 'CANCELLED', completed_at = now()
WHERE status = 'AUTHORIZED';

UPDATE aruba_dry_run_qualifications
SET status = 'UNKNOWN_REMOTE_STATE', completed_at = now()
WHERE status = 'CONSUMED';

WITH affected AS (
  UPDATE aruba_submissions AS submissions
  SET status = 'UNKNOWN_REMOTE_STATE',
      provider_filename = coalesce(
        submissions.provider_filename,
        (
          SELECT attempts.provider_reference
          FROM aruba_submission_attempts AS attempts
          WHERE attempts.submission_id = submissions.id
            AND attempts.operation = 'DRY_RUN'
            AND attempts.provider_reference IS NOT NULL
          ORDER BY attempts.attempt_number DESC
          LIMIT 1
        )
      ),
      error_code = 'ARUBA_SUBMISSION_UNKNOWN',
      error_message_sanitized = 'Il dry-run Production può avere prodotto un effetto remoto',
      next_readback_at = now(), last_checked_at = now(), remote_status_changed_at = now()
  WHERE submissions.environment = 'PRODUCTION'
    AND EXISTS (
      SELECT 1 FROM aruba_submission_attempts AS attempts
      WHERE attempts.submission_id = submissions.id AND attempts.operation = 'DRY_RUN'
    )
    AND NOT EXISTS (
      SELECT 1 FROM aruba_submission_attempts AS attempts
      WHERE attempts.submission_id = submissions.id AND attempts.operation = 'SEND'
    )
  RETURNING submissions.batch_id
)
UPDATE aruba_batches AS batches
SET status = 'UNKNOWN_REMOTE_STATE', requires_reconciliation = true, updated_at = now()
WHERE batches.id IN (SELECT batch_id FROM affected);
