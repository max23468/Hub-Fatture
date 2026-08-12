ALTER TABLE orders
  ADD COLUMN historical_reconciliation_outcome text
    CHECK (historical_reconciliation_outcome IN ('ALREADY_INVOICED', 'NOT_INVOICED')),
  ADD COLUMN historical_reconciliation_reference text
    CHECK (length(historical_reconciliation_reference) BETWEEN 10 AND 500),
  ADD COLUMN historical_reconciled_at timestamptz,
  ADD CONSTRAINT orders_historical_reconciliation_complete CHECK (
    (historical_reconciliation_outcome IS NULL
      AND historical_reconciliation_reference IS NULL
      AND historical_reconciled_at IS NULL)
    OR
    (historical_reconciliation_outcome IS NOT NULL
      AND historical_reconciliation_reference IS NOT NULL
      AND historical_reconciled_at IS NOT NULL
      AND coalesce((normalized_snapshot_json ->> 'historical')::boolean, false))
  );

UPDATE jobs
SET status = 'COMPLETED',
    completed_at = now(),
    lease_expires_at = NULL,
    locked_by = NULL,
    claim_token = NULL,
    last_error_code = NULL,
    result_json = result_json || '{"obsoleteBeforeHistoryImport": true}'::jsonb
WHERE type IN ('shopify_sync_orders', 'ebay_sync_orders')
  AND status IN ('PENDING', 'RUNNING');
