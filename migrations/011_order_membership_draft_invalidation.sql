CREATE FUNCTION invalidate_invoice_draft_on_order_membership_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.billing_case_id IS DISTINCT FROM NEW.billing_case_id THEN
    UPDATE documents
    SET projection_sha256 = repeat('0', 64), updated_at = now()
    WHERE kind = 'INVOICE' AND status = 'DRAFT'
      AND billing_case_id IN (OLD.billing_case_id, NEW.billing_case_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_invalidate_invoice_draft
  AFTER UPDATE OF billing_case_id ON orders
  FOR EACH ROW EXECUTE FUNCTION invalidate_invoice_draft_on_order_membership_change();
