import type pg from "pg";

export interface ArubaApiFileAuthorization {
  type: "API";
  runId: string;
  providerGroupId: string;
  providerFilename: string;
  expectedDocumentFilename: string | undefined;
  expectedInvoiceNumber: string;
  requiresInvoiceNumber: boolean;
  notificationInvoiceNumber?: string;
  notificationId?: string;
}

interface ArubaApiFileSession {
  id: string;
  environment: "MOCK" | "PRODUCTION";
  account_reference: string;
}

export async function matchesArubaApiDocumentIdentity(
  client: pg.Pool | pg.PoolClient,
  remoteDocumentId: string,
  session: ArubaApiFileSession,
  authorization: ArubaApiFileAuthorization,
) {
  const owned = await client.query<{
    provider_group_id: string | null;
    provider_invoice_number: string | null;
  }>(
    `SELECT remote.provider_group_id,
       observations.payload_json ->> 'providerInvoiceNumber' AS provider_invoice_number
     FROM aruba_remote_documents AS remote
     LEFT JOIN LATERAL (
       SELECT payload_json FROM aruba_remote_observations
       WHERE remote_document_id = remote.id AND sync_run_id = $4
       ORDER BY id DESC LIMIT 1
     ) AS observations ON true
     WHERE remote.id = $1 AND remote.environment = $2 AND remote.account_reference = $3`,
    [remoteDocumentId, session.environment, session.account_reference, authorization.runId],
  );
  return (
    owned.rows[0]?.provider_group_id === authorization.providerGroupId &&
    owned.rows[0]?.provider_invoice_number === authorization.expectedInvoiceNumber
  );
}

export async function loadArubaApiFileSession(
  client: pg.Pool | pg.PoolClient,
  authorization: ArubaApiFileAuthorization,
  lock = false,
) {
  const result = lock
    ? await client.query<ArubaApiFileSession>(
        `SELECT runs.id, runs.environment, runs.account_reference
         FROM aruba_sync_runs AS runs
         JOIN connections ON connections.provider = 'ARUBA'
           AND connections.environment = CASE WHEN runs.environment = 'PRODUCTION'
             THEN 'PRODUCTION' ELSE 'DEVELOPMENT' END
           AND connections.account_reference = runs.account_reference
         WHERE runs.id = $1 AND runs.status = 'RUNNING'
           AND runs.authority_mode = 'CANONICAL'
           AND connections.automatic_authority = 'API'
         FOR UPDATE OF runs, connections`,
        [authorization.runId],
      )
    : await client.query<ArubaApiFileSession>(
        `SELECT runs.id, runs.environment, runs.account_reference
         FROM aruba_sync_runs AS runs
         JOIN connections ON connections.provider = 'ARUBA'
           AND connections.environment = CASE WHEN runs.environment = 'PRODUCTION'
             THEN 'PRODUCTION' ELSE 'DEVELOPMENT' END
           AND connections.account_reference = runs.account_reference
         WHERE runs.id = $1 AND runs.status = 'RUNNING'
           AND runs.authority_mode = 'CANONICAL'
           AND connections.automatic_authority = 'API'`,
        [authorization.runId],
      );
  return result.rows[0] ?? null;
}
