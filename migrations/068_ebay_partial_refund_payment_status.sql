-- Un rimborso parziale presuppone un incasso concluso: il rimborso resta modellato
-- separatamente e non deve trasformare il saldo dell'ordine in un pagamento pendente.
UPDATE orders
SET payment_status = 'PAID',
    raw_snapshot_json = jsonb_set(raw_snapshot_json, '{paymentStatus}', '"PAID"'::jsonb),
    normalized_snapshot_json = jsonb_set(
      normalized_snapshot_json,
      '{paymentStatus}',
      '"PAID"'::jsonb
    )
WHERE provider = 'EBAY'
  AND payment_status = 'PENDING'
  AND raw_snapshot_json #>> '{sourceSnapshot,orderPaymentStatus}' = 'PARTIALLY_REFUNDED';
