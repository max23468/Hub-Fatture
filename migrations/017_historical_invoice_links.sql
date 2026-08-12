ALTER TABLE documents
  ADD COLUMN origin text NOT NULL DEFAULT 'HUB'
    CHECK (origin IN ('HUB', 'ARUBA_HISTORY')),
  ADD CONSTRAINT documents_historical_origin_check CHECK (
    origin = 'HUB' OR (kind = 'INVOICE' AND document_type = 'TD01' AND status = 'APPROVED')
  );

CREATE OR REPLACE FUNCTION reject_approved_document_children_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'document_orders' AND TG_OP = 'INSERT' AND EXISTS (
    SELECT 1 FROM documents
    WHERE id = NEW.document_id AND origin = 'ARUBA_HISTORY'
  ) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM documents
    WHERE status = 'APPROVED'
      AND id IN (OLD.document_id, NEW.document_id)
  ) THEN
    RAISE EXCEPTION 'Le righe di un documento approvato sono immutabili';
  END IF;
  RETURN coalesce(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION validate_credit_note_link() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  credit_kind text;
  credit_status text;
  invoice_kind text;
  invoice_status text;
  invoice_origin text;
BEGIN
  SELECT kind, status INTO credit_kind, credit_status FROM documents WHERE id = NEW.document_id;
  SELECT kind, status, origin INTO invoice_kind, invoice_status, invoice_origin
  FROM documents WHERE id = NEW.related_document_id;
  IF credit_kind <> 'CREDIT_NOTE' OR credit_status <> 'DRAFT'
     OR invoice_kind <> 'INVOICE' OR invoice_status <> 'APPROVED' THEN
    RAISE EXCEPTION 'Collegamento nota di credito non valido';
  END IF;
  IF invoice_origin <> 'ARUBA_HISTORY' AND NOT EXISTS (
    SELECT 1 FROM aruba_submissions
    WHERE document_id = NEW.related_document_id
      AND status IN ('DELIVERED', 'NOT_DELIVERED')
  ) THEN
    RAISE EXCEPTION 'La fattura originaria non risulta emessa';
  END IF;
  RETURN NEW;
END;
$$;
