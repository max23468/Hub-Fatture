ALTER TABLE documents DISABLE TRIGGER documents_approved_immutable;

WITH m4 AS (
  SELECT applied_at FROM schema_migrations WHERE name = '006_m4_completion.sql'
)
UPDATE documents
SET payment_status = CASE
      WHEN EXISTS (
        SELECT 1
        FROM document_orders
        JOIN orders ON orders.id = document_orders.order_id
        WHERE document_orders.document_id = documents.id
          AND orders.payment_status = 'PENDING'
      ) THEN 'PENDING'
      ELSE 'PAID'
    END,
    payment_method = CASE documents.kind
      WHEN 'CREDIT_NOTE' THEN fiscal_profiles.profile_json #>> '{payment,creditNoteMethod}'
      ELSE fiscal_profiles.profile_json #>> '{payment,invoiceMethod}'
    END
FROM fiscal_profiles, m4
WHERE documents.fiscal_profile_version = fiscal_profiles.version
  AND documents.created_at < m4.applied_at;

WITH m4 AS (
  SELECT applied_at FROM schema_migrations WHERE name = '006_m4_completion.sql'
)
UPDATE documents
SET immutable_snapshot_json = jsonb_set(
      jsonb_set(immutable_snapshot_json, '{paymentStatus}', to_jsonb(payment_status), true),
      '{paymentMethod}', to_jsonb(payment_method), true
    )
FROM m4
WHERE status = 'APPROVED'
  AND created_at < m4.applied_at;

ALTER TABLE documents ENABLE TRIGGER documents_approved_immutable;
