-- Rilegge soltanto gli ordini eBay con rimborsi ancora privi di un importo
-- cliente autorevole. Il mapper risolve esclusivamente quelli le cui quote di
-- riga ricostruiscono esattamente l'intera spedizione netta.
WITH affected_window AS (
  SELECT min(orders.updated_at_source) - interval '5 minutes' AS overlap_from
  FROM orders
  WHERE orders.provider = 'EBAY'
    AND EXISTS (
      SELECT 1
      FROM refunds
      WHERE refunds.order_id = orders.id
        AND refunds.status = 'AMBIGUOUS'
        AND refunds.amount IS NULL
    )
)
INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
SELECT 'EBAY', 'orders', NULL, overlap_from
FROM affected_window
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
    SELECT 1 FROM sync_cursors
    WHERE sync_cursors.provider = 'EBAY'
      AND sync_cursors.stream = 'orders'
      AND sync_cursors.cursor IS NULL
  )
  AND EXISTS (
    SELECT 1 FROM sync_cursors
    WHERE sync_cursors.provider = 'EBAY'
      AND sync_cursors.stream = 'history_import'
  );
