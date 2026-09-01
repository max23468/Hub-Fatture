ALTER TABLE customer_identity_exceptions
  ADD COLUMN decision_mode text NOT NULL DEFAULT 'MANUAL'
    CHECK (decision_mode IN ('AUTOMATIC', 'MANUAL'));

ALTER TABLE customer_identity_exceptions
  ALTER COLUMN accepted_by DROP NOT NULL;

ALTER TABLE customer_identity_exceptions
  ADD CONSTRAINT customer_identity_exceptions_actor_check CHECK (
    (decision_mode = 'AUTOMATIC' AND accepted_by IS NULL)
    OR (decision_mode = 'MANUAL' AND accepted_by IS NOT NULL)
  );

-- Il replay applica la nuova regola anche agli ordini eBay già osservati. Il
-- margine protegge il limite inferiore della finestra senza riscrivere snapshot.
WITH provider_window AS (
  SELECT min(updated_at_source) - interval '5 minutes' AS overlap_from
  FROM orders
  WHERE provider = 'EBAY'
)
INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
SELECT 'EBAY', 'orders', NULL, overlap_from
FROM provider_window
WHERE overlap_from IS NOT NULL
ON CONFLICT (provider, stream) DO UPDATE SET
  cursor = NULL,
  overlap_from = CASE
    WHEN sync_cursors.overlap_from IS NULL
      OR sync_cursors.overlap_from > EXCLUDED.overlap_from
      THEN EXCLUDED.overlap_from
    ELSE sync_cursors.overlap_from
  END,
  updated_at = now();

UPDATE connections
SET last_synced_at = NULL,
    updated_at = now()
WHERE provider = 'EBAY'
  AND EXISTS (
    SELECT 1 FROM orders
    WHERE orders.provider = 'EBAY'
      AND orders.external_account_id = connections.account_reference
  )
  AND EXISTS (
    SELECT 1 FROM sync_cursors
    WHERE sync_cursors.provider = 'EBAY'
      AND sync_cursors.stream = 'history_import'
  );
