ALTER TABLE documents ADD COLUMN recipient_snapshot_json jsonb;

ALTER TABLE documents DISABLE TRIGGER documents_approved_immutable;

UPDATE documents
SET recipient_snapshot_json = CASE
      WHEN documents.status = 'APPROVED' THEN documents.immutable_snapshot_json -> 'recipient'
      ELSE billing_cases.customer_snapshot_json
    END
FROM billing_cases
WHERE billing_cases.id = documents.billing_case_id;

ALTER TABLE documents ENABLE TRIGGER documents_approved_immutable;

ALTER TABLE documents ALTER COLUMN recipient_snapshot_json SET NOT NULL;

CREATE OR REPLACE FUNCTION derive_document_defaults() RETURNS trigger
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
  IF NEW.recipient_snapshot_json IS NULL THEN
    SELECT customer_snapshot_json INTO NEW.recipient_snapshot_json
    FROM billing_cases WHERE id = NEW.billing_case_id;
  END IF;
  RETURN NEW;
END;
$$;
