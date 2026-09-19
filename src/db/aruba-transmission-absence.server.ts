import { z } from "zod";

import type { ArubaRemoteStatus } from "../aruba-inbound.ts";
import { AppError } from "../errors.ts";
import { writeAudit } from "./audit.server.ts";
import { requeueIneffectiveInvoice } from "./rejected-invoice-requeue.server.ts";
import { withTransaction } from "./client.server.ts";
import { isDatabaseId } from "./database-id.ts";
import {
  absenceEvidenceSql,
  arubaTransmissionAbsenceSql,
} from "./aruba-transmission-absence-sql.server.ts";
import {
  arubaAccountReference,
  arubaRuntimeEnvironment,
  lockArubaInventory,
  type ArubaReadActor,
} from "./aruba-inventory-context.server.ts";

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
  const reason = z.string().trim().min(1).max(500).safeParse(rawReason);
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
    // Una fattura Hub mai trasmessa non è emessa: i suoi ordini tornano da fatturare.
    for (const submissionId of current.submission_ids) {
      // Una sola transazione serializza il raggruppamento, come nello scarto.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      await requeueIneffectiveInvoice(
        client,
        submissionId,
        { requestId: actor.requestId },
        "INVOICE_NOT_TRANSMITTED_REQUEUED",
      );
    }
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
