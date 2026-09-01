-- Rilegge gli ordini Shopify interessati dalle due correzioni deterministiche:
-- conflitti dovuti alla sola evasione e identità fiscale disponibile su un
-- altro ordine dello stesso cliente sorgente.
WITH affected_window AS (
  SELECT min(orders.updated_at_source) - interval '5 minutes' AS overlap_from
  FROM orders
  WHERE orders.provider = 'SHOPIFY'
    AND (
      coalesce((orders.normalized_snapshot_json ->> 'sourceConflictRequired')::boolean, false)
      OR (
        NOT EXISTS (
          SELECT 1 FROM order_tax_identifiers current_tax
          WHERE current_tax.order_id = orders.id
        )
        AND nullif(orders.normalized_snapshot_json ->> 'externalCustomerId', '') IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM orders sibling
          JOIN order_tax_identifiers sibling_tax ON sibling_tax.order_id = sibling.id
          WHERE sibling.provider = orders.provider
            AND sibling.external_account_id = orders.external_account_id
            AND sibling.id <> orders.id
            AND sibling.normalized_snapshot_json ->> 'externalCustomerId'
              = orders.normalized_snapshot_json ->> 'externalCustomerId'
        )
      )
    )
)
INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
SELECT 'SHOPIFY', 'orders', NULL, overlap_from
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
WHERE provider = 'SHOPIFY'
  AND EXISTS (
    SELECT 1 FROM sync_cursors
    WHERE sync_cursors.provider = 'SHOPIFY'
      AND sync_cursors.stream = 'orders'
      AND sync_cursors.cursor IS NULL
  )
  AND EXISTS (
    SELECT 1 FROM sync_cursors
    WHERE sync_cursors.provider = 'SHOPIFY'
      AND sync_cursors.stream = 'history_import'
  );
