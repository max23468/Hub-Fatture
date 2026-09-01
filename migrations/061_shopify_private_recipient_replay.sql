-- Rilegge soltanto la finestra Shopify che può contenere privati italiani
-- classificati come azienda perché il campo company era stato usato come testo libero.
WITH affected_window AS (
  SELECT min(orders.updated_at_source) - interval '5 minutes' AS overlap_from
  FROM orders
  WHERE orders.provider = 'SHOPIFY'
    AND orders.normalized_snapshot_json #>> '{customerSnapshot,kind}' = 'BUSINESS_IT'
    AND nullif(orders.normalized_snapshot_json #>> '{customerSnapshot,firstName}', '') IS NOT NULL
    AND nullif(orders.normalized_snapshot_json #>> '{customerSnapshot,lastName}', '') IS NOT NULL
    AND orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,countryCode}' = 'IT'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        coalesce(orders.normalized_snapshot_json #> '{customerSnapshot,taxIdentifiers}', '[]'::jsonb)
      ) AS identifier
      WHERE identifier ->> 'type' = 'CODICE_FISCALE'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        coalesce(orders.normalized_snapshot_json #> '{customerSnapshot,taxIdentifiers}', '[]'::jsonb)
      ) AS identifier
      WHERE identifier ->> 'type' = 'PARTITA_IVA'
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
