-- Rilegge la finestra Shopify con incassi Shopify Payments scostati di uno o due
-- centesimi dal totale ordine. Il payload provider resta autorevole: il nuovo mapper
-- conserva la valuta di presentazione e riconosce soltanto lo scarto di conversione,
-- senza cambiare il totale fatturabile.
WITH affected_window AS (
  SELECT min(orders.updated_at_source) - interval '5 minutes' AS overlap_from
  FROM orders
  WHERE orders.provider = 'SHOPIFY'
    AND NOT coalesce(
      (orders.normalized_snapshot_json ->> 'totalsReconciled')::boolean,
      false
    )
    AND (
      SELECT coalesce(sum(order_lines.gross_amount - order_lines.discount_amount), 0)
      FROM order_lines
      WHERE order_lines.order_id = orders.id
    ) + coalesce(
      (orders.normalized_snapshot_json ->> 'shippingAmount')::integer,
      0
    ) = orders.gross_amount
    AND EXISTS (
      SELECT 1 FROM payments
      WHERE payments.order_id = orders.id
        AND payments.status = 'PAID'
        AND lower(payments.method) = 'shopify_payments'
    )
    AND NOT EXISTS (
      SELECT 1 FROM payments
      WHERE payments.order_id = orders.id
        AND payments.status = 'PAID'
        AND lower(payments.method) <> 'shopify_payments'
    )
    AND abs((
      SELECT coalesce(sum(payments.amount), 0)
      FROM payments
      WHERE payments.order_id = orders.id AND payments.status = 'PAID'
    ) - orders.gross_amount) BETWEEN 1 AND 2
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
