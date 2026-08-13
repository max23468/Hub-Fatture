CREATE TABLE retention_holds (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  data_class text NOT NULL CHECK (data_class IN (
    'SOURCE_PAYLOADS', 'OPERATIONAL_JOBS', 'OPERATIONAL_AUDIT',
    'CUSTOMER_EMAIL', 'ARUBA_CREDENTIALS'
  )),
  reason text NOT NULL CHECK (nullif(btrim(reason), '') IS NOT NULL),
  approved_by smallint NOT NULL REFERENCES users(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  review_at timestamptz NOT NULL,
  released_at timestamptz,
  released_by smallint REFERENCES users(id),
  CHECK (review_at > started_at),
  CHECK ((released_at IS NULL) = (released_by IS NULL)),
  CHECK (released_at IS NULL OR released_at >= started_at)
);

CREATE UNIQUE INDEX retention_holds_one_active_per_class_idx
  ON retention_holds (data_class)
  WHERE released_at IS NULL;

CREATE INDEX retention_holds_review_idx
  ON retention_holds (review_at)
  WHERE released_at IS NULL;

ALTER TABLE email_deliveries
  ADD COLUMN content_redacted_at timestamptz;

ALTER TABLE documents
  ADD COLUMN customer_email_redacted_at timestamptz;

-- L'approvazione fiscale resta immutabile. L'unica eccezione ammessa è la redazione
-- deterministica dei quattro campi di consegna e del relativo timestamp: nessun altro
-- valore del documento può cambiare durante la retention.
CREATE OR REPLACE FUNCTION reject_approved_document_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'APPROVED' THEN
    IF OLD.customer_email_redacted_at IS NULL
      AND NEW.customer_email_redacted_at IS NOT NULL
      AND NEW.customer_email_sender = '[redatto]'
      AND NEW.customer_email_recipient = '[redatto]'
      AND NEW.customer_email_subject = '[redatto]'
      AND NEW.customer_email_body = '[redatto]'
      AND to_jsonb(NEW) - ARRAY[
        'customer_email_sender', 'customer_email_recipient', 'customer_email_subject',
        'customer_email_body', 'customer_email_redacted_at'
      ] = to_jsonb(OLD) - ARRAY[
        'customer_email_sender', 'customer_email_recipient', 'customer_email_subject',
        'customer_email_body', 'customer_email_redacted_at'
      ]
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Un documento approvato è immutabile';
  END IF;
  RETURN coalesce(NEW, OLD);
END;
$$;
