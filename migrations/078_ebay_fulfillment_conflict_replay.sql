-- Rilegge gli ordini eBay già trattenuti da un conflitto sorgente.
-- Il runtime chiude soltanto gli avanzamenti dell'evasione privi di altre variazioni
-- e lascia fail-closed ogni revisione economica, anagrafica o regressiva.
WITH affected_window AS (
  SELECT min(orders.updated_at_source) - interval '5 minutes' AS overlap_from
  FROM orders
  WHERE orders.provider = 'EBAY'
    AND coalesce(
      (orders.normalized_snapshot_json ->> 'sourceConflictRequired')::boolean,
      false
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
