UPDATE settings
SET value_json = CASE value_json #>> '{}'
  WHEN 'AUTOMATIC' THEN '"AUTOMATIC_AFTER_APPROVAL"'::jsonb
  ELSE '"DOCUMENT_ONLY"'::jsonb
END,
version = version + 1,
updated_at = now()
WHERE key = 'aruba_mode'
  AND value_json #>> '{}' IN ('ASSISTED', 'AUTOMATIC');

ALTER TABLE aruba_batches DROP CONSTRAINT aruba_batches_mode_check;
ALTER TABLE aruba_submissions DROP CONSTRAINT aruba_submissions_mode_check;

UPDATE aruba_batches
SET mode = CASE mode
  WHEN 'AUTOMATIC' THEN 'AUTOMATIC_AFTER_APPROVAL'
  ELSE 'DOCUMENT_ONLY'
END;

UPDATE aruba_submissions
SET mode = CASE mode
  WHEN 'AUTOMATIC' THEN 'AUTOMATIC_AFTER_APPROVAL'
  ELSE 'DOCUMENT_ONLY'
END;

ALTER TABLE aruba_batches
  ADD CONSTRAINT aruba_batches_mode_check CHECK (mode IN (
    'DOCUMENT_ONLY', 'CONTEXTUAL_CONFIRMATION', 'AUTOMATIC_AFTER_APPROVAL'
  )),
  ADD COLUMN transport text NOT NULL DEFAULT 'HELPER'
    CHECK (transport IN ('API', 'HELPER', 'MANUAL'));

ALTER TABLE aruba_submissions
  ADD CONSTRAINT aruba_submissions_mode_check CHECK (mode IN (
    'DOCUMENT_ONLY', 'CONTEXTUAL_CONFIRMATION', 'AUTOMATIC_AFTER_APPROVAL'
  )),
  ADD COLUMN transport text NOT NULL DEFAULT 'HELPER'
    CHECK (transport IN ('API', 'HELPER', 'MANUAL'));

ALTER TABLE aruba_batches DROP CONSTRAINT aruba_batches_status_check;
ALTER TABLE aruba_batches
  ADD CONSTRAINT aruba_batches_status_check CHECK (status IN (
    'PREPARED', 'DOCUMENT_ONLY', 'AWAITING_CONFIRMATION',
    'DRY_RUN_PENDING', 'DRY_RUN_VALIDATED', 'DRY_RUN_FAILED',
    'HELPER_ACTIVE', 'VALIDATION_FAILED', 'READY_ASSISTED', 'READY_AUTOMATIC',
    'SUBMITTED', 'UNKNOWN_REMOTE_STATE', 'RECONCILIATION_REQUIRED',
    'RECONCILED', 'CANCELLED'
  ));

ALTER TABLE aruba_batches DROP CONSTRAINT aruba_batches_reconciliation_check;
ALTER TABLE aruba_batches
  ADD CONSTRAINT aruba_batches_reconciliation_check CHECK (
    requires_reconciliation = (status IN ('UNKNOWN_REMOTE_STATE', 'RECONCILIATION_REQUIRED'))
  );

ALTER TABLE aruba_submissions DROP CONSTRAINT aruba_submissions_status_check;
ALTER TABLE aruba_submissions
  ADD CONSTRAINT aruba_submissions_status_check CHECK (status IN (
    'PENDING', 'DRY_RUN_PENDING', 'DRY_RUN_VALIDATED', 'DRY_RUN_FAILED',
    'UPLOADED', 'VALIDATED', 'VALIDATION_FAILED', 'READY_TO_SEND',
    'SUBMITTED', 'SDI_PROCESSING', 'DELIVERED', 'NOT_DELIVERED', 'REJECTED',
    'UNKNOWN', 'UNKNOWN_REMOTE_STATE', 'REMOVED', 'RECONCILED'
  ));

CREATE TABLE aruba_submission_attempts (
  id uuid PRIMARY KEY,
  submission_id bigint NOT NULL REFERENCES aruba_submissions(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (operation IN ('DRY_RUN', 'UPLOAD', 'SEND', 'READBACK')),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  xml_sha256 text NOT NULL CHECK (xml_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN (
    'PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNKNOWN_REMOTE_STATE', 'CANCELLED'
  )),
  provider_reference text,
  response_metadata_json jsonb NOT NULL DEFAULT '{}',
  error_code text,
  error_message_sanitized text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submission_id, operation, attempt_number)
);

CREATE UNIQUE INDEX aruba_submission_attempts_active_idx
  ON aruba_submission_attempts (submission_id, operation)
  WHERE status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'UNKNOWN_REMOTE_STATE');

CREATE TABLE aruba_dry_run_qualifications (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL UNIQUE REFERENCES aruba_batches(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment = 'PRODUCTION'),
  account_reference text NOT NULL CHECK (length(account_reference) BETWEEN 1 AND 200),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  endpoint text NOT NULL DEFAULT '/services/invoice/upload'
    CHECK (endpoint = '/services/invoice/upload'),
  request_limit integer NOT NULL DEFAULT 1 CHECK (request_limit = 1),
  status text NOT NULL DEFAULT 'AUTHORIZED' CHECK (status IN (
    'AUTHORIZED', 'CONSUMED', 'SUCCEEDED', 'FAILED', 'UNKNOWN_REMOTE_STATE',
    'EXPIRED', 'CANCELLED'
  )),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  completed_at timestamptz,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aruba_dry_run_qualifications_time_check CHECK (
    expires_at > created_at
    AND (consumed_at IS NULL OR consumed_at >= created_at)
    AND (completed_at IS NULL OR completed_at >= created_at)
  ),
  CONSTRAINT aruba_dry_run_qualifications_state_check CHECK (
    (status = 'AUTHORIZED' AND consumed_at IS NULL AND completed_at IS NULL)
    OR (status = 'CONSUMED' AND consumed_at IS NOT NULL AND completed_at IS NULL)
    OR (status IN ('SUCCEEDED', 'FAILED', 'UNKNOWN_REMOTE_STATE')
      AND consumed_at IS NOT NULL AND completed_at IS NOT NULL)
    OR (status IN ('EXPIRED', 'CANCELLED') AND consumed_at IS NULL AND completed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX aruba_dry_run_qualifications_active_idx
  ON aruba_dry_run_qualifications ((true))
  WHERE status = 'AUTHORIZED';

ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
ALTER TABLE jobs
  ADD CONSTRAINT jobs_type_check CHECK (type IN (
    'shopify_sync_orders', 'shopify_process_webhook', 'ebay_sync_orders',
    'ebay_preview_history', 'process_refund', 'send_customer_email',
    'aruba_backfill_inventory', 'aruba_sync_inventory',
    'aruba_refresh_nonterminal', 'aruba_full_inventory',
    'aruba_dry_run_submission'
  ));

CREATE UNIQUE INDEX jobs_aruba_outbound_active_idx
  ON jobs (type, (payload_json ->> 'submissionId'))
  WHERE type = 'aruba_dry_run_submission' AND status IN ('PENDING', 'RUNNING');
