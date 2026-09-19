/** Frammenti SQL della chiusura "mai trasmesso", condivisi da monitoraggio e fatturazione. */

const WAITING_STATUSES = "('SUBMITTED', 'SDI_PROCESSING')";

export function absenceEvidenceSql(remote: string) {
  return `${remote}.remote_status IN ${WAITING_STATUSES}
    AND coalesce(${remote}.provider_sdi_id, '0') = '0'
    AND NOT EXISTS (SELECT 1 FROM aruba_files AS absence_files
      WHERE absence_files.remote_document_id = ${remote}.id
        AND absence_files.kind = 'SDI_NOTIFICATION')`;
}

/**
 * Chiusura del titolare ancora valida. Decade da sola se Aruba cambia metadati o stato, assegna
 * un ID SdI o produce una notifica: controlli e monitoraggio riprendono senza nuove decisioni.
 */
export function arubaTransmissionAbsenceSql(remote: string, matches: string) {
  return `(${matches}.signals_json @> '{"identityCollisionExcluded":true}'
    AND (${matches}.signals_json -> 'transmissionAbsence' ->> 'metadataDigest')
      IS NOT DISTINCT FROM ${remote}.metadata_digest
    AND ${absenceEvidenceSql(remote)})`;
}

/** Invio Hub il cui documento Aruba è stato chiuso come mai trasmesso (migrazione 087). */
export function arubaSubmissionTransmissionAbsenceSql(submissions: string) {
  return `aruba_submission_transmission_absent(${submissions}.id)`;
}
