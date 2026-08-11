INSERT INTO settings (key, value_json)
VALUES ('customer_email_mode', '"AUTOMATIC"'::jsonb)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE refunds DROP CONSTRAINT refunds_check;

ALTER TABLE jobs
  DROP CONSTRAINT jobs_type_check,
  ADD CONSTRAINT jobs_type_check CHECK (type IN (
    'shopify_sync_orders', 'shopify_process_webhook', 'ebay_sync_orders',
    'ebay_preview_history', 'process_refund', 'send_customer_email'
  ));

CREATE UNIQUE INDEX jobs_process_refund_idx
  ON jobs ((payload_json ->> 'refundId'))
  WHERE type = 'process_refund' AND status IN ('PENDING', 'RUNNING');

CREATE UNIQUE INDEX jobs_send_customer_email_idx
  ON jobs ((payload_json ->> 'deliveryId'))
  WHERE type = 'send_customer_email' AND status IN ('PENDING', 'RUNNING');

ALTER TABLE documents DROP CONSTRAINT documents_billing_case_id_kind_key;

CREATE UNIQUE INDEX documents_one_invoice_per_case_idx
  ON documents (billing_case_id) WHERE kind = 'INVOICE';

ALTER TABLE documents
  ADD COLUMN customer_email_mode text NOT NULL DEFAULT 'MANUAL'
    CHECK (customer_email_mode IN ('AUTOMATIC', 'MANUAL')),
  ADD COLUMN customer_email_choice text NOT NULL DEFAULT 'SKIP'
    CHECK (customer_email_choice IN ('SEND', 'SKIP')),
  ADD COLUMN customer_email_sender text,
  ADD COLUMN customer_email_recipient text,
  ADD COLUMN customer_email_subject text,
  ADD COLUMN customer_email_body text,
  ADD CONSTRAINT documents_customer_email_snapshot_check CHECK (
    (customer_email_choice = 'SKIP'
      AND customer_email_sender IS NULL
      AND customer_email_recipient IS NULL
      AND customer_email_subject IS NULL
      AND customer_email_body IS NULL)
    OR
    (customer_email_choice = 'SEND'
      AND nullif(btrim(customer_email_sender), '') IS NOT NULL
      AND nullif(btrim(customer_email_recipient), '') IS NOT NULL
      AND nullif(btrim(customer_email_subject), '') IS NOT NULL
      AND nullif(btrim(customer_email_body), '') IS NOT NULL)
  );

CREATE TABLE document_links (
  document_id bigint PRIMARY KEY REFERENCES documents(id),
  related_document_id bigint NOT NULL REFERENCES documents(id),
  relation_type text NOT NULL CHECK (relation_type = 'CREDIT_NOTE_FOR_INVOICE'),
  CHECK (document_id <> related_document_id)
);

ALTER TABLE refunds
  ADD COLUMN credit_document_id bigint REFERENCES documents(id);

CREATE INDEX refunds_credit_document_idx
  ON refunds (credit_document_id) WHERE credit_document_id IS NOT NULL;

CREATE TABLE credit_note_balances (
  invoice_document_id bigint PRIMARY KEY REFERENCES documents(id),
  invoice_total integer NOT NULL CHECK (invoice_total >= 0),
  credited_amount integer NOT NULL DEFAULT 0 CHECK (
    credited_amount >= 0 AND credited_amount <= invoice_total
  )
);

INSERT INTO credit_note_balances (invoice_document_id, invoice_total)
SELECT id, total_amount FROM documents WHERE kind = 'INVOICE' AND status = 'APPROVED';

CREATE FUNCTION maintain_invoice_credit_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'INVOICE' AND NEW.status = 'APPROVED'
     AND (TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND OLD.status <> 'APPROVED')) THEN
    INSERT INTO credit_note_balances (invoice_document_id, invoice_total)
    VALUES (NEW.id, NEW.total_amount)
    ON CONFLICT (invoice_document_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER documents_credit_balance
  AFTER INSERT OR UPDATE OF status ON documents
  FOR EACH ROW EXECUTE FUNCTION maintain_invoice_credit_balance();

CREATE FUNCTION credit_note_invoice_id(credit_id bigint) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT related_document_id FROM document_links
  WHERE document_id = credit_id AND relation_type = 'CREDIT_NOTE_FOR_INVOICE'
$$;

CREATE FUNCTION validate_credit_note_link() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  credit_kind text;
  credit_status text;
  invoice_kind text;
  invoice_status text;
BEGIN
  SELECT kind, status INTO credit_kind, credit_status FROM documents WHERE id = NEW.document_id;
  SELECT kind, status INTO invoice_kind, invoice_status
  FROM documents WHERE id = NEW.related_document_id;
  IF credit_kind <> 'CREDIT_NOTE' OR credit_status <> 'DRAFT'
     OR invoice_kind <> 'INVOICE' OR invoice_status <> 'APPROVED' THEN
    RAISE EXCEPTION 'Collegamento nota di credito non valido';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM aruba_submissions
    WHERE document_id = NEW.related_document_id
      AND status IN ('DELIVERED', 'NOT_DELIVERED')
  ) THEN
    RAISE EXCEPTION 'La fattura originaria non risulta emessa';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER document_links_validate_credit_note
  BEFORE INSERT OR UPDATE ON document_links
  FOR EACH ROW EXECUTE FUNCTION validate_credit_note_link();

CREATE FUNCTION account_refund_credit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_invoice bigint;
  new_invoice bigint;
  old_amount integer := 0;
  new_amount integer := 0;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.credit_document_id IS NOT NULL THEN
    old_invoice := credit_note_invoice_id(OLD.credit_document_id);
    old_amount := coalesce(OLD.amount, 0);
    IF EXISTS (SELECT 1 FROM documents WHERE id = OLD.credit_document_id AND status = 'APPROVED')
       AND (TG_OP = 'DELETE'
         OR NEW.credit_document_id IS DISTINCT FROM OLD.credit_document_id
         OR NEW.amount IS DISTINCT FROM OLD.amount
         OR NEW.status IS DISTINCT FROM OLD.status) THEN
      RAISE EXCEPTION 'Un rimborso incluso in una nota emessa è immutabile';
    END IF;
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
    new_amount := NEW.amount;
  END IF;

  IF old_invoice IS NOT NULL THEN
    UPDATE credit_note_balances
    SET credited_amount = credited_amount - old_amount
    WHERE invoice_document_id = old_invoice;
  END IF;
  IF new_invoice IS NOT NULL THEN
    UPDATE credit_note_balances
    SET credited_amount = credited_amount + new_amount
    WHERE invoice_document_id = new_invoice
      AND credited_amount + new_amount <= invoice_total;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Il totale delle note supera la fattura originaria';
    END IF;
  END IF;
  RETURN coalesce(NEW, OLD);
END;
$$;

CREATE TRIGGER refunds_account_credit
  BEFORE INSERT OR UPDATE OR DELETE ON refunds
  FOR EACH ROW EXECUTE FUNCTION account_refund_credit();

CREATE FUNCTION credit_note_total_matches(credit_id bigint) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT documents.kind <> 'CREDIT_NOTE' OR (
    credit_note_invoice_id(documents.id) IS NOT NULL
    AND documents.total_amount > 0
    AND documents.total_amount = coalesce((
      SELECT sum(refunds.amount) FROM refunds
      WHERE refunds.credit_document_id = documents.id
    ), 0)
  )
  FROM documents WHERE documents.id = credit_id
$$;

CREATE FUNCTION validate_credit_note_total() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(credit_note_total_matches(NEW.id), false) THEN
    RAISE EXCEPTION 'Il totale della nota non coincide con i rimborsi collegati';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER documents_validate_credit_total
  AFTER INSERT OR UPDATE ON documents DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_credit_note_total();

CREATE FUNCTION validate_refund_credit_total() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.credit_document_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM documents WHERE id = OLD.credit_document_id)
     AND NOT coalesce(credit_note_total_matches(OLD.credit_document_id), false) THEN
    RAISE EXCEPTION 'Il totale della nota non coincide con i rimborsi collegati';
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.credit_document_id IS NOT NULL
     AND NEW.credit_document_id IS DISTINCT FROM
       (CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.credit_document_id END)
     AND NOT coalesce(credit_note_total_matches(NEW.credit_document_id), false) THEN
    RAISE EXCEPTION 'Il totale della nota non coincide con i rimborsi collegati';
  END IF;
  RETURN coalesce(NEW, OLD);
END;
$$;

CREATE CONSTRAINT TRIGGER refunds_validate_credit_total
  AFTER INSERT OR UPDATE OR DELETE ON refunds DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_refund_credit_total();

CREATE FUNCTION reject_approved_credit_links() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM documents
    WHERE id = OLD.document_id AND status = 'APPROVED'
  ) THEN
    RAISE EXCEPTION 'I riferimenti di una nota emessa sono immutabili';
  END IF;
  RETURN coalesce(NEW, OLD);
END;
$$;

CREATE TRIGGER document_links_approved_immutable
  BEFORE UPDATE OR DELETE ON document_links
  FOR EACH ROW EXECUTE FUNCTION reject_approved_credit_links();

CREATE TABLE email_deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_key uuid NOT NULL UNIQUE,
  document_id bigint NOT NULL REFERENCES documents(id),
  transport text NOT NULL CHECK (transport IN ('SYNTHETIC', 'EXISTING_SMTP', 'OCI_EMAIL_DELIVERY')),
  sender text NOT NULL,
  recipient text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  attachment_storage_object_id bigint NOT NULL REFERENCES storage_objects(id),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  message_id text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  send_started_at timestamptz,
  sent_at timestamptz,
  last_error_code text,
  last_error_sanitized text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'SENT') = (sent_at IS NOT NULL AND message_id IS NOT NULL))
);

CREATE UNIQUE INDEX email_deliveries_one_pending_idx
  ON email_deliveries (document_id) WHERE status = 'PENDING';

CREATE INDEX email_deliveries_document_idx
  ON email_deliveries (document_id, created_at DESC);
