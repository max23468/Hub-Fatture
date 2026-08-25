import type pg from "pg";

import {
  ARUBA_MATCHER_VERSION,
  remoteInventoryDocumentSchema,
  type RemoteInventoryDocument,
} from "../aruba-inbound.ts";

export async function reconcileCachedArubaMatcherUpgrade(
  client: pg.PoolClient,
  environment: string,
  account: string,
  reconcile: (remoteId: string, remote: RemoteInventoryDocument) => Promise<void>,
) {
  const cached = await client.query<{
    id: string;
    payload: unknown;
  }>(
    `SELECT remote.id::text, latest.payload
     FROM aruba_remote_documents remote
     JOIN aruba_document_matches matches ON matches.remote_document_id = remote.id
     JOIN LATERAL (
       SELECT document.value AS payload
       FROM aruba_remote_observations observations
       JOIN aruba_sync_pages pages
         ON pages.sync_session_id = observations.sync_session_id
        AND pages.stream = observations.stream
        AND pages.scan_ordinal = observations.scan_ordinal
        AND pages.page_ordinal = observations.page_ordinal
       CROSS JOIN LATERAL jsonb_array_elements(pages.documents_json) document(value)
       WHERE observations.remote_document_id = remote.id
         AND document.value ->> 'remoteId' = remote.remote_id
       ORDER BY observations.observed_at DESC, observations.id DESC
       LIMIT 1
     ) latest ON true
     WHERE remote.environment = $1 AND remote.account_reference = $2
       AND remote.remote_status <> 'REJECTED'
       AND matches.method <> 'MANUAL'
       AND matches.status NOT IN ('ERROR', 'UNKNOWN_REMOTE_STATE')
       AND ((remote.document_type = 'TD01' AND EXISTS (
         SELECT 1 FROM orders
         WHERE orders.trigger_status NOT IN (
           'INVOICED', 'CANCELLED_NO_DOCUMENT', 'REFUNDED_BEFORE_ISSUE'
         )
           AND orders.local_order_date BETWEEN remote.document_date - 31
             AND remote.document_date + 31
       )) OR (remote.document_type = 'TD04' AND EXISTS (
         SELECT 1 FROM refunds
         WHERE refunds.status = 'COMPLETED' AND NOT refunds.applied_before_issue
           AND refunds.amount > 0
           AND refunds.completed_at::date BETWEEN remote.document_date - 31
             AND remote.document_date + 31
           AND refunds.credit_document_id IS NULL
       )))
     ORDER BY remote.id`,
    [environment, account],
  );
  const invalidIds: string[] = [];
  for (const row of cached.rows) {
    const parsed = remoteInventoryDocumentSchema.safeParse(row.payload);
    if (!parsed.success) {
      invalidIds.push(row.id);
      continue;
    }
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- I match condividono la stessa transazione e vengono aggiornati in ordine.
    await reconcile(row.id, parsed.data);
  }
  if (invalidIds.length) {
    await client.query(
      `UPDATE aruba_document_matches
       SET status = 'ERROR', method = 'NONE', matcher_version = $2,
           signals_json = '{"cachedPayloadInvalid":true}', updated_at = now()
       WHERE remote_document_id = ANY($1::bigint[])`,
      [invalidIds, ARUBA_MATCHER_VERSION],
    );
  }
}
