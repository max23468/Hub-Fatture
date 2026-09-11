import { z } from "zod";

import type { ArubaRemoteStatus } from "../aruba-inbound.ts";
import { AppError } from "../errors.ts";
import { writeAudit } from "./audit.server.ts";
import { withTransaction } from "./client.server.ts";
import { isDatabaseId } from "./database-id.ts";
import {
  arubaAccountReference,
  arubaRuntimeEnvironment,
  lockArubaInventory,
  type ArubaReadActor,
} from "./aruba-inventory-context.server.ts";

const WAITING_STATUSES = "('SUBMITTED', 'SDI_PROCESSING')";

function absenceEvidenceSql(remote: string) {
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

/** Invio Hub il cui documento Aruba è stato chiuso come mai trasmesso. */
export function arubaSubmissionTransmissionAbsenceSql(submissions: string) {
  return `EXISTS (SELECT 1 FROM aruba_remote_documents AS absence_remote
    JOIN aruba_document_matches AS absence_matches
      ON absence_matches.remote_document_id = absence_remote.id
    WHERE absence_remote.provider_group_id = ${submissions}.remote_id
      AND absence_remote.environment = ${submissions}.environment
      AND ${arubaTransmissionAbsenceSql("absence_remote", "absence_matches")})`;
}

/**
 * Documento escluso per errore che il titolare può dichiarare mai trasmesso a SdI. SdI ha cinque
 * giorni per l'esito: oltre, senza ID SdI, notifiche o invii, il documento nato da un dry-run
 * riuscito non è stato trasmesso.
 */
export function arubaTransmissionAbsenceEligibleSql(remote: string, matches: string) {
  const hubSubmission = `aruba_submissions AS absence_submissions
    JOIN aruba_batches AS absence_batches ON absence_batches.id = absence_submissions.batch_id
    JOIN aruba_submission_attempts AS absence_attempts
      ON absence_attempts.submission_id = absence_submissions.id
    WHERE absence_submissions.remote_id = ${remote}.provider_group_id
      AND absence_submissions.environment = ${remote}.environment
      AND absence_batches.account_reference = ${remote}.account_reference`;
  return `(${matches}.signals_json @> '{"identityCollisionExcluded":true}'
    AND NOT ${arubaTransmissionAbsenceSql(remote, matches)}
    AND ${absenceEvidenceSql(remote)}
    AND ${remote}.remote_status_observed_at <= now() - interval '5 days'
    AND EXISTS (SELECT 1 FROM ${hubSubmission} AND absence_attempts.operation = 'DRY_RUN'
      AND absence_attempts.status = 'SUCCEEDED')
    AND NOT EXISTS (SELECT 1 FROM ${hubSubmission}
      AND absence_attempts.operation IN ('UPLOAD', 'SEND')))`;
}

export async function confirmArubaTransmissionAbsence(
  remoteDocumentId: string,
  metadataDigest: string,
  rawReason: unknown,
  confirmation: unknown,
  actor: ArubaReadActor,
) {
  if (!actor.canApprove) throw new AppError("ARUBA_OPERATION_FORBIDDEN", 403);
  const reason = z.string().trim().min(20).max(500).safeParse(rawReason);
  if (
    !isDatabaseId(remoteDocumentId) ||
    !/^[0-9a-f]{64}$/.test(metadataDigest) ||
    !reason.success ||
    confirmation !== "confirmed"
  ) {
    throw new AppError("ARUBA_INVENTORY_INVALID", 422);
  }
  return withTransaction(async (client) => {
    await lockArubaInventory(client);
    const eligible = await client.query<{
      remote_status: ArubaRemoteStatus;
      submission_ids: string[];
    }>(
      `SELECT remote.remote_status,
         array(SELECT submissions.id::text FROM aruba_submissions AS submissions
           WHERE submissions.remote_id = remote.provider_group_id
             AND submissions.environment = remote.environment
           ORDER BY submissions.id) AS submission_ids
       FROM aruba_remote_documents AS remote
       JOIN aruba_document_matches AS matches ON matches.remote_document_id = remote.id
       WHERE remote.id = $1 AND remote.environment = $2 AND remote.account_reference = $3
         AND remote.metadata_digest = $4
         AND ${arubaTransmissionAbsenceEligibleSql("remote", "matches")}
       FOR UPDATE OF matches, remote`,
      [remoteDocumentId, arubaRuntimeEnvironment(), arubaAccountReference(), metadataDigest],
    );
    const current = eligible.rows[0];
    if (!current) throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
    await client.query(
      `UPDATE aruba_document_matches SET signals_json = signals_json || jsonb_build_object(
         'transmissionAbsence', jsonb_build_object(
           'metadataDigest', $2::text, 'decidedBy', $3::integer, 'reason', $4::text,
           'decidedAt', now())), updated_at = now()
       WHERE remote_document_id = $1`,
      [remoteDocumentId, metadataDigest, actor.id, reason.data],
    );
    await client.query(
      `UPDATE operational_controls SET state = 'RESOLVED', resolved_at = now(),
         resolution_code = 'ARUBA_TRANSMISSION_ABSENCE_CONFIRMED', resolution_note = $2,
         waiting_at = NULL, waiting_reason = NULL, due_at = NULL, updated_at = now()
       WHERE id = $1 AND state <> 'RESOLVED'`,
      [`ARUBA_REMOTE:${remoteDocumentId}`, reason.data],
    );
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "ARUBA_TRANSMISSION_ABSENCE_CONFIRMED",
      eventClass: "CRITICAL",
      entityType: "ARUBA_REMOTE_DOCUMENT",
      entityId: remoteDocumentId,
      metadata: { provider: "ARUBA", remoteStatus: current.remote_status },
      after: { metadataDigest, submissionIds: current.submission_ids },
      reason: reason.data,
      requestId: actor.requestId,
    });
    return { confirmed: true };
  });
}
