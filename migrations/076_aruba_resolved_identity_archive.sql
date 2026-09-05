-- Una decisione esplicita può richiedere l'archiviazione della fattura ufficiale
-- mantenendo immutabile il precedente documento locale con lo stesso numero.
ALTER TABLE documents
  ADD COLUMN identity_resolution_remote_document_id bigint REFERENCES aruba_remote_documents(id),
  ADD CONSTRAINT documents_identity_resolution_origin_check CHECK (
    identity_resolution_remote_document_id IS NULL
    OR (origin = 'ARUBA_HISTORY' AND kind = 'INVOICE' AND status = 'APPROVED')
  );

DROP INDEX documents_fiscal_number_idx;
CREATE UNIQUE INDEX documents_fiscal_number_idx
  ON documents (series, fiscal_year, fiscal_number)
  WHERE status = 'APPROVED' AND identity_resolution_remote_document_id IS NULL;
CREATE UNIQUE INDEX documents_resolved_fiscal_number_idx
  ON documents (series, fiscal_year, fiscal_number)
  WHERE identity_resolution_remote_document_id IS NOT NULL;
CREATE UNIQUE INDEX documents_identity_resolution_remote_idx
  ON documents (identity_resolution_remote_document_id)
  WHERE identity_resolution_remote_document_id IS NOT NULL;

CREATE FUNCTION validate_resolved_identity_archive() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.identity_resolution_remote_document_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM aruba_deduplication_conflicts conflict
    JOIN aruba_remote_documents selected
      ON selected.id = NEW.identity_resolution_remote_document_id
      AND selected.environment = conflict.environment
      AND selected.account_reference = conflict.account_reference
    JOIN documents previous ON previous.series = NEW.series
      AND previous.fiscal_year = NEW.fiscal_year AND previous.fiscal_number = NEW.fiscal_number
      AND previous.status = 'APPROVED' AND previous.identity_resolution_remote_document_id IS NULL
    WHERE conflict.resolved_at IS NOT NULL AND conflict.resolved_by IS NOT NULL
      AND conflict.resolution_json ->> 'selectedId' = selected.id::text
      AND conflict.resolution_json -> 'xmlHashes' ->> selected.id::text = NEW.xml_sha256
      AND conflict.resolution_json -> 'xmlHashes' ->> (conflict.resolution_json ->> 'excludedId') = previous.xml_sha256
      AND selected.series = NEW.series AND selected.fiscal_year = NEW.fiscal_year
      AND selected.fiscal_number = NEW.fiscal_number::text
      AND selected.remote_status IN ('DELIVERED', 'NOT_DELIVERED')
  ) THEN
    RAISE EXCEPTION 'Archiviazione della collisione priva di una decisione verificata';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER documents_resolved_identity_archive
  BEFORE INSERT OR UPDATE OF identity_resolution_remote_document_id ON documents
  FOR EACH ROW EXECUTE FUNCTION validate_resolved_identity_archive();
