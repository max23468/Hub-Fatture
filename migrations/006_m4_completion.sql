ALTER TABLE documents
  ADD COLUMN payment_status text NOT NULL DEFAULT 'PAID'
    CHECK (payment_status IN ('PAID', 'PENDING')),
  ADD COLUMN payment_method text NOT NULL DEFAULT 'MP08'
    CHECK (payment_method ~ '^MP(01|05|08)$'),
  ADD COLUMN causale text CHECK (char_length(causale) <= 200),
  ADD COLUMN notes text CHECK (char_length(notes) <= 200);

CREATE OR REPLACE FUNCTION reject_approved_document_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'APPROVED' THEN
    RAISE EXCEPTION 'Un documento approvato è immutabile';
  END IF;
  RETURN coalesce(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION reject_approved_document_children_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
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
