ALTER TABLE sync_cursors
  DROP CONSTRAINT sync_cursors_provider_check,
  ADD CONSTRAINT sync_cursors_provider_check CHECK (provider IN ('SHOPIFY', 'EBAY', 'ARUBA'));

ALTER TABLE sync_cursors
  ADD COLUMN full_scan_completed_at timestamptz,
  ADD COLUMN last_page_ordinal integer CHECK (last_page_ordinal IS NULL OR last_page_ordinal > 0);

CREATE SEQUENCE aruba_inventory_watermark_seq AS bigint START WITH 1;

CREATE TABLE aruba_sync_sessions (
  id uuid PRIMARY KEY,
  environment text NOT NULL CHECK (environment IN ('MOCK', 'PRODUCTION')),
  account_reference text NOT NULL CHECK (length(account_reference) BETWEEN 1 AND 200),
  device_id text NOT NULL CHECK (device_id ~ '^[A-Za-z0-9_-]{16,100}$'),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  scope text NOT NULL DEFAULT 'ARUBA_READ_SYNC' CHECK (scope = 'ARUBA_READ_SYNC'),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN (
    'ACTIVE', 'SCANNING', 'COMPLETED', 'FAILED', 'INCOMPLETE', 'REVOKED', 'EXPIRED'
  )),
  helper_version text,
  browser_name text CHECK (browser_name IS NULL OR browser_name IN ('chrome', 'msedge')),
  lease_expires_at timestamptz,
  absolute_expires_at timestamptz NOT NULL,
  last_heartbeat_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  full_scan_completed_at timestamptz,
  failed_at timestamptz,
  is_full_scan boolean NOT NULL DEFAULT true,
  source text NOT NULL DEFAULT 'HELPER' CHECK (source IN ('HELPER', 'MANUAL')),
  initial_cursor text,
  final_cursor text,
  inventory_watermark bigint NOT NULL DEFAULT 0 CHECK (inventory_watermark >= 0),
  page_count integer NOT NULL DEFAULT 0 CHECK (page_count >= 0),
  document_count integer NOT NULL DEFAULT 0 CHECK (document_count >= 0),
  error_code text,
  error_message_sanitized text,
  requested_by smallint REFERENCES users(id),
  CONSTRAINT aruba_sync_session_expiry_check CHECK (absolute_expires_at <= started_at + interval '8 hours'),
  CONSTRAINT aruba_sync_session_completion_check CHECK (
    (status = 'COMPLETED' AND completed_at IS NOT NULL)
    OR status <> 'COMPLETED'
  )
);

CREATE UNIQUE INDEX aruba_sync_sessions_active_account_idx
  ON aruba_sync_sessions (environment, account_reference)
  WHERE status IN ('ACTIVE', 'SCANNING');

CREATE INDEX aruba_sync_sessions_recent_idx
  ON aruba_sync_sessions (environment, account_reference, started_at DESC);

CREATE TABLE aruba_sync_pages (
  sync_session_id uuid NOT NULL REFERENCES aruba_sync_sessions(id) ON DELETE CASCADE,
  stream text NOT NULL,
  scan_ordinal integer NOT NULL CHECK (scan_ordinal > 0),
  page_ordinal integer NOT NULL CHECK (page_ordinal > 0),
  cursor text,
  terminal boolean NOT NULL,
  full_scan boolean NOT NULL,
  row_count integer NOT NULL CHECK (row_count >= 0 AND row_count <= 300),
  documents_json jsonb NOT NULL DEFAULT '[]',
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  committed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sync_session_id, stream, scan_ordinal, page_ordinal),
  UNIQUE (sync_session_id, stream, scan_ordinal, payload_digest)
);

CREATE TABLE aruba_remote_documents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  environment text NOT NULL CHECK (environment IN ('MOCK', 'PRODUCTION')),
  account_reference text NOT NULL CHECK (length(account_reference) BETWEEN 1 AND 200),
  remote_id text NOT NULL CHECK (length(remote_id) BETWEEN 1 AND 200),
  document_type text NOT NULL CHECK (document_type IN ('TD01', 'TD04')),
  fiscal_year integer NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 9999),
  series text,
  fiscal_number text,
  document_date date NOT NULL,
  recipient_name_normalized text,
  recipient_tax_id_normalized text,
  recipient_country_code text CHECK (
    recipient_country_code IS NULL OR recipient_country_code ~ '^[A-Z]{2}$'
  ),
  recipient_address_normalized text,
  total_amount integer NOT NULL CHECK (total_amount >= 0),
  currency text NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  remote_status text NOT NULL CHECK (remote_status IN (
    'SUBMITTED', 'SDI_PROCESSING', 'DELIVERED', 'NOT_DELIVERED', 'REJECTED', 'UNKNOWN'
  )),
  remote_status_observed_at timestamptz NOT NULL,
  xml_sha256 text CHECK (xml_sha256 IS NULL OR xml_sha256 ~ '^[0-9a-f]{64}$'),
  origin text NOT NULL DEFAULT 'UNKNOWN' CHECK (origin IN (
    'HUB_SUBMISSION', 'ARUBA_EXTERNAL', 'UNKNOWN'
  )),
  first_observed_at timestamptz NOT NULL DEFAULT now(),
  last_observed_at timestamptz NOT NULL DEFAULT now(),
  last_full_scan_at timestamptz,
  inventory_version bigint NOT NULL DEFAULT 1 CHECK (inventory_version > 0),
  metadata_digest text NOT NULL CHECK (metadata_digest ~ '^[0-9a-f]{64}$'),
  UNIQUE (environment, account_reference, remote_id),
  CONSTRAINT aruba_remote_fiscal_identity_check CHECK (
    (series IS NULL AND fiscal_number IS NULL)
    OR (nullif(btrim(series), '') IS NOT NULL AND nullif(btrim(fiscal_number), '') IS NOT NULL)
  )
);

CREATE UNIQUE INDEX aruba_remote_documents_fiscal_identity_idx
  ON aruba_remote_documents (
    environment, account_reference, fiscal_year, upper(series), upper(fiscal_number), document_type
  )
  WHERE series IS NOT NULL AND fiscal_number IS NOT NULL;

CREATE UNIQUE INDEX aruba_remote_documents_xml_idx
  ON aruba_remote_documents (environment, account_reference, xml_sha256)
  WHERE xml_sha256 IS NOT NULL;

CREATE INDEX aruba_remote_documents_status_idx
  ON aruba_remote_documents (remote_status, last_observed_at DESC);

CREATE TABLE aruba_remote_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  remote_document_id bigint NOT NULL REFERENCES aruba_remote_documents(id) ON DELETE CASCADE,
  sync_session_id uuid NOT NULL REFERENCES aruba_sync_sessions(id),
  remote_status text NOT NULL CHECK (remote_status IN (
    'SUBMITTED', 'SDI_PROCESSING', 'DELIVERED', 'NOT_DELIVERED', 'REJECTED', 'UNKNOWN'
  )),
  provider_observed_at timestamptz,
  observed_at timestamptz NOT NULL DEFAULT now(),
  stream text NOT NULL,
  scan_ordinal integer NOT NULL CHECK (scan_ordinal > 0),
  page_ordinal integer NOT NULL CHECK (page_ordinal > 0),
  cursor text,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  error_code text,
  UNIQUE (remote_document_id, sync_session_id, stream, scan_ordinal, page_ordinal, payload_digest)
);

CREATE INDEX aruba_remote_observations_document_idx
  ON aruba_remote_observations (remote_document_id, observed_at DESC);

CREATE TABLE aruba_document_matches (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  remote_document_id bigint NOT NULL UNIQUE REFERENCES aruba_remote_documents(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN (
    'MATCHED', 'UNMATCHED', 'AMBIGUOUS', 'PROFILE_CONFLICT', 'ERROR', 'UNKNOWN_REMOTE_STATE'
  )),
  method text NOT NULL CHECK (method IN ('AUTOMATIC', 'MANUAL', 'NONE')),
  matcher_version integer NOT NULL CHECK (matcher_version > 0),
  document_id bigint REFERENCES documents(id),
  order_id bigint REFERENCES orders(id),
  billing_case_id bigint REFERENCES billing_cases(id),
  related_invoice_document_id bigint REFERENCES documents(id),
  refund_ids bigint[] NOT NULL DEFAULT '{}',
  signals_json jsonb NOT NULL DEFAULT '{}',
  candidates_json jsonb NOT NULL DEFAULT '[]',
  decided_by smallint REFERENCES users(id),
  decision_reason text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aruba_match_decision_check CHECK (
    (method = 'MANUAL' AND decided_by IS NOT NULL AND nullif(btrim(decision_reason), '') IS NOT NULL
      AND decided_at IS NOT NULL)
    OR method <> 'MANUAL'
  )
);

CREATE TABLE aruba_deduplication_conflicts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  environment text NOT NULL CHECK (environment IN ('MOCK', 'PRODUCTION')),
  account_reference text NOT NULL,
  existing_remote_document_id bigint NOT NULL REFERENCES aruba_remote_documents(id),
  incoming_remote_id text NOT NULL,
  collision_key text NOT NULL CHECK (collision_key IN ('FISCAL_IDENTITY', 'XML_SHA256')),
  incoming_payload_digest text NOT NULL CHECK (incoming_payload_digest ~ '^[0-9a-f]{64}$'),
  sync_session_id uuid NOT NULL REFERENCES aruba_sync_sessions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (environment, account_reference, incoming_remote_id, collision_key, incoming_payload_digest)
);

CREATE INDEX aruba_document_matches_attention_idx
  ON aruba_document_matches (status, updated_at DESC)
  WHERE status <> 'MATCHED';

ALTER TABLE aruba_files
  ALTER COLUMN document_id DROP NOT NULL,
  ADD COLUMN remote_document_id bigint REFERENCES aruba_remote_documents(id);

ALTER TABLE aruba_files
  ADD CONSTRAINT aruba_files_owner_check CHECK (
    num_nonnulls(submission_id, remote_document_id) = 1
  );

ALTER TABLE sdi_notifications
  ALTER COLUMN submission_id DROP NOT NULL,
  ADD COLUMN remote_document_id bigint REFERENCES aruba_remote_documents(id),
  ADD CONSTRAINT sdi_notifications_owner_check CHECK (
    num_nonnulls(submission_id, remote_document_id) = 1
  );

CREATE UNIQUE INDEX sdi_notifications_remote_identity_idx
  ON sdi_notifications (remote_document_id, remote_notification_id)
  WHERE remote_document_id IS NOT NULL;

CREATE TABLE aruba_preflight_receipts (
  id uuid PRIMARY KEY,
  environment text NOT NULL CHECK (environment IN ('MOCK', 'PRODUCTION')),
  account_reference text NOT NULL,
  billing_case_id bigint REFERENCES billing_cases(id),
  document_id bigint REFERENCES documents(id),
  draft_version integer NOT NULL CHECK (draft_version > 0),
  projection_sha256 text NOT NULL CHECK (projection_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  inventory_watermark bigint NOT NULL CHECK (inventory_watermark >= 0),
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN (
    'REQUESTED', 'RUNNING', 'PASSED', 'BLOCKED', 'FAILED', 'EXPIRED', 'CONSUMED'
  )),
  source text NOT NULL DEFAULT 'HELPER' CHECK (source IN ('HELPER', 'OWNER_OVERRIDE')),
  requested_by smallint NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz,
  consumed_at timestamptz,
  blocker_code text,
  override_reason text,
  override_freshness_age_minutes integer CHECK (
    override_freshness_age_minutes IS NULL OR override_freshness_age_minutes >= 0
  ),
  request_json jsonb NOT NULL
);

CREATE UNIQUE INDEX aruba_preflight_receipts_active_revision_idx
  ON aruba_preflight_receipts
    (billing_case_id, document_id, draft_version, projection_sha256)
  WHERE status IN ('REQUESTED', 'RUNNING', 'PASSED');

CREATE INDEX aruba_preflight_receipts_pending_idx
  ON aruba_preflight_receipts (status, requested_at)
  WHERE status IN ('REQUESTED', 'RUNNING');

CREATE TABLE aruba_manual_readbacks (
  id uuid PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('SPECIFIC', 'FULL')),
  environment text NOT NULL CHECK (environment IN ('MOCK', 'PRODUCTION')),
  account_reference text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'VALID', 'REJECTED', 'FINALIZED')),
  coverage_json jsonb NOT NULL,
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  content_sha256 text CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  created_by smallint NOT NULL REFERENCES users(id),
  finalized_by smallint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  CONSTRAINT aruba_manual_readback_finalization_check CHECK (
    (status = 'FINALIZED' AND finalized_by IS NOT NULL AND finalized_at IS NOT NULL)
    OR status <> 'FINALIZED'
  )
);

CREATE TABLE aruba_manual_readback_pages (
  manual_readback_id uuid NOT NULL REFERENCES aruba_manual_readbacks(id) ON DELETE CASCADE,
  stream text NOT NULL,
  page_ordinal integer NOT NULL CHECK (page_ordinal > 0),
  cursor text,
  terminal boolean NOT NULL,
  row_count integer NOT NULL CHECK (row_count BETWEEN 0 AND 300),
  rows_json jsonb NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (manual_readback_id, stream, page_ordinal),
  UNIQUE (manual_readback_id, stream, payload_digest),
  CONSTRAINT aruba_manual_page_rows_check CHECK (
    jsonb_typeof(rows_json) = 'array' AND jsonb_array_length(rows_json) = row_count
  )
);

ALTER TABLE documents DROP CONSTRAINT documents_historical_origin_check;
ALTER TABLE documents ADD CONSTRAINT documents_historical_origin_check CHECK (
  origin = 'HUB'
  OR (origin = 'ARUBA_HISTORY' AND status = 'APPROVED'
      AND ((kind = 'INVOICE' AND document_type = 'TD01')
        OR (kind = 'CREDIT_NOTE' AND document_type = 'TD04')))
);
