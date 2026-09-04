ALTER TABLE connections
  ADD COLUMN account_info_json jsonb,
  ADD COLUMN account_info_checked_at timestamptz,
  ADD CONSTRAINT connections_aruba_account_info_check CHECK (
    (account_info_json IS NULL AND account_info_checked_at IS NULL)
    OR (provider = 'ARUBA' AND jsonb_typeof(account_info_json) = 'object'
      AND account_info_checked_at IS NOT NULL)
  );

ALTER TABLE aruba_submissions DROP CONSTRAINT aruba_submissions_status_check;
ALTER TABLE aruba_submissions
  ADD CONSTRAINT aruba_submissions_status_check CHECK (status IN (
    'PENDING', 'DRY_RUN_PENDING', 'DRY_RUN_VALIDATED', 'DRY_RUN_FAILED',
    'SEND_PENDING', 'SEND_FAILED', 'ARUBA_ACCEPTED',
    'UPLOADED', 'VALIDATED', 'VALIDATION_FAILED', 'READY_TO_SEND',
    'SUBMITTED', 'SDI_PROCESSING', 'DELIVERED', 'NOT_DELIVERED', 'REJECTED',
    'UNKNOWN', 'UNKNOWN_REMOTE_STATE', 'REMOVED', 'RECONCILED'
  )),
  ADD COLUMN source_filename text,
  ADD COLUMN provider_filename text,
  ADD COLUMN provider_sdi_id text,
  ADD COLUMN accepted_at timestamptz,
  ADD COLUMN next_readback_at timestamptz,
  ADD COLUMN remote_status_changed_at timestamptz,
  ADD CONSTRAINT aruba_submissions_source_filename_check CHECK (
    source_filename IS NULL OR source_filename ~ '^[A-Za-z0-9._-]+\.xml$'
  ),
  ADD CONSTRAINT aruba_submissions_provider_filename_check CHECK (
    provider_filename IS NULL OR length(provider_filename) BETWEEN 1 AND 255
  ),
  ADD CONSTRAINT aruba_submissions_provider_sdi_id_check CHECK (
    provider_sdi_id IS NULL OR length(provider_sdi_id) BETWEEN 1 AND 200
  );

UPDATE aruba_submissions AS submissions
SET source_filename = batch_documents.filename
FROM aruba_batch_documents AS batch_documents
WHERE batch_documents.batch_id = submissions.batch_id
  AND batch_documents.document_id = submissions.document_id
  AND submissions.source_filename IS NULL;

ALTER TABLE aruba_batches DROP CONSTRAINT aruba_batches_status_check;
ALTER TABLE aruba_batches
  ADD CONSTRAINT aruba_batches_status_check CHECK (status IN (
    'PREPARED', 'DOCUMENT_ONLY', 'AWAITING_CONFIRMATION',
    'DRY_RUN_PENDING', 'DRY_RUN_VALIDATED', 'DRY_RUN_FAILED',
    'SEND_PENDING', 'SEND_FAILED', 'ARUBA_ACCEPTED',
    'HELPER_ACTIVE', 'VALIDATION_FAILED', 'READY_ASSISTED', 'READY_AUTOMATIC',
    'SUBMITTED', 'UNKNOWN_REMOTE_STATE', 'RECONCILIATION_REQUIRED',
    'RECONCILED', 'CANCELLED'
  ));

DROP INDEX aruba_submission_attempts_active_idx;
CREATE UNIQUE INDEX aruba_submission_attempts_active_idx
  ON aruba_submission_attempts (submission_id, operation)
  WHERE status IN ('PENDING', 'RUNNING', 'UNKNOWN_REMOTE_STATE');

CREATE INDEX aruba_submissions_readback_due_idx
  ON aruba_submissions (next_readback_at, id)
  WHERE status IN ('ARUBA_ACCEPTED', 'SDI_PROCESSING', 'SUBMITTED',
    'UNKNOWN', 'UNKNOWN_REMOTE_STATE');

UPDATE aruba_submissions
SET remote_status_changed_at = coalesce(last_checked_at, accepted_at, submitted_at, now());

CREATE INDEX aruba_submissions_provider_filename_idx
  ON aruba_submissions (environment, provider_filename)
  WHERE provider_filename IS NOT NULL;

CREATE INDEX aruba_submissions_provider_sdi_id_idx
  ON aruba_submissions (environment, provider_sdi_id)
  WHERE provider_sdi_id IS NOT NULL;

ALTER TABLE aruba_remote_documents
  ADD COLUMN provider_filename text,
  ADD COLUMN provider_sdi_id text,
  ADD COLUMN remote_last_update timestamptz,
  ADD CONSTRAINT aruba_remote_documents_provider_filename_check CHECK (
    provider_filename IS NULL OR length(provider_filename) BETWEEN 1 AND 255
  ),
  ADD CONSTRAINT aruba_remote_documents_provider_sdi_id_check CHECK (
    provider_sdi_id IS NULL OR length(provider_sdi_id) BETWEEN 1 AND 200
  );

CREATE INDEX aruba_remote_documents_filename_idx
  ON aruba_remote_documents (environment, account_reference, provider_filename)
  WHERE provider_filename IS NOT NULL;

CREATE INDEX aruba_remote_documents_sdi_id_idx
  ON aruba_remote_documents (environment, account_reference, provider_sdi_id)
  WHERE provider_sdi_id IS NOT NULL;

ALTER TABLE aruba_api_traffic_limits DROP CONSTRAINT aruba_api_traffic_limits_scope_check;
ALTER TABLE aruba_api_traffic_limits
  ADD CONSTRAINT aruba_api_traffic_limits_scope_check CHECK (
    scope IN ('AUTH', 'INVOICE_READ', 'NOTIFICATION_READ', 'SEND')
  );

ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
ALTER TABLE jobs
  ADD COLUMN priority smallint NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 1000),
  ADD CONSTRAINT jobs_type_check CHECK (type IN (
    'shopify_sync_orders', 'shopify_process_webhook', 'ebay_sync_orders',
    'ebay_preview_history', 'process_refund', 'send_customer_email',
    'aruba_backfill_inventory', 'aruba_sync_inventory',
    'aruba_refresh_nonterminal', 'aruba_full_inventory',
    'aruba_dry_run_submission', 'aruba_send_submission',
    'aruba_readback_submission', 'maintenance_retention'
  ));

CREATE INDEX jobs_priority_claim_idx
  ON jobs (status, priority, run_at, lease_expires_at, id);

CREATE UNIQUE INDEX jobs_aruba_send_active_idx
  ON jobs (type, (payload_json ->> 'submissionId'))
  WHERE type = 'aruba_send_submission' AND status IN ('PENDING', 'RUNNING');

CREATE UNIQUE INDEX jobs_aruba_readback_active_idx
  ON jobs (type, (payload_json ->> 'submissionId'))
  WHERE type = 'aruba_readback_submission' AND status IN ('PENDING', 'RUNNING');

COMMENT ON COLUMN connections.account_info_json IS
  'Ultimo snapshot userInfo Aruba validato; non contiene token o credenziali.';
COMMENT ON COLUMN aruba_submissions.accepted_at IS
  'Istante in cui Aruba ha restituito 0000; non prova invio o consegna SdI.';
COMMENT ON COLUMN aruba_submissions.remote_status_changed_at IS
  'Istante dell’ultima transizione remota autorevole; il polling ripetuto non lo azzera.';
COMMENT ON COLUMN jobs.priority IS
  'Priorità crescente del lavoro; i valori inferiori vengono reclamati per primi.';
