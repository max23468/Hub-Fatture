-- Rilegge una sola volta lo storico gia importato con i mapper fiscali correnti.
-- Il normale upsert degli ordini rende il replay idempotente; il margine evita
-- di perdere aggiornamenti esattamente sul limite inferiore della finestra.
WITH provider_windows AS (
  SELECT provider, min(updated_at_source) - interval '5 minutes' AS overlap_from
  FROM orders
  GROUP BY provider
)
INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
SELECT provider, 'orders', NULL, overlap_from
FROM provider_windows
ON CONFLICT (provider, stream) DO UPDATE SET
  cursor = NULL,
  overlap_from = CASE
    WHEN sync_cursors.overlap_from IS NULL
      OR sync_cursors.overlap_from > EXCLUDED.overlap_from
      THEN EXCLUDED.overlap_from
    ELSE sync_cursors.overlap_from
  END,
  updated_at = now();

-- Il worker schedula subito le connessioni con import storico completato. Un job
-- gia PENDING/RUNNING resta unico grazie all'indice parziale e leggerà il cursore
-- riavvolto quando viene eseguito o recuperato dopo la scadenza della lease.
UPDATE connections
SET last_synced_at = NULL,
    updated_at = now()
WHERE EXISTS (
    SELECT 1
    FROM orders
    WHERE orders.provider = connections.provider
      AND orders.external_account_id = connections.account_reference
  )
  AND EXISTS (
    SELECT 1
    FROM sync_cursors
    WHERE sync_cursors.provider = connections.provider
      AND sync_cursors.stream = 'history_import'
  );
