-- Chiude le preparazioni aperte ricreate sopra ordini già collegati a una fattura
-- approvata. Un caso misto non viene indovinato: arresta la migrazione e richiede
-- una riconciliazione applicativa esplicita.
LOCK TABLE billing_cases, orders, documents, document_orders IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE reconciled_approved_invoice_cases ON COMMIT DROP AS
SELECT billing_cases.id,
       count(DISTINCT orders.id)::integer AS order_count,
       count(DISTINCT issued_documents.id)::integer AS document_count
FROM billing_cases
JOIN orders ON orders.billing_case_id = billing_cases.id
JOIN document_orders AS issued_document_orders
  ON issued_document_orders.order_id = orders.id
 AND issued_document_orders.document_kind = 'INVOICE'
JOIN documents AS issued_documents
  ON issued_documents.id = issued_document_orders.document_id
 AND issued_documents.status = 'APPROVED'
WHERE billing_cases.status IN ('DRAFT', 'READY', 'NEEDS_REVIEW')
GROUP BY billing_cases.id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM reconciled_approved_invoice_cases AS affected
    JOIN orders ON orders.billing_case_id = affected.id
    WHERE NOT EXISTS (
      SELECT 1
      FROM document_orders
      JOIN documents ON documents.id = document_orders.document_id
      WHERE document_orders.order_id = orders.id
        AND document_orders.document_kind = 'INVOICE'
        AND documents.status = 'APPROVED'
    )
  ) THEN
    RAISE EXCEPTION
      'Riconciliazione ordini fatturati bloccata: preparazione mista inattesa';
  END IF;
END
$$;

DELETE FROM documents
USING reconciled_approved_invoice_cases AS affected
WHERE documents.billing_case_id = affected.id
  AND documents.kind = 'INVOICE'
  AND documents.status = 'DRAFT';

UPDATE orders
SET billing_case_id = NULL,
    trigger_status = 'INVOICED'
FROM reconciled_approved_invoice_cases AS affected
WHERE orders.billing_case_id = affected.id;

UPDATE billing_cases
SET status = 'CLOSED',
    revision = revision + 1,
    updated_at = now()
FROM reconciled_approved_invoice_cases AS affected
WHERE billing_cases.id = affected.id;

INSERT INTO audit_events
  (actor_type, action, event_class, entity_type, entity_id, metadata_json, request_id)
SELECT 'SYSTEM', 'BILLING_CASE_INVOICED_ORDERS_RECONCILED', 'CRITICAL',
       'BILLING_CASE', affected.id::text,
       jsonb_build_object(
         'billingCaseId', affected.id::text,
         'orderCount', affected.order_count,
         'documentCount', affected.document_count,
         'reason', 'APPROVED_INVOICE_LINK'
       ),
       'migration:052_reconcile_approved_invoice_memberships'
FROM reconciled_approved_invoice_cases AS affected;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM billing_cases
    JOIN orders ON orders.billing_case_id = billing_cases.id
    JOIN document_orders ON document_orders.order_id = orders.id
    JOIN documents ON documents.id = document_orders.document_id
    WHERE billing_cases.status IN ('DRAFT', 'READY', 'NEEDS_REVIEW')
      AND document_orders.document_kind = 'INVOICE'
      AND documents.status = 'APPROVED'
  ) THEN
    RAISE EXCEPTION
      'Riconciliazione ordini fatturati incompleta';
  END IF;
END
$$;
