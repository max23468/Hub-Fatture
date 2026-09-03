ALTER TABLE documents
  ADD COLUMN source_billing_case_id bigint REFERENCES billing_cases(id);

CREATE INDEX documents_source_billing_case_idx
  ON documents (source_billing_case_id)
  WHERE source_billing_case_id IS NOT NULL;

-- Il riferimento aggiunge provenienza operativa senza modificare il contenuto fiscale.
-- Su un documento approvato può essere valorizzato soltanto una volta e da NULL;
-- l'eccezione di retention esistente resta separata e altre modifiche continuano a fallire.
CREATE OR REPLACE FUNCTION reject_approved_document_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'APPROVED' THEN
    IF OLD.source_billing_case_id IS NULL
      AND NEW.source_billing_case_id IS NOT NULL
      AND to_jsonb(NEW) - 'source_billing_case_id' = to_jsonb(OLD) - 'source_billing_case_id'
    THEN
      RETURN NEW;
    END IF;
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

-- Le fatture Aruba storiche materializzate prima di questa migrazione hanno già perso
-- l'appartenenza operativa dell'ordine. Il recupero resta limitato agli abbinamenti
-- verificati dal proprietario: cliente, giorno ordine e valuta devono comunque produrre
-- un solo caso chiuso vuoto. Ogni assenza, divergenza o ambiguità resta non collegata.
WITH confirmed_links(source_public_number, series, fiscal_year, fiscal_number) AS (
  VALUES
    ('000055', 'FPR', 2026, 1627),
    ('000081', 'FPR', 2026, 1667),
    ('000093', 'FPR', 2026, 1685),
    ('000333', 'FPR', 2026, 1740)
), candidate_pairs AS (
  SELECT DISTINCT documents.id AS document_id, source_cases.id AS source_case_id,
                  source_cases.public_number AS source_public_number,
                  confirmed_links.source_public_number AS confirmed_source_public_number
  FROM documents
  JOIN confirmed_links
    ON confirmed_links.series = documents.series
   AND confirmed_links.fiscal_year = documents.fiscal_year
   AND confirmed_links.fiscal_number = documents.fiscal_number
  JOIN document_orders ON document_orders.document_id = documents.id
    AND document_orders.document_kind = 'INVOICE'
  JOIN orders ON orders.id = document_orders.order_id
  JOIN billing_cases AS source_cases
   ON source_cases.customer_id = orders.customer_id
   AND source_cases.local_order_date = orders.local_order_date
   AND source_cases.currency = orders.currency
  WHERE documents.origin = 'ARUBA_HISTORY'
    AND source_cases.status = 'CLOSED'
    AND source_cases.id <> documents.billing_case_id
    AND NOT EXISTS (
      SELECT 1 FROM orders AS current_orders
      WHERE current_orders.billing_case_id = source_cases.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM documents AS current_documents
      WHERE current_documents.billing_case_id = source_cases.id
    )
), unique_candidates AS (
  SELECT document_id, min(source_case_id) AS source_case_id
  FROM candidate_pairs
  GROUP BY document_id, confirmed_source_public_number
  HAVING count(*) = 1
    AND min(source_public_number) = confirmed_source_public_number
), linked AS (
  UPDATE documents
  SET source_billing_case_id = unique_candidates.source_case_id
  FROM unique_candidates
  WHERE documents.id = unique_candidates.document_id
  RETURNING documents.id, documents.source_billing_case_id
)
INSERT INTO audit_events
  (actor_type, action, event_class, entity_type, entity_id, metadata_json, request_id)
SELECT 'SYSTEM', 'INVOICE_SOURCE_PREPARATION_BACKFILLED', 'CRITICAL',
       'DOCUMENT', linked.id::text,
       jsonb_build_object('billingCaseId', linked.source_billing_case_id::text),
       'migration:065_invoice_source_preparations'
FROM linked;
