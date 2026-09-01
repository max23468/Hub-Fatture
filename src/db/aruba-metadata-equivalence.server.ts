import type pg from "pg";

import { remoteInventoryDocumentSchema, remoteMetadataDigest } from "../aruba-inbound.ts";

export async function storedMetadataIsCanonicallyEquivalent(
  client: pg.PoolClient,
  remoteDocumentId: string,
  storedDigest: string,
  incomingDigest: string,
) {
  const observation = await client.query<{ payload: unknown }>(
    `SELECT coalesce(observations.payload_json, document.value) AS payload
     FROM aruba_remote_documents remote
     JOIN aruba_remote_observations observations ON observations.remote_document_id = remote.id
     LEFT JOIN aruba_sync_pages pages
       ON pages.sync_session_id = observations.sync_session_id
      AND pages.stream = observations.stream
      AND pages.scan_ordinal = observations.scan_ordinal
      AND pages.page_ordinal = observations.page_ordinal
     LEFT JOIN LATERAL jsonb_array_elements(pages.documents_json) document(value) ON
       document.value ->> 'remoteId' = remote.remote_id
     WHERE remote.id = $1 AND observations.payload_digest = $2
       AND coalesce(observations.payload_json, document.value) IS NOT NULL
     ORDER BY observations.observed_at DESC, observations.id DESC LIMIT 1`,
    [remoteDocumentId, storedDigest],
  );
  const parsed = remoteInventoryDocumentSchema.safeParse(observation.rows[0]?.payload);
  return parsed.success && remoteMetadataDigest(parsed.data) === incomingDigest;
}
