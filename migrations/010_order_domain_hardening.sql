ALTER TABLE order_lines
  ADD CONSTRAINT order_lines_discount_not_above_gross
  CHECK (discount_amount <= gross_amount);

ALTER TABLE order_tax_identifiers
  ADD COLUMN country_code text CHECK (country_code ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT order_tax_identifiers_type_check
    CHECK (type IN ('CODICE_FISCALE', 'PARTITA_IVA', 'ALTRO'));

ALTER TABLE order_tax_identifiers
  DROP CONSTRAINT order_tax_identifiers_order_id_type_normalized_value_key;

CREATE UNIQUE INDEX order_tax_identifiers_identity_idx
  ON order_tax_identifiers (order_id, type, coalesce(country_code, ''), normalized_value);
