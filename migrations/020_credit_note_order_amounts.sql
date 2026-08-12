CREATE FUNCTION invoice_order_issued_amount(invoice_id bigint, source_order_id bigint)
RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN documents.origin = 'ARUBA_HISTORY' THEN (
      SELECT document_orders.amount
      FROM document_orders
      WHERE document_orders.document_id = documents.id
        AND document_orders.document_kind = 'INVOICE'
        AND document_orders.order_id = source_order_id
    )
    ELSE (
      SELECT sum(document_lines.total_amount)::integer
      FROM document_lines
      WHERE document_lines.document_id = documents.id
        AND document_lines.order_id = source_order_id
    )
  END
  FROM documents
  WHERE documents.id = invoice_id AND documents.kind = 'INVOICE'
$$;

CREATE OR REPLACE FUNCTION account_refund_credit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  new_invoice bigint;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.credit_document_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM documents WHERE id = OLD.credit_document_id AND status = 'APPROVED')
     AND (TG_OP = 'DELETE'
       OR NEW.credit_document_id IS DISTINCT FROM OLD.credit_document_id
       OR NEW.amount IS DISTINCT FROM OLD.amount
       OR NEW.status IS DISTINCT FROM OLD.status) THEN
    RAISE EXCEPTION 'Un rimborso incluso in una nota emessa è immutabile';
  END IF;

  IF TG_OP <> 'DELETE' AND NEW.credit_document_id IS NOT NULL THEN
    IF NEW.status <> 'COMPLETED' OR NEW.amount IS NULL OR NEW.amount <= 0 THEN
      RAISE EXCEPTION 'Solo un rimborso completato e certo può entrare in nota';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM documents WHERE id = NEW.credit_document_id
        AND kind = 'CREDIT_NOTE' AND status = 'DRAFT'
    ) THEN
      RAISE EXCEPTION 'La nota cumulativa non è modificabile';
    END IF;
    new_invoice := credit_note_invoice_id(NEW.credit_document_id);
    IF new_invoice IS NULL OR NOT EXISTS (
      SELECT 1 FROM document_orders
      WHERE document_id = new_invoice AND document_kind = 'INVOICE' AND order_id = NEW.order_id
    ) THEN
      RAISE EXCEPTION 'Il rimborso non appartiene alla fattura originaria';
    END IF;
  END IF;
  RETURN coalesce(NEW, OLD);
END;
$$;

CREATE FUNCTION account_credit_note_order_amount() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_invoice bigint;
  new_invoice bigint;
  invoice_order_amount integer;
  already_credited integer;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.document_kind = 'CREDIT_NOTE' THEN
    old_invoice := credit_note_invoice_id(OLD.document_id);
    UPDATE credit_note_balances
    SET credited_amount = credited_amount - OLD.amount
    WHERE invoice_document_id = old_invoice;
  END IF;

  IF TG_OP <> 'DELETE' AND NEW.document_kind = 'CREDIT_NOTE' THEN
    new_invoice := credit_note_invoice_id(NEW.document_id);
    invoice_order_amount := invoice_order_issued_amount(new_invoice, NEW.order_id);
    IF invoice_order_amount IS NULL THEN
      RAISE EXCEPTION 'La nota non appartiene alla fattura originaria';
    END IF;

    IF TG_OP = 'UPDATE' THEN
      SELECT coalesce(sum(amount), 0)::integer INTO already_credited
      FROM document_orders
      WHERE document_kind = 'CREDIT_NOTE' AND order_id = NEW.order_id
        AND NOT (document_id = OLD.document_id AND order_id = OLD.order_id);
    ELSE
      SELECT coalesce(sum(amount), 0)::integer INTO already_credited
      FROM document_orders
      WHERE document_kind = 'CREDIT_NOTE' AND order_id = NEW.order_id;
    END IF;
    IF already_credited + NEW.amount > invoice_order_amount THEN
      RAISE EXCEPTION 'Il totale delle note supera l’importo fatturato per l’ordine';
    END IF;

    UPDATE credit_note_balances
    SET credited_amount = credited_amount + NEW.amount
    WHERE invoice_document_id = new_invoice
      AND credited_amount + NEW.amount <= invoice_total;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Il totale delle note supera la fattura originaria';
    END IF;
  END IF;
  RETURN coalesce(NEW, OLD);
END;
$$;

CREATE TRIGGER document_orders_account_credit
  BEFORE INSERT OR UPDATE OR DELETE ON document_orders
  FOR EACH ROW EXECUTE FUNCTION account_credit_note_order_amount();

CREATE OR REPLACE FUNCTION credit_note_total_matches(credit_id bigint) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT documents.kind <> 'CREDIT_NOTE' OR (
    credit_note_invoice_id(documents.id) IS NOT NULL
    AND documents.total_amount > 0
    AND documents.total_amount = coalesce((
      SELECT sum(document_orders.amount) FROM document_orders
      WHERE document_orders.document_id = documents.id
        AND document_orders.document_kind = 'CREDIT_NOTE'
    ), 0)
    AND documents.total_amount = coalesce((
      SELECT sum(CASE
        WHEN (orders.provider = 'SHOPIFY'
          AND orders.deducted_shopify_payments_fee_amount > 0)
          OR invoice_order_issued_amount(
            document_links.related_document_id,
            refund_totals.order_id
          ) <> invoice_order.amount
        THEN least(
          refund_totals.amount,
          invoice_order_issued_amount(
            document_links.related_document_id,
            refund_totals.order_id
          ) - approved_credit.amount
        )
        ELSE refund_totals.amount
      END)
      FROM (
        SELECT refunds.order_id, sum(refunds.amount)::integer AS amount
        FROM refunds
        WHERE refunds.credit_document_id = documents.id
        GROUP BY refunds.order_id
      ) AS refund_totals
      JOIN orders ON orders.id = refund_totals.order_id
      JOIN document_links ON document_links.document_id = documents.id
        AND document_links.relation_type = 'CREDIT_NOTE_FOR_INVOICE'
      JOIN document_orders AS invoice_order
        ON invoice_order.document_id = document_links.related_document_id
       AND invoice_order.document_kind = 'INVOICE'
       AND invoice_order.order_id = refund_totals.order_id
      LEFT JOIN LATERAL (
        SELECT coalesce(sum(credit_order.amount), 0)::integer AS amount
        FROM document_orders AS credit_order
        JOIN documents AS approved_document
          ON approved_document.id = credit_order.document_id
         AND approved_document.status = 'APPROVED'
         AND approved_document.id <> documents.id
        WHERE credit_order.order_id = refund_totals.order_id
          AND credit_order.document_kind = 'CREDIT_NOTE'
      ) AS approved_credit ON true
    ), 0)
  )
  FROM documents WHERE documents.id = credit_id
$$;

UPDATE credit_note_balances AS balances
SET credited_amount = coalesce((
  SELECT sum(document_orders.amount)
  FROM document_orders
  JOIN document_links ON document_links.document_id = document_orders.document_id
  WHERE document_orders.document_kind = 'CREDIT_NOTE'
    AND document_links.related_document_id = balances.invoice_document_id
), 0);
