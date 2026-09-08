-- Il vecchio mapper serializzava l'oggetto primaryPhone come testo. Elimina il
-- segnaposto dai dati derivati e rilegge gli ordini entro la finestra provider,
-- così il mapper corretto ripristina il numero dal payload grezzo autorevole.
WITH affected_window AS (
  SELECT min(updated_at_source) - interval '5 minutes' AS overlap_from
  FROM orders
  WHERE provider = 'EBAY'
    AND (
      raw_snapshot_json #>> '{customer,phone}' = '[object Object]'
      OR normalized_snapshot_json #>> '{customer,phone}' = '[object Object]'
      OR normalized_snapshot_json #>> '{customerSnapshot,phone}' = '[object Object]'
      OR normalized_snapshot_json #>> '{customerSnapshot,canonicalProfile,phone}' =
        '[object object]'
    )
    AND nullif(btrim(raw_snapshot_json #>>
      '{sourceSnapshot,fulfillmentStartInstructions,0,shippingStep,shipTo,primaryPhone,phoneNumber}'),
      '') IS NOT NULL
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
    SELECT 1 FROM orders
    WHERE orders.provider = 'EBAY'
      AND (
        orders.raw_snapshot_json #>> '{customer,phone}' = '[object Object]'
        OR orders.normalized_snapshot_json #>> '{customer,phone}' = '[object Object]'
        OR orders.normalized_snapshot_json #>> '{customerSnapshot,phone}' =
          '[object Object]'
        OR orders.normalized_snapshot_json #>>
          '{customerSnapshot,canonicalProfile,phone}' = '[object object]'
      )
      AND nullif(btrim(orders.raw_snapshot_json #>>
        '{sourceSnapshot,fulfillmentStartInstructions,0,shippingStep,shipTo,primaryPhone,phoneNumber}'),
        '') IS NOT NULL
  )
  AND EXISTS (
    SELECT 1 FROM sync_cursors
    WHERE sync_cursors.provider = 'EBAY'
      AND sync_cursors.stream = 'history_import'
  );

-- Il marcatore esatto è l'output deterministico del vecchio mapper e non è un
-- numero valido. Le proiezioni condivise non conservano il provider d'origine.
UPDATE customers
SET phone = NULL,
    updated_at = now()
WHERE phone = '[object Object]';

UPDATE customer_source_records
SET raw_snapshot_json = raw_snapshot_json - 'phone'
WHERE provider = 'EBAY'
  AND raw_snapshot_json ->> 'phone' = '[object Object]';

UPDATE billing_cases
SET customer_snapshot_json = customer_snapshot_json - 'phone'
WHERE customer_snapshot_json ->> 'phone' = '[object Object]';

UPDATE billing_cases
SET customer_snapshot_json = jsonb_set(
      customer_snapshot_json,
      '{canonicalProfile,phone}',
      '""'::jsonb,
      false
    )
WHERE customer_snapshot_json #>> '{canonicalProfile,phone}' = '[object object]';

UPDATE orders
SET raw_snapshot_json = raw_snapshot_json #- '{customer,phone}'
WHERE provider = 'EBAY'
  AND raw_snapshot_json #>> '{customer,phone}' = '[object Object]';

UPDATE orders
SET normalized_snapshot_json = normalized_snapshot_json #- '{customer,phone}'
WHERE provider = 'EBAY'
  AND normalized_snapshot_json #>> '{customer,phone}' = '[object Object]';

UPDATE orders
SET normalized_snapshot_json = normalized_snapshot_json #- '{customerSnapshot,phone}'
WHERE provider = 'EBAY'
  AND normalized_snapshot_json #>> '{customerSnapshot,phone}' = '[object Object]';

UPDATE orders
SET normalized_snapshot_json = jsonb_set(
      normalized_snapshot_json,
      '{customerSnapshot,canonicalProfile,phone}',
      '""'::jsonb,
      false
    )
WHERE provider = 'EBAY'
  AND normalized_snapshot_json #>> '{customerSnapshot,canonicalProfile,phone}' =
    '[object object]';
