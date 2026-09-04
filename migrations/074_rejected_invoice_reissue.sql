-- Uno stesso ordine può essere rifatturato solo dopo uno scarto SdI autorevole.
-- L'unicità effettiva resta applicata sotto lock dal dominio; il collegamento alla
-- fattura scartata rimane nello storico immutabile insieme a quello della riemissione.
DROP INDEX document_orders_one_invoice_idx;

CREATE FUNCTION reject_multiple_effective_invoice_orders() RETURNS trigger
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

CREATE TRIGGER document_orders_effective_invoice_unique
  BEFORE INSERT OR UPDATE OF document_id, document_kind, order_id ON document_orders
  FOR EACH ROW EXECUTE FUNCTION reject_multiple_effective_invoice_orders();
