import type pg from "pg";

import {
  ARUBA_MATCHER_VERSION,
  normalizedMatchText,
  remoteStatusTransition,
  type ArubaRemoteStatus,
  type RemoteInventoryDocument,
} from "../aruba-inbound.ts";

type QueryClient = Pick<pg.PoolClient, "query">;

interface ArubaRejectedAttemptContext {
  environment: string;
  accountReference: string;
}

interface ArubaRemoteCollisionInput extends ArubaRejectedAttemptContext {
  series: string | null;
  fiscalYear: number;
  fiscalNumber: string | null;
  documentType: string;
  xmlSha256: string | null;
  remoteStatus: string;
}

interface ArubaRemoteCollision {
  id: string;
  remote_id: string;
  remote_status: ArubaRemoteStatus;
  api: boolean;
}

export async function findArubaRemoteCollision(
  client: QueryClient,
  input: ArubaRemoteCollisionInput,
) {
  const collision = await client.query<ArubaRemoteCollision>(
    `SELECT id, remote_id, remote_status, automatic_source = 'API' AS api
     FROM aruba_remote_documents
     WHERE environment = $1 AND account_reference = $2 AND (
       ($3::text IS NOT NULL AND $8::text <> 'REJECTED' AND remote_status <> 'REJECTED'
         AND fiscal_year = $4 AND upper(series) = upper($3)
         AND upper(fiscal_number) = upper($5) AND document_type = $6)
       OR ($7::text IS NOT NULL AND xml_sha256 = $7)
     ) FOR UPDATE`,
    [
      input.environment,
      input.accountReference,
      input.series,
      input.fiscalYear,
      input.fiscalNumber,
      input.documentType,
      input.xmlSha256,
      input.remoteStatus,
    ],
  );
  return collision.rows[0] ?? null;
}

export async function consolidateArubaRemoteCollision(
  client: QueryClient,
  collision: ArubaRemoteCollision,
  remote: RemoteInventoryDocument,
  fullScan: boolean,
  metadataDigest: string,
) {
  const transition = remoteStatusTransition(collision.remote_status, remote.status);
  if (transition === "CONFLICT") {
    await client.query(
      `INSERT INTO aruba_document_matches
         (remote_document_id, status, method, matcher_version, signals_json, candidates_json)
       VALUES ($1, 'UNKNOWN_REMOTE_STATE', 'NONE', $2, '{}', '[]')
       ON CONFLICT (remote_document_id) DO UPDATE SET
         status = 'UNKNOWN_REMOTE_STATE', method = 'NONE', updated_at = now()`,
      [collision.id, ARUBA_MATCHER_VERSION],
    );
    return { id: collision.id, conflicted: true };
  }
  if (transition === "IGNORE_STALE") {
    await client.query(
      `UPDATE aruba_remote_documents SET remote_id = $2,
         xml_sha256 = coalesce($3, xml_sha256), last_observed_at = now(),
         last_full_scan_at = CASE WHEN $4 THEN now() ELSE last_full_scan_at END,
         inventory_version = inventory_version + 1
       WHERE id = $1`,
      [collision.id, remote.remoteId, remote.xmlSha256, fullScan],
    );
    return { id: collision.id, conflicted: false };
  }
  await client.query(
    `UPDATE aruba_remote_documents SET remote_id = $2, document_type = $3,
       fiscal_year = $4, series = $5, fiscal_number = $6, document_date = $7,
       recipient_name_normalized = $8, recipient_tax_id_normalized = $9,
       recipient_country_code = $10, recipient_address_normalized = $11,
       total_amount = $12, currency = $13, remote_status = $14,
       remote_status_observed_at = coalesce($15::timestamptz, now()),
       xml_sha256 = coalesce($16, xml_sha256), last_observed_at = now(),
       last_full_scan_at = CASE WHEN $17 THEN now() ELSE last_full_scan_at END,
       inventory_version = inventory_version + 1, metadata_digest = $18
     WHERE id = $1`,
    [
      collision.id,
      remote.remoteId,
      remote.documentType,
      remote.fiscalYear,
      remote.series,
      remote.fiscalNumber,
      remote.documentDate,
      normalizedMatchText(remote.recipientName),
      normalizedMatchText(remote.recipientTaxId),
      remote.recipientCountryCode,
      normalizedMatchText(remote.recipientAddress),
      remote.totalAmount,
      remote.currency,
      remote.status,
      remote.providerObservedAt,
      remote.xmlSha256,
      fullScan,
      metadataDigest,
    ],
  );
  return { id: collision.id, conflicted: false };
}

export async function resolveRejectedAttemptIdentityConflicts(
  client: QueryClient,
  context: ArubaRejectedAttemptContext,
  incomingRemoteId: string,
) {
  const resolved = await client.query<{ remote_document_id: string }>(
    `WITH resolved AS (
       UPDATE aruba_deduplication_conflicts AS conflicts
       SET resolved_at = now()
       FROM aruba_remote_documents AS existing
       WHERE conflicts.existing_remote_document_id = existing.id
         AND conflicts.environment = $1 AND conflicts.account_reference = $2
         AND conflicts.incoming_remote_id = $3 AND conflicts.collision_key = 'FISCAL_IDENTITY'
         AND conflicts.resolved_at IS NULL AND existing.remote_status = 'REJECTED'
         AND existing.automatic_source <> 'API'
       RETURNING existing.id AS remote_document_id
     ), cleared_matches AS (
       DELETE FROM aruba_document_matches AS matches
       USING resolved
       WHERE matches.remote_document_id = resolved.remote_document_id
         AND matches.status = 'ERROR' AND matches.method = 'NONE'
     )
     SELECT DISTINCT remote_document_id FROM resolved`,
    [context.environment, context.accountReference, incomingRemoteId],
  );
  return resolved.rows.map((row) => row.remote_document_id);
}
