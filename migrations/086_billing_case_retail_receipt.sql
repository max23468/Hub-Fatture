ALTER TABLE billing_cases
  ADD COLUMN closed_as_retail_receipt boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT billing_cases_retail_receipt_archived_check CHECK (
    NOT closed_as_retail_receipt OR status = 'DO_NOT_TRANSMIT'
  );
