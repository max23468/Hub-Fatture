-- Acconto e saldo emessi come TD01 distinte possono coprire lo stesso ordine soltanto se
-- ogni collegamento è marcato come rata: per tutti gli altri documenti l'unicità della
-- fattura efficace resta invariata.
ALTER TABLE document_orders
  ADD COLUMN split_invoice boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION reject_multiple_effective_invoice_orders() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.document_kind <> 'INVOICE' THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('effective-invoice-order:' || NEW.order_id::text, 0)
  );
  IF EXISTS (
    SELECT 1
    FROM document_orders AS existing_link
    JOIN documents AS existing_document ON existing_document.id = existing_link.document_id
    WHERE existing_link.order_id = NEW.order_id
      AND existing_link.document_kind = 'INVOICE'
      AND existing_link.document_id <> NEW.document_id
      AND NOT (NEW.split_invoice AND existing_link.split_invoice)
      AND (
        existing_document.status = 'DRAFT'
        OR (
          existing_document.status = 'APPROVED'
          AND (
            NOT EXISTS (
              SELECT 1 FROM aruba_submissions
              WHERE aruba_submissions.document_id = existing_document.id
            )
            OR EXISTS (
              SELECT 1 FROM aruba_submissions
              WHERE aruba_submissions.document_id = existing_document.id
                AND aruba_submissions.status <> 'REJECTED'
            )
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'Ordine già collegato a una fattura efficace o modificabile';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER document_orders_effective_invoice_unique ON document_orders;

CREATE TRIGGER document_orders_effective_invoice_unique
  BEFORE INSERT OR UPDATE OF document_id, document_kind, order_id, split_invoice
  ON document_orders
  FOR EACH ROW EXECUTE FUNCTION reject_multiple_effective_invoice_orders();

-- Una combinazione acconto/saldo ancora priva di XML ufficiale trattiene la preparazione e
-- guida il recupero mirato dei file. Il riconciliatore la ricalcola a ogni run Aruba.
CREATE TABLE aruba_split_invoice_candidates (
  billing_case_id bigint PRIMARY KEY REFERENCES billing_cases(id) ON DELETE CASCADE,
  environment text NOT NULL,
  account_reference text NOT NULL,
  order_id bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  remote_document_ids bigint[] NOT NULL
    CHECK (cardinality(remote_document_ids) BETWEEN 2 AND 3),
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_detected_at timestamptz NOT NULL DEFAULT now()
);
