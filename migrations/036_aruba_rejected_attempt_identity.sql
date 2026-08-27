DROP INDEX aruba_remote_documents_fiscal_identity_idx;

CREATE UNIQUE INDEX aruba_remote_documents_fiscal_identity_idx
  ON aruba_remote_documents (
    environment, account_reference, fiscal_year, upper(series), upper(fiscal_number), document_type
  )
  WHERE series IS NOT NULL AND fiscal_number IS NOT NULL AND remote_status <> 'REJECTED';
