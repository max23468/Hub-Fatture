ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
ALTER TABLE jobs
  ADD CONSTRAINT jobs_type_check CHECK (type IN (
    'shopify_sync_orders', 'shopify_process_webhook', 'ebay_sync_orders',
    'ebay_preview_history', 'process_refund', 'send_customer_email',
    'aruba_backfill_inventory', 'aruba_sync_inventory',
    'aruba_refresh_nonterminal', 'aruba_full_inventory',
    'aruba_dry_run_submission', 'maintenance_retention'
  ));

CREATE UNIQUE INDEX jobs_maintenance_retention_active_idx
  ON jobs (type)
  WHERE type = 'maintenance_retention' AND status IN ('PENDING', 'RUNNING');

ALTER TABLE operational_controls
  ADD COLUMN waiting_reason text,
  ADD COLUMN due_at timestamptz,
  ADD COLUMN assignee_user_id smallint REFERENCES users(id);

UPDATE operational_controls
SET waiting_reason = 'FOLLOW_UP',
    due_at = coalesce(waiting_at, now()) + interval '7 days'
WHERE state = 'WAITING';

ALTER TABLE operational_controls
  ADD CONSTRAINT operational_controls_waiting_reason_check CHECK (
    waiting_reason IS NULL OR waiting_reason IN (
      'PROVIDER', 'CUSTOMER', 'ACCOUNTING', 'TECHNICAL', 'FOLLOW_UP'
    )
  ),
  ADD CONSTRAINT operational_controls_waiting_metadata_check CHECK (
    (state = 'WAITING') = (waiting_reason IS NOT NULL AND due_at IS NOT NULL)
  );

CREATE INDEX operational_controls_due_idx
  ON operational_controls (due_at, severity, id)
  WHERE state = 'WAITING';

CREATE INDEX operational_controls_assignee_idx
  ON operational_controls (assignee_user_id, state, severity, opened_at, id)
  WHERE assignee_user_id IS NOT NULL;
