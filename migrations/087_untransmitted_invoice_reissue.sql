-- Una fattura Hub dichiarata dal titolare mai trasmessa a SdI non è emessa, come una scartata:
-- i suoi ordini possono entrare in una nuova fattura. La dichiarazione decade da sola se Aruba
-- assegna un ID SdI, produce una notifica o cambia metadati o stato.
CREATE FUNCTION aruba_submission_transmission_absent(submission_id bigint) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM aruba_submissions AS submission
    JOIN aruba_remote_documents AS remote
      ON remote.provider_group_id = submission.remote_id
     AND remote.environment = submission.environment
    JOIN aruba_document_matches AS matches ON matches.remote_document_id = remote.id
    WHERE submission.id = submission_id
      AND matches.signals_json @> '{"identityCollisionExcluded":true}'
      AND (matches.signals_json -> 'transmissionAbsence' ->> 'metadataDigest')
        IS NOT DISTINCT FROM remote.metadata_digest
      AND remote.remote_status IN ('SUBMITTED', 'SDI_PROCESSING')
      AND coalesce(remote.provider_sdi_id, '0') = '0'
      AND NOT EXISTS (
        SELECT 1 FROM aruba_files
        WHERE aruba_files.remote_document_id = remote.id
          AND aruba_files.kind = 'SDI_NOTIFICATION'
      )
  )
$$;

CREATE OR REPLACE FUNCTION reject_multiple_effective_invoice_orders() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.document_kind <> 'INVOICE' THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('effective-invoice-order:' || NEW.order_id::text, 0)
  );
  IF EXISTS (
    SELECT 1
    FROM document_orders AS existing_link
    JOIN documents AS existing_document ON existing_document.id = existing_link.document_id
    WHERE existing_link.order_id = NEW.order_id
      AND existing_link.document_kind = 'INVOICE'
      AND existing_link.document_id <> NEW.document_id
      AND NOT (NEW.split_invoice AND existing_link.split_invoice)
      AND (
        existing_document.status = 'DRAFT'
        OR (
          existing_document.status = 'APPROVED'
          AND (
            NOT EXISTS (
              SELECT 1 FROM aruba_submissions
              WHERE aruba_submissions.document_id = existing_document.id
            )
            OR EXISTS (
              SELECT 1 FROM aruba_submissions
              WHERE aruba_submissions.document_id = existing_document.id
                AND aruba_submissions.status <> 'REJECTED'
                AND NOT aruba_submission_transmission_absent(aruba_submissions.id)
            )
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'Ordine già collegato a una fattura efficace o modificabile';
  END IF;
  RETURN NEW;
END;
$$;
