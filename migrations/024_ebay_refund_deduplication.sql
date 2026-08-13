-- eBay può esporre lo stesso rimborso nel riepilogo pagamento, con ID autorevole,
-- e sulla riga articolo, senza ID. Le vecchie importazioni assegnavano al secondo
-- record un ID sintetico: lo rimuoviamo solo quando data e ordine coincidono con
-- un altro rimborso e nessun documento fiscale lo ha già assorbito.
DELETE FROM refunds AS synthetic
WHERE synthetic.provider = 'EBAY'
  AND synthetic.external_refund_id LIKE synthetic.external_order_id || '-refund-%'
  AND synthetic.credit_document_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM refunds AS authoritative
    WHERE authoritative.order_id = synthetic.order_id
      AND authoritative.id <> synthetic.id
      AND authoritative.completed_at IS NOT DISTINCT FROM synthetic.completed_at
      AND authoritative.external_refund_id NOT LIKE authoritative.external_order_id || '-refund-%'
  );
