ALTER TABLE jobs
  DROP CONSTRAINT jobs_type_check,
  ADD CONSTRAINT jobs_type_check CHECK (
    type IN ('shopify_sync_orders', 'shopify_process_webhook', 'ebay_sync_orders', 'ebay_preview_history')
  ),
  ADD COLUMN claim_token uuid,
  ADD COLUMN result_json jsonb NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX jobs_ebay_preview_idx
  ON jobs (type)
  WHERE type = 'ebay_preview_history' AND status IN ('PENDING', 'RUNNING');
