CREATE TABLE aruba_canary_permits (
  id uuid PRIMARY KEY,
  environment text NOT NULL CHECK (environment = 'PRODUCTION'),
  account_reference text NOT NULL CHECK (length(account_reference) BETWEEN 1 AND 200),
  document_id bigint NOT NULL REFERENCES documents(id),
  document_revision integer NOT NULL CHECK (document_revision > 0),
  batch_id uuid NOT NULL REFERENCES aruba_batches(id) ON DELETE RESTRICT,
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  xml_sha256 text NOT NULL CHECK (xml_sha256 ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  expired_at timestamptz,
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aruba_canary_permits_time_check CHECK (
    expires_at > created_at
    AND (consumed_at IS NULL OR consumed_at >= created_at)
    AND (expired_at IS NULL OR expired_at >= created_at)
    AND num_nonnulls(consumed_at, expired_at) <= 1
  )
);

CREATE UNIQUE INDEX aruba_canary_permits_active_idx
  ON aruba_canary_permits ((true))
  WHERE consumed_at IS NULL AND expired_at IS NULL;

CREATE UNIQUE INDEX aruba_canary_permits_consumed_idx
  ON aruba_canary_permits ((true))
  WHERE consumed_at IS NOT NULL;

CREATE INDEX aruba_canary_permits_batch_idx
  ON aruba_canary_permits (batch_id);

ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
ALTER TABLE jobs
  ADD CONSTRAINT jobs_type_check CHECK (type IN (
    'shopify_sync_orders', 'shopify_process_webhook', 'ebay_sync_orders',
    'ebay_preview_history', 'process_refund', 'send_customer_email',
    'aruba_backfill_inventory', 'aruba_sync_inventory',
    'aruba_refresh_nonterminal', 'aruba_full_inventory',
    'aruba_dry_run_submission', 'aruba_send_submission'
  ));

CREATE UNIQUE INDEX jobs_aruba_send_active_idx
  ON jobs (type, (payload_json ->> 'submissionId'))
  WHERE type = 'aruba_send_submission' AND status IN ('PENDING', 'RUNNING');
