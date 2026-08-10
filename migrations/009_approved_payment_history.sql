LOCK TABLE documents IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE documents DISABLE TRIGGER documents_approved_immutable;

UPDATE documents
SET payment_status = CASE
      WHEN pending_payment_confirmed_at IS NOT NULL THEN 'PENDING'
      ELSE coalesce(immutable_snapshot_json ->> 'paymentStatus', 'PAID')
    END,
    payment_method = coalesce(
      immutable_snapshot_json ->> 'paymentMethod',
      CASE documents.kind
        WHEN 'CREDIT_NOTE' THEN fiscal_profiles.profile_json #>> '{payment,creditNoteMethod}'
        ELSE fiscal_profiles.profile_json #>> '{payment,invoiceMethod}'
      END
    )
FROM fiscal_profiles
WHERE documents.status = 'APPROVED'
  AND documents.fiscal_profile_version = fiscal_profiles.version;

UPDATE documents
SET immutable_snapshot_json = jsonb_set(
      jsonb_set(immutable_snapshot_json, '{paymentStatus}', to_jsonb(payment_status), true),
      '{paymentMethod}', to_jsonb(payment_method), true
    )
WHERE status = 'APPROVED';

ALTER TABLE documents ENABLE TRIGGER documents_approved_immutable;
