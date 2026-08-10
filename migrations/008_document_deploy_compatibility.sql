LOCK TABLE documents IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE documents DISABLE TRIGGER documents_approved_immutable;

UPDATE documents
SET payment_status = CASE
      WHEN EXISTS (
        SELECT 1
        FROM document_orders
        JOIN orders ON orders.id = document_orders.order_id
        WHERE document_orders.document_id = documents.id
          AND orders.payment_status = 'PENDING'
      ) THEN 'PENDING'
      ELSE 'PAID'
    END,
    payment_method = CASE documents.kind
      WHEN 'CREDIT_NOTE' THEN fiscal_profiles.profile_json #>> '{payment,creditNoteMethod}'
      ELSE fiscal_profiles.profile_json #>> '{payment,invoiceMethod}'
    END
FROM fiscal_profiles
WHERE documents.fiscal_profile_version = fiscal_profiles.version;

UPDATE documents
SET immutable_snapshot_json = jsonb_set(
      jsonb_set(immutable_snapshot_json, '{paymentStatus}', to_jsonb(payment_status), true),
      '{paymentMethod}', to_jsonb(payment_method), true
    )
WHERE status = 'APPROVED';

ALTER TABLE documents ENABLE TRIGGER documents_approved_immutable;

ALTER TABLE documents
  ALTER COLUMN payment_status DROP DEFAULT,
  ALTER COLUMN payment_method DROP DEFAULT;

CREATE FUNCTION derive_document_defaults() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payment_status IS NULL THEN
    NEW.payment_status := CASE WHEN EXISTS (
      SELECT 1 FROM orders
      WHERE billing_case_id = NEW.billing_case_id AND payment_status = 'PENDING'
    ) THEN 'PENDING' ELSE 'PAID' END;
  END IF;
  IF NEW.payment_method IS NULL THEN
    SELECT CASE NEW.kind
      WHEN 'CREDIT_NOTE' THEN profile_json #>> '{payment,creditNoteMethod}'
      ELSE profile_json #>> '{payment,invoiceMethod}'
    END
    INTO NEW.payment_method
    FROM fiscal_profiles
    WHERE version = NEW.fiscal_profile_version;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER documents_derive_defaults
  BEFORE INSERT ON documents
  FOR EACH ROW EXECUTE FUNCTION derive_document_defaults();
