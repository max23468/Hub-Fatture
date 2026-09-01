-- Un documento Aruba vicino per data e con lo stesso destinatario può essere una
-- fattura già emessa anche quando il totale differisce. Senza XML ufficiale non
-- lo collega automaticamente: rende invece non approvabile la preparazione.
LOCK TABLE billing_cases, orders, aruba_remote_documents, aruba_document_matches
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE aruba_identity_evidence_cases ON COMMIT DROP AS
SELECT billing_cases.id,
       count(DISTINCT remote.id)::integer AS remote_document_count
FROM billing_cases
JOIN orders ON orders.billing_case_id = billing_cases.id
JOIN aruba_document_matches AS matches
  ON matches.method <> 'MANUAL'
 AND matches.status IN ('UNMATCHED', 'AMBIGUOUS', 'PROFILE_CONFLICT')
JOIN aruba_remote_documents AS remote
  ON remote.id = matches.remote_document_id
 AND remote.remote_status <> 'REJECTED'
 AND remote.xml_sha256 IS NULL
CROSS JOIN LATERAL jsonb_array_elements(coalesce(matches.candidates_json, '[]')) AS candidate
WHERE billing_cases.status = 'READY'
  AND coalesce((candidate -> 'signals' ->> 'nearDate')::boolean, false)
  AND coalesce((candidate -> 'signals' ->> 'recipient')::boolean, false)
  AND (
    candidate ->> 'candidateId' = orders.id::text
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(coalesce(candidate -> 'orderIds', '[]')) AS candidate_order(id)
      WHERE candidate_order.id = orders.id::text
    )
  )
GROUP BY billing_cases.id;

UPDATE billing_cases
SET status = 'NEEDS_REVIEW',
    revision = revision + 1,
    updated_at = now()
FROM aruba_identity_evidence_cases AS affected
WHERE billing_cases.id = affected.id;

INSERT INTO audit_events
  (actor_type, action, event_class, entity_type, entity_id, metadata_json, request_id)
SELECT 'SYSTEM', 'BILLING_CASE_ARUBA_IDENTITY_EVIDENCE_RECONCILED', 'CRITICAL',
       'BILLING_CASE', affected.id::text,
       jsonb_build_object(
         'billingCaseId', affected.id::text,
         'affectedCount', affected.remote_document_count,
         'reason', 'ARUBA_IDENTITY_EVIDENCE_WITHOUT_OFFICIAL_FILE'
       ),
       'migration:062_reconcile_aruba_identity_evidence'
FROM aruba_identity_evidence_cases AS affected;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM billing_cases
    JOIN orders ON orders.billing_case_id = billing_cases.id
    JOIN aruba_document_matches AS matches
      ON matches.method <> 'MANUAL'
     AND matches.status IN ('UNMATCHED', 'AMBIGUOUS', 'PROFILE_CONFLICT')
    JOIN aruba_remote_documents AS remote
      ON remote.id = matches.remote_document_id
     AND remote.remote_status <> 'REJECTED'
     AND remote.xml_sha256 IS NULL
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(matches.candidates_json, '[]')) AS candidate
    WHERE billing_cases.status = 'READY'
      AND coalesce((candidate -> 'signals' ->> 'nearDate')::boolean, false)
      AND coalesce((candidate -> 'signals' ->> 'recipient')::boolean, false)
      AND (
        candidate ->> 'candidateId' = orders.id::text
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(coalesce(candidate -> 'orderIds', '[]'))
            AS candidate_order(id)
          WHERE candidate_order.id = orders.id::text
        )
      )
  ) THEN
    RAISE EXCEPTION 'Riconciliazione evidenze identità Aruba incompleta';
  END IF;
END
$$;
