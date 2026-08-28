import type pg from "pg";

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

export async function findArubaRemoteCollision(
  client: QueryClient,
  input: ArubaRemoteCollisionInput,
) {
  const collision = await client.query<{
    id: string;
    remote_id: string;
    api: boolean;
  }>(
    `SELECT id, remote_id, automatic_source = 'API' AS api FROM aruba_remote_documents
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
