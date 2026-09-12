-- Rilegge gli ordini eBay aperti il cui nome registrato dall'acquirente differisce
-- dall'intestazione della preparazione. Il mapper aggiornato usa il nome registrato soltanto
-- quando il codice fiscale lo conferma e il nome di spedizione non viene riconosciuto; la
-- rilettura dello stesso payload riallinea automaticamente la preparazione non corretta.
WITH affected_window AS (
  SELECT min(orders.updated_at_source) - interval '5 minutes' AS overlap_from
  FROM orders
  JOIN billing_cases ON billing_cases.id = orders.billing_case_id
  WHERE orders.provider = 'EBAY'
    AND billing_cases.status IN ('DRAFT', 'READY', 'NEEDS_REVIEW')
    AND billing_cases.customer_corrected_at IS NULL
    AND orders.raw_snapshot_json #>>
      '{sourceSnapshot,buyer,taxIdentifier,taxIdentifierType}' = 'CODICE_FISCALE'
    AND nullif(btrim(orders.raw_snapshot_json #>>
      '{sourceSnapshot,buyer,buyerRegistrationAddress,fullName}'), '') IS NOT NULL
    AND lower(btrim(orders.raw_snapshot_json #>>
      '{sourceSnapshot,buyer,buyerRegistrationAddress,fullName}'))
      IS DISTINCT FROM lower(btrim(orders.normalized_snapshot_json #>>
        '{customerSnapshot,displayName}'))
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
