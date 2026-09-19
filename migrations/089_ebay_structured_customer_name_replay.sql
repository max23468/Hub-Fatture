-- Il replay del nome registrato introdotto dalla 1.3.32 selezionava soltanto i casi in cui
-- l'intestazione eBay differiva dal nome già mostrato. Rilegge anche le preparazioni aperte
-- dove l'intestazione coincide, ma nome e cognome strutturati sono ancora assenti.
WITH affected_window AS (
  SELECT min(orders.updated_at_source) - interval '5 minutes' AS overlap_from
  FROM orders
  JOIN billing_cases ON billing_cases.id = orders.billing_case_id
  WHERE orders.provider = 'EBAY'
    AND billing_cases.status IN ('DRAFT', 'READY', 'NEEDS_REVIEW')
    AND billing_cases.customer_corrected_at IS NULL
    AND coalesce(
      (orders.normalized_snapshot_json ->> 'customerReviewRequired')::boolean,
      false
    )
    AND orders.raw_snapshot_json #>> '{customer,kind}' = 'PRIVATE_IT'
    AND nullif(btrim(orders.raw_snapshot_json #>> '{customer,displayName}'), '') IS NOT NULL
    AND nullif(btrim(orders.normalized_snapshot_json #>>
      '{customerSnapshot,firstName}'), '') IS NULL
    AND nullif(btrim(orders.normalized_snapshot_json #>>
      '{customerSnapshot,lastName}'), '') IS NULL
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(coalesce(
        orders.raw_snapshot_json #> '{customer,taxIdentifiers}', '[]'::jsonb
      )) AS identifier
      WHERE identifier ->> 'type' = 'CODICE_FISCALE'
        AND identifier ->> 'countryCode' = 'IT'
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
