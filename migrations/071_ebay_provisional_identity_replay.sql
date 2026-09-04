-- Rilegge una sola volta la finestra degli ordini eBay provvisori ancora attivi.
-- Il normale import li consolida sull'identita di riga quando eBay espone
-- l'ordine Fulfillment definitivo; casi con legami fiscali restano fail-closed.
WITH affected_window AS (
  SELECT min(orders.updated_at_source) - interval '5 minutes' AS overlap_from
  FROM orders
  WHERE orders.provider = 'EBAY'
    AND orders.payment_status = 'PENDING'
    AND orders.cancelled_at IS NULL
    AND orders.raw_snapshot_json #>> '{sourceSnapshot,sourceApi}' = 'EBAY_TRADING'
    AND orders.updated_at_source >= now() - interval '30 days'
    AND EXISTS (
      SELECT 1 FROM order_source_identities
      WHERE order_source_identities.order_id = orders.id
        AND order_source_identities.provider = 'EBAY'
        AND order_source_identities.identity_kind = 'ORDER_LINE_ITEM'
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
