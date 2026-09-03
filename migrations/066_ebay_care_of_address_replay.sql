-- Rilegge gli ordini eBay il cui destinatario contiene un riferimento "c/o".
-- Il mapper aggiornato conserva il nome prima del marcatore e sposta il riferimento
-- completo nella seconda riga dell'indirizzo, senza sovrascrivere quella esistente.
WITH affected_window AS (
  SELECT min(updated_at_source) - interval '5 minutes' AS overlap_from
  FROM orders
  LEFT JOIN billing_cases ON billing_cases.id = orders.billing_case_id
  WHERE provider = 'EBAY'
    AND billing_cases.customer_corrected_at IS NULL
    AND raw_snapshot_json #>>
      '{sourceSnapshot,fulfillmentStartInstructions,0,shippingStep,shipTo,fullName}'
      ~* '[[:space:]]c[[:space:]]*/[[:space:]]*o[[:space:]]'
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
