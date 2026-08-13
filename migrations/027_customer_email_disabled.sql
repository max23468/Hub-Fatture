ALTER TABLE documents
  DROP CONSTRAINT documents_customer_email_mode_check,
  ADD CONSTRAINT documents_customer_email_mode_check
    CHECK (customer_email_mode IN ('AUTOMATIC', 'MANUAL', 'DISABLED'));
