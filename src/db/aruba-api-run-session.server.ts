import type pg from "pg";

export interface ArubaApiFileAuthorization {
  type: "API";
  runId: string;
  providerGroupId: string;
  providerFilename: string;
  expectedDocumentFilename: string | undefined;
  notificationId?: string;
}

export async function loadArubaApiFileSession(
  client: pg.Pool | pg.PoolClient,
  authorization: ArubaApiFileAuthorization,
  lock = false,
) {
  type SessionRow = {
    id: string;
    environment: "MOCK" | "PRODUCTION";
    account_reference: string;
  };
  const result = lock
    ? await client.query<SessionRow>(
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
    : await client.query<SessionRow>(
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
