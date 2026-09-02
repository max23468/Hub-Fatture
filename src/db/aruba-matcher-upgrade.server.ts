import type pg from "pg";

import {
  ARUBA_MATCHER_REPLAY_DOCUMENT_TYPES,
  ARUBA_MATCHER_VERSION,
  remoteInventoryDocumentSchema,
  type RemoteInventoryDocument,
} from "../aruba-inbound.ts";
import {
  loadLatestOfficialXml,
  materializeLatestOfficialXml,
  officialEvidence,
  reconcileAutomaticAmbiguousInvoices,
} from "./aruba-document-materialization.server.ts";
import { arubaExternalEvidenceCandidateSql } from "./billing-case-sql.server.ts";
import { reconcileRemoteDocument } from "./aruba-reconciliation.server.ts";

const arubaTaxIdentityReplayCandidateSql = (
  candidateAlias = "candidate",
  remoteAlias = "remote",
) => `(
  EXISTS (
    SELECT 1 FROM aruba_files replay_file
    WHERE replay_file.remote_document_id = ${remoteAlias}.id
      AND replay_file.kind = 'ARUBA_XML'
  )
  AND ${candidateAlias} ->> 'issuedInvoiceDocumentId' IS NULL
  AND coalesce((${candidateAlias} -> 'signals' ->> 'provider')::boolean, false)
  AND coalesce((${candidateAlias} -> 'signals' ->> 'nearDate')::boolean, false)
  AND coalesce((${candidateAlias} -> 'signals' ->> 'address')::boolean, false)
  AND NOT coalesce((${candidateAlias} -> 'signals' ->> 'total')::boolean, false)
)`;

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
       SELECT coalesce(observations.payload_json, document.value) AS payload
       FROM aruba_remote_observations observations
       LEFT JOIN aruba_sync_pages pages
         ON pages.sync_session_id = observations.sync_session_id
        AND pages.stream = observations.stream
        AND pages.scan_ordinal = observations.scan_ordinal
        AND pages.page_ordinal = observations.page_ordinal
       LEFT JOIN LATERAL jsonb_array_elements(pages.documents_json) document(value)
         ON document.value ->> 'remoteId' = remote.remote_id
       WHERE observations.remote_document_id = remote.id
         AND coalesce(observations.payload_json, document.value) IS NOT NULL
       ORDER BY observations.observed_at DESC, observations.id DESC
       LIMIT 1
     ) latest ON true
     WHERE remote.environment = $1 AND remote.account_reference = $2
       AND matches.matcher_version < $3
       AND remote.document_type = ANY($4::text[])
       AND remote.remote_status <> 'REJECTED'
       AND matches.method <> 'MANUAL'
       AND matches.status NOT IN ('ERROR', 'UNKNOWN_REMOTE_STATE')
       AND (remote.document_type <> 'TD01' OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(matches.candidates_json) external_candidate
         WHERE ${arubaExternalEvidenceCandidateSql("external_candidate", "remote")}
            OR ${arubaTaxIdentityReplayCandidateSql("external_candidate", "remote")}
       ))
       AND (((remote.document_type = 'TD01' AND EXISTS (
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
           AND (refunds.credit_document_id IS NULL OR EXISTS (
             SELECT 1 FROM documents credit
             WHERE credit.id = refunds.credit_document_id
               AND credit.kind = 'CREDIT_NOTE' AND (
                 credit.status = 'DRAFT' OR (
                   credit.status = 'APPROVED' AND credit.document_type = 'TD04'
                   AND credit.fiscal_year = remote.fiscal_year
                   AND lower(btrim(credit.series)) = lower(btrim(remote.series))
                   AND credit.fiscal_number = CASE
                     WHEN remote.fiscal_number ~ '^[0-9]+$'
                       THEN remote.fiscal_number::integer
                   END
                   AND credit.total_amount = remote.total_amount
                 )
               )
           ))
       ))) OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(matches.candidates_json) candidate
         WHERE coalesce((candidate ->> 'potential')::boolean, false)
            OR coalesce((candidate ->> 'compatible')::boolean, false)
            OR coalesce((candidate ->> 'reviewable')::boolean, false)
            OR (
              coalesce((candidate -> 'signals' ->> 'provider')::boolean, false)
              AND coalesce((candidate -> 'signals' ->> 'nearDate')::boolean, false)
              AND coalesce((candidate -> 'signals' ->> 'recipient')::boolean, false)
              AND NOT coalesce((candidate -> 'signals' ->> 'total')::boolean, false)
            )
            OR ${arubaTaxIdentityReplayCandidateSql("candidate", "remote")}
       ))
     ORDER BY remote.id`,
    [environment, account, ARUBA_MATCHER_VERSION, [...ARUBA_MATCHER_REPLAY_DOCUMENT_TYPES]],
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

export async function upgradeCachedArubaMatcher(
  client: pg.PoolClient,
  environment: "MOCK" | "PRODUCTION",
  account: string,
) {
  const touched: string[] = [];
  await reconcileCachedArubaMatcherUpgrade(
    client,
    environment,
    account,
    async (remoteDocumentId, observed) => {
      touched.push(remoteDocumentId);
      const official = await loadLatestOfficialXml(client, remoteDocumentId);
      await reconcileRemoteDocument(
        client,
        remoteDocumentId,
        official ? officialEvidence(observed, official.xml) : observed,
        Boolean(official),
      );
    },
  );
  await reconcileAutomaticAmbiguousInvoices(client, touched);
  for (const remoteDocumentId of touched) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- L'upgrade conserva la serializzazione fiscale dell'inventario.
    await materializeLatestOfficialXml(client, remoteDocumentId);
  }
  return touched.length;
}
