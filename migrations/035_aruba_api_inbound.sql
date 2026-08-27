ALTER TABLE connections
  DROP CONSTRAINT connections_aruba_credentials_check,
  DROP CONSTRAINT connections_status_check,
  ADD CONSTRAINT connections_status_check CHECK (
    status IN ('PAUSED', 'CONNECTED', 'REAUTH_REQUIRED', 'REVOKED', 'ERROR')
  ),
  ADD CONSTRAINT connections_credentials_check CHECK (
    (provider IN ('SHOPIFY', 'EBAY') AND encrypted_credentials IS NOT NULL)
    OR provider = 'ARUBA'
  ),
  ADD COLUMN api_paused boolean NOT NULL DEFAULT true,
  ADD COLUMN inbound_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN automatic_authority text NOT NULL DEFAULT 'BROWSER'
    CHECK (automatic_authority IN ('BROWSER', 'API')),
  ADD COLUMN credentials_verified_at timestamptz,
  ADD COLUMN credentials_rotated_at timestamptz,
  ADD COLUMN credentials_revoked_at timestamptz,
  ADD COLUMN last_full_sync_at timestamptz;

UPDATE connections
SET status = 'PAUSED', api_paused = true, inbound_enabled = false,
    automatic_authority = 'BROWSER'
WHERE provider = 'ARUBA' AND encrypted_credentials IS NULL;

ALTER TABLE jobs
  DROP CONSTRAINT jobs_type_check,
  ADD CONSTRAINT jobs_type_check CHECK (type IN (
    'shopify_sync_orders', 'shopify_process_webhook', 'ebay_sync_orders',
    'ebay_preview_history', 'process_refund', 'send_customer_email',
    'aruba_backfill_inventory', 'aruba_sync_inventory',
    'aruba_refresh_nonterminal', 'aruba_full_inventory'
  ));

CREATE UNIQUE INDEX jobs_aruba_inbound_active_idx
  ON jobs ((true))
  WHERE type IN (
    'aruba_backfill_inventory', 'aruba_sync_inventory',
    'aruba_refresh_nonterminal', 'aruba_full_inventory'
  ) AND status IN ('PENDING', 'RUNNING');

CREATE TABLE aruba_api_auth_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX aruba_api_auth_attempts_recent_idx
  ON aruba_api_auth_attempts (attempted_at DESC);

CREATE TABLE aruba_sync_runs (
  id uuid PRIMARY KEY,
  environment text NOT NULL CHECK (environment IN ('MOCK', 'PRODUCTION')),
  api_environment text NOT NULL CHECK (api_environment IN ('DEMO', 'PRODUCTION')),
  account_reference text NOT NULL CHECK (length(account_reference) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('BACKFILL', 'INCREMENTAL', 'TARGETED', 'FULL')),
  authority_mode text NOT NULL CHECK (authority_mode IN ('SHADOW', 'CANONICAL')),
  status text NOT NULL DEFAULT 'RUNNING'
    CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED', 'INCOMPLETE', 'CANCELLED')),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  checkpoint_start timestamptz NOT NULL,
  checkpoint_end timestamptz NOT NULL,
  checkpoint_page integer NOT NULL DEFAULT 1 CHECK (checkpoint_page > 0),
  page_count integer NOT NULL DEFAULT 0 CHECK (page_count >= 0),
  group_count integer NOT NULL DEFAULT 0 CHECK (group_count >= 0),
  document_count integer NOT NULL DEFAULT 0 CHECK (document_count >= 0),
  file_count integer NOT NULL DEFAULT 0 CHECK (file_count >= 0),
  notification_count integer NOT NULL DEFAULT 0 CHECK (notification_count >= 0),
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  request_limit integer NOT NULL DEFAULT 10000 CHECK (request_limit BETWEEN 1 AND 10000),
  lease_expires_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  full_scan_completed_at timestamptz,
  last_error_code text,
  last_error_message_sanitized text,
  CONSTRAINT aruba_sync_runs_window_check CHECK (
    window_start < window_end
    AND checkpoint_start >= window_start
    AND checkpoint_end > checkpoint_start
    AND checkpoint_end <= window_end
  ),
  CONSTRAINT aruba_sync_runs_completion_check CHECK (
    (status = 'COMPLETED' AND completed_at IS NOT NULL)
    OR status <> 'COMPLETED'
  ),
  CONSTRAINT aruba_sync_runs_request_budget_check CHECK (
    request_count <= request_limit
  )
);

CREATE UNIQUE INDEX aruba_sync_runs_active_account_idx
  ON aruba_sync_runs (environment, account_reference)
  WHERE status = 'RUNNING';

CREATE INDEX aruba_sync_runs_recent_idx
  ON aruba_sync_runs (environment, account_reference, started_at DESC);

CREATE TABLE aruba_sync_run_pages (
  sync_run_id uuid NOT NULL REFERENCES aruba_sync_runs(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  page_ordinal integer NOT NULL CHECK (page_ordinal > 0),
  terminal boolean NOT NULL,
  group_count integer NOT NULL CHECK (group_count >= 0),
  document_count integer NOT NULL CHECK (document_count >= 0),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  committed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sync_run_id, window_start, window_end, page_ordinal)
);

CREATE TABLE aruba_api_shadow_documents (
  sync_run_id uuid NOT NULL REFERENCES aruba_sync_runs(id) ON DELETE CASCADE,
  provider_group_id text NOT NULL CHECK (length(provider_group_id) BETWEEN 1 AND 200),
  remote_key text NOT NULL CHECK (length(remote_key) BETWEEN 1 AND 500),
  document_type text NOT NULL CHECK (document_type IN ('TD01', 'TD04')),
  fiscal_year integer NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 9999),
  series text,
  fiscal_number text,
  document_date date NOT NULL,
  total_amount integer NOT NULL CHECK (total_amount >= 0),
  remote_status text NOT NULL CHECK (remote_status IN (
    'SUBMITTED', 'SDI_PROCESSING', 'DELIVERED', 'NOT_DELIVERED', 'REJECTED', 'UNKNOWN'
  )),
  xml_sha256 text CHECK (xml_sha256 IS NULL OR xml_sha256 ~ '^[0-9a-f]{64}$'),
  p7m_sha256 text CHECK (p7m_sha256 IS NULL OR p7m_sha256 ~ '^[0-9a-f]{64}$'),
  pdf_sha256 text CHECK (pdf_sha256 IS NULL OR pdf_sha256 ~ '^[0-9a-f]{64}$'),
  notification_hashes jsonb NOT NULL DEFAULT '[]',
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sync_run_id, remote_key),
  CONSTRAINT aruba_api_shadow_fiscal_identity_check CHECK (
    (series IS NULL AND fiscal_number IS NULL)
    OR (nullif(btrim(series), '') IS NOT NULL AND nullif(btrim(fiscal_number), '') IS NOT NULL)
  ),
  CONSTRAINT aruba_api_shadow_notification_hashes_check CHECK (
    jsonb_typeof(notification_hashes) = 'array'
  )
);

CREATE TABLE aruba_inbound_parity_dossiers (
  id uuid PRIMARY KEY,
  sync_run_id uuid NOT NULL UNIQUE REFERENCES aruba_sync_runs(id),
  environment text NOT NULL CHECK (environment IN ('MOCK', 'PRODUCTION')),
  account_reference text NOT NULL,
  status text NOT NULL CHECK (status IN ('MATCHED', 'DIVERGENT', 'INCOMPLETE')),
  api_documents integer NOT NULL CHECK (api_documents >= 0),
  browser_documents integer NOT NULL CHECK (browser_documents >= 0),
  matched_documents integer NOT NULL CHECK (matched_documents >= 0),
  missing_in_api integer NOT NULL CHECK (missing_in_api >= 0),
  missing_in_browser integer NOT NULL CHECK (missing_in_browser >= 0),
  status_mismatches integer NOT NULL CHECK (status_mismatches >= 0),
  file_mismatches integer NOT NULL CHECK (file_mismatches >= 0),
  summary_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE aruba_remote_documents
  ADD COLUMN provider_group_id text,
  ADD COLUMN automatic_source text NOT NULL DEFAULT 'BROWSER'
    CHECK (automatic_source IN ('BROWSER', 'API', 'MANUAL'));

CREATE INDEX aruba_remote_documents_provider_group_idx
  ON aruba_remote_documents (environment, account_reference, provider_group_id)
  WHERE provider_group_id IS NOT NULL;

ALTER TABLE aruba_remote_observations
  ALTER COLUMN sync_session_id DROP NOT NULL,
  ADD COLUMN sync_run_id uuid REFERENCES aruba_sync_runs(id),
  ADD CONSTRAINT aruba_remote_observations_source_check CHECK (
    num_nonnulls(sync_session_id, sync_run_id) = 1
  );

CREATE UNIQUE INDEX aruba_remote_observations_api_dedup_idx
  ON aruba_remote_observations
    (remote_document_id, sync_run_id, stream, scan_ordinal, page_ordinal, payload_digest)
  WHERE sync_run_id IS NOT NULL;

ALTER TABLE aruba_deduplication_conflicts
  ALTER COLUMN sync_session_id DROP NOT NULL,
  ADD COLUMN sync_run_id uuid REFERENCES aruba_sync_runs(id),
  ADD CONSTRAINT aruba_deduplication_conflicts_source_check CHECK (
    num_nonnulls(sync_session_id, sync_run_id) = 1
  );
