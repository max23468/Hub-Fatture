-- Motivazioni e riferimenti inseriti dal titolare non hanno una lunghezza minima: basta che
-- non siano vuoti.
ALTER TABLE orders DROP CONSTRAINT orders_historical_reconciliation_reference_check;
ALTER TABLE orders ADD CONSTRAINT orders_historical_reconciliation_reference_check
  CHECK (length(btrim(historical_reconciliation_reference)) BETWEEN 1 AND 500);
