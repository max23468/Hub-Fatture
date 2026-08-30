ALTER TABLE customers DROP CONSTRAINT customers_kind_check;

ALTER TABLE customers
ADD CONSTRAINT customers_kind_check
CHECK (kind IN ('PRIVATE_IT', 'BUSINESS_IT', 'EU', 'NON_EU', 'UNKNOWN'));

-- Riparte dal primo payload non riconosciuto: il nuovo mapper può ora importare
-- gli ordini svizzeri senza confondere l'anomalia con la credenziale del canale.
WITH provider_windows AS (
  SELECT CASE
      WHEN type LIKE 'shopify_%' THEN 'SHOPIFY'
      WHEN type LIKE 'ebay_%' THEN 'EBAY'
    END AS provider,
    min(coalesce(locked_at, run_at, created_at)) - interval '5 minutes' AS overlap_from
  FROM jobs
  WHERE status = 'FAILED'
    AND last_error_code = 'PROVIDER_RESPONSE_INVALID'
    AND (type LIKE 'shopify_%' OR type LIKE 'ebay_%')
  GROUP BY 1
)
UPDATE sync_cursors
SET cursor = NULL,
    overlap_from = CASE
      WHEN sync_cursors.overlap_from IS NULL
        OR sync_cursors.overlap_from > provider_windows.overlap_from
        THEN provider_windows.overlap_from
      ELSE sync_cursors.overlap_from
    END,
    updated_at = now()
FROM provider_windows
WHERE sync_cursors.provider = provider_windows.provider
  AND sync_cursors.stream = 'orders';

UPDATE connections
SET status = 'CONNECTED',
    last_checked_at = now(),
    last_synced_at = NULL,
    last_error_code = NULL,
    last_error_message_sanitized = NULL,
    updated_at = now()
WHERE provider IN ('SHOPIFY', 'EBAY')
  AND status = 'ERROR'
  AND last_error_code = 'PROVIDER_RESPONSE_INVALID'
  AND EXISTS (
    SELECT 1
    FROM sync_cursors
    WHERE sync_cursors.provider = connections.provider
      AND sync_cursors.stream = 'history_import'
  );
