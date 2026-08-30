import {
  loadLatestOfficialXml,
  materializeLatestOfficialXml,
  officialEvidence,
  reconcileAutomaticAmbiguousInvoices,
} from "./aruba-document-materialization.server.ts";
import {
  arubaAccountReference as accountReference,
  arubaRuntimeEnvironment as environment,
  lockArubaInventory,
} from "./aruba-inventory-context.server.ts";
import { latestObservedRemote } from "./aruba-document-materialization.server.ts";
import { recomputeBillingCaseStatus } from "./billing-case-status.server.ts";
import { withTransaction } from "./client.server.ts";
import { isDatabaseId } from "./database-id.ts";
import { reconcileRemoteDocument } from "./aruba-reconciliation.server.ts";

/**
 * Ricalcola i documenti Aruba già acquisiti quando cambia lo snapshot locale della
 * preparazione. Le decisioni manuali restano intatte; gli altri candidati vengono
 * rivalutati sull'XML ufficiale più recente prima di aggiornare lo stato del caso.
 */
export async function rematchCachedArubaDocumentsForBillingCase(caseId: string) {
  if (!isDatabaseId(caseId)) return null;
  return withTransaction(async (client) => {
    await lockArubaInventory(client);
    const remotes = await client.query<{ id: string }>(
      `SELECT DISTINCT remote.id::text
       FROM aruba_document_matches AS matches
       JOIN aruba_remote_documents AS remote ON remote.id = matches.remote_document_id
       CROSS JOIN LATERAL jsonb_array_elements(
         coalesce(matches.candidates_json, '[]'::jsonb)
       ) AS candidate
       WHERE remote.environment = $2 AND remote.account_reference = $3
         AND matches.method <> 'MANUAL'
         AND EXISTS (
           SELECT 1 FROM orders AS case_order
           WHERE case_order.billing_case_id = $1
             AND (
               candidate ->> 'candidateId' = case_order.id::text
               OR (candidate -> 'orderIds') ? case_order.id::text
             )
         )
       ORDER BY remote.id::text`,
      [caseId, environment(), accountReference()],
    );
    const touched = remotes.rows.map((remote) => remote.id);
    for (const remoteDocumentId of touched) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Il lock inventario rende sequenziale la rivalutazione dello stesso caso.
      const observed = await latestObservedRemote(client, remoteDocumentId);
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Ogni documento usa il proprio file ufficiale più recente.
      const official = await loadLatestOfficialXml(client, remoteDocumentId);
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Lo stato successivo dipende dalla rivalutazione corrente.
      await reconcileRemoteDocument(
        client,
        remoteDocumentId,
        official ? officialEvidence(observed, official.xml) : observed,
        Boolean(official),
      );
    }
    await reconcileAutomaticAmbiguousInvoices(client, touched);
    for (const remoteDocumentId of touched) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- La materializzazione fiscale resta seriale sotto lo stesso lock.
      await materializeLatestOfficialXml(client, remoteDocumentId);
    }
    return recomputeBillingCaseStatus(client, caseId, true);
  });
}
