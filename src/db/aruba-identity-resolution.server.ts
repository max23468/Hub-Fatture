import type pg from "pg";
import { z } from "zod";

import {
  isEmissionConfirmed,
  remoteMetadataDigest,
  type ArubaRemoteStatus,
} from "../aruba-inbound.ts";
import { AppError } from "../errors.ts";
import { recomputeBillingCaseStatus } from "./billing-case-status.server.ts";
import { resolveArubaIdentityControls } from "./operational-controls.server.ts";
import { writeAudit } from "./audit.server.ts";
import { getPool, withTransaction } from "./client.server.ts";
import { isDatabaseId } from "./database-id.ts";
import {
  arubaAccountReference,
  arubaRuntimeEnvironment,
  arubaPayloadDigest,
  lockArubaInventory,
  type ArubaReadActor,
} from "./aruba-inventory-context.server.ts";
import {
  latestObservedRemote,
  loadLatestOfficialXml,
  officialEvidence,
  materializeLatestOfficialXml,
} from "./aruba-document-materialization.server.ts";
import { reconcileRemoteDocument } from "./aruba-reconciliation.server.ts";

export async function readArubaIdentityConflict(
  remoteId: string,
  client: pg.Pool | pg.PoolClient = getPool(),
) {
  if (!isDatabaseId(remoteId)) throw new AppError("ARUBA_INVENTORY_INVALID", 422);
  const result = await client.query<{
    id: string;
    remote_id: string;
    fiscal_number: string;
    series: string;
    remote_status: ArubaRemoteStatus;
    metadata_digest: string;
    total_amount: number;
    document_date: string;
    filename: string | null;
    sdi_id: string | null;
    has_xml: boolean;
    xml_hash: string | null;
    observation_conflict: boolean;
    document_id: string | null;
  }>(
    `WITH RECURSIVE edges AS (
       SELECT c.existing_remote_document_id AS a, incoming.id AS b
       FROM aruba_deduplication_conflicts c
       LEFT JOIN aruba_remote_documents incoming ON incoming.remote_id = c.incoming_remote_id
         AND incoming.environment = c.environment AND incoming.account_reference = c.account_reference
       WHERE c.environment = $2 AND c.account_reference = $3 AND c.resolved_at IS NULL
     ), members(id) AS (
       SELECT $1::bigint WHERE EXISTS (SELECT 1 FROM edges WHERE a = $1 OR b = $1)
       UNION
       SELECT CASE WHEN edges.a = members.id THEN edges.b ELSE edges.a END
       FROM members JOIN edges ON edges.a = members.id OR edges.b = members.id
     )
     SELECT remote.id::text, remote.remote_id, remote.fiscal_number, remote.series,
       remote.remote_status, remote.metadata_digest, remote.total_amount,
       remote.document_date::text, remote.provider_filename AS filename, remote.provider_sdi_id AS sdi_id,
       official.sha256 IS NOT NULL AS has_xml, official.sha256 AS xml_hash,
       coalesce((matches.signals_json ->> 'remoteObservationConflict')::boolean, false) AS observation_conflict,
       matches.document_id::text
     FROM members LEFT JOIN aruba_remote_documents remote ON remote.id = members.id
       AND remote.environment = $2 AND remote.account_reference = $3
     LEFT JOIN aruba_document_matches matches ON matches.remote_document_id = remote.id
     LEFT JOIN LATERAL (
       SELECT storage.sha256 FROM aruba_files files JOIN storage_objects storage ON storage.id = files.storage_object_id
       WHERE files.remote_document_id = remote.id AND files.kind = 'ARUBA_XML'
       ORDER BY files.id DESC LIMIT 1
     ) official ON true
     ORDER BY remote.id`,
    [remoteId, arubaRuntimeEnvironment(), arubaAccountReference()],
  );
  return { members: result.rows, fingerprint: arubaPayloadDigest(result.rows) };
}

export async function resolveArubaIdentityConflict(
  remoteId: string,
  selectedId: string,
  fingerprint: string,
  rawReason: unknown,
  confirmation: unknown,
  actor: ArubaReadActor,
) {
  if (!actor.canApprove) throw new AppError("ARUBA_READ_SESSION_FORBIDDEN", 403);
  const reason = z.string().trim().min(20).max(500).safeParse(rawReason);
  if (!reason.success || !isDatabaseId(selectedId) || confirmation !== "confirmed") {
    throw new AppError("ARUBA_INVENTORY_INVALID", 422);
  }
  return withTransaction(async (client) => {
    await lockArubaInventory(client);
    const conflict = await readArubaIdentityConflict(remoteId, client);
    const selected = conflict.members.find((member) => member.id === selectedId);
    const excluded = conflict.members.find((member) => member.id !== selectedId);
    if (
      conflict.fingerprint !== fingerprint ||
      conflict.members.length !== 2 ||
      !selected ||
      !excluded ||
      !isEmissionConfirmed(selected.remote_status) ||
      excluded.document_id ||
      conflict.members.some(
        (member) =>
          !member.id ||
          !member.has_xml ||
          member.observation_conflict ||
          member.remote_status === "UNKNOWN",
      )
    ) {
      throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
    }
    const cases = await client.query<{ id: string }>(
      `SELECT DISTINCT orders.billing_case_id::text AS id FROM aruba_document_matches matches
       CROSS JOIN LATERAL jsonb_array_elements(matches.candidates_json) candidate
       JOIN orders ON orders.id::text = candidate ->> 'candidateId'
         OR candidate -> 'orderIds' ? orders.id::text
       WHERE matches.remote_document_id = ANY($1::bigint[]) AND orders.billing_case_id IS NOT NULL`,
      [conflict.members.map((member) => member.id)],
    );
    const observed = await latestObservedRemote(client, selected.id);
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- pg depreca query concorrenti sul client della stessa transazione.
    const official = await loadLatestOfficialXml(client, selected.id);
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- La lettura usa lo stesso client transazionale, senza query concorrenti.
    const excludedOfficial = await loadLatestOfficialXml(client, excluded.id);
    if (
      !official ||
      !excludedOfficial ||
      remoteMetadataDigest(observed) !== selected.metadata_digest
    )
      throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
    const evidence = Object.fromEntries(
      conflict.members.map((member) => [member.id, member.metadata_digest]),
    );
    await client.query(
      `UPDATE aruba_deduplication_conflicts SET resolved_at = now(), resolved_by = $4,
         resolution_reason = $5, resolution_json = $6
       WHERE environment = $1 AND account_reference = $2 AND resolved_at IS NULL
         AND existing_remote_document_id = ANY($3::bigint[])`,
      [
        arubaRuntimeEnvironment(),
        arubaAccountReference(),
        conflict.members.map((member) => member.id),
        actor.id,
        reason.data,
        JSON.stringify({
          selectedId,
          excludedId: excluded.id,
          evidence,
          statuses: Object.fromEntries(
            conflict.members.map((member) => [member.id, member.remote_status]),
          ),
          xmlHashes: Object.fromEntries(
            conflict.members.map((member) => [member.id, member.xml_hash]),
          ),
        }),
      ],
    );
    await client.query(
      `UPDATE aruba_document_matches SET status = 'UNMATCHED', method = 'MANUAL',
         signals_json = '{"identityCollisionExcluded":true}', candidates_json = '[]',
         order_id = NULL, billing_case_id = NULL, related_invoice_document_id = NULL, refund_ids = '{}',
         decided_by = $2, decision_reason = $3, decided_at = now(), updated_at = now()
       WHERE remote_document_id = $1`,
      [excluded.id, actor.id, reason.data],
    );
    await client.query(
      `UPDATE aruba_document_matches SET
         status = CASE WHEN document_id IS NULL THEN 'UNMATCHED' ELSE 'MATCHED' END,
         method = CASE WHEN document_id IS NULL THEN 'NONE' ELSE 'MANUAL' END,
         signals_json = signals_json - 'providerIdentityCollision' - 'identityCollisionCandidatesVerified' - 'collisionKey',
         decided_by = coalesce(decided_by, $2), decision_reason = coalesce(decision_reason, $3),
         decided_at = coalesce(decided_at, now()), updated_at = now()
       WHERE remote_document_id = $1`,
      [selected.id, actor.id, reason.data],
    );
    await reconcileRemoteDocument(
      client,
      selected.id,
      officialEvidence({ ...observed, status: selected.remote_status }, official.xml),
      true,
    );
    if (!selected.document_id) await materializeLatestOfficialXml(client, selected.id);
    for (const row of cases.rows) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Ricalcoli atomici sulla stessa transazione della decisione.
      await recomputeBillingCaseStatus(client, row.id, true);
    }
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "ARUBA_IDENTITY_CONFLICT_RESOLVED",
      eventClass: "CRITICAL",
      entityType: "ARUBA_REMOTE_DOCUMENT",
      entityId: selected.id,
      before: { members: conflict.members },
      after: { selectedId, excludedId: excluded.id, evidence },
      reason: reason.data,
      requestId: actor.requestId,
    });
    await resolveArubaIdentityControls(
      client,
      selected.id,
      excluded.id,
      excluded.remote_status === "REJECTED",
      reason.data,
    );
    return { resolved: true };
  });
}
