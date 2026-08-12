-- Rilegge una sola volta gli ordini Shopify con il mapper destinatari corrente.
-- Il normale upsert resta idempotente e conserva lo snapshot sorgente originale;
-- il margine evita di perdere aggiornamenti sul limite inferiore della finestra.
WITH provider_window AS (
  SELECT min(updated_at_source) - interval '5 minutes' AS overlap_from
  FROM orders
  WHERE provider = 'SHOPIFY'
)
INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
SELECT 'SHOPIFY', 'orders', NULL, overlap_from
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

-- Il worker rende subito schedulabile la connessione Shopify già importata.
-- Un job PENDING/RUNNING resta unico grazie all'indice parziale esistente.
UPDATE connections
SET last_synced_at = NULL,
    updated_at = now()
WHERE provider = 'SHOPIFY'
  AND EXISTS (
    SELECT 1
    FROM orders
    WHERE orders.provider = 'SHOPIFY'
      AND orders.external_account_id = connections.account_reference
  )
  AND EXISTS (
    SELECT 1
    FROM sync_cursors
    WHERE sync_cursors.provider = 'SHOPIFY'
      AND sync_cursors.stream = 'history_import'
  );
