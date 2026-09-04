import type pg from "pg";

import { getPool } from "./client.server.ts";

export interface ReleaseCandidateReadinessState {
  unreconciledDryRunAttempts: number;
  unreconciledHistory: number;
  pendingHistoryImports: number;
  openArubaBatches: number;
}

export async function releaseCandidateReadinessState(
  client: pg.Pool | pg.PoolClient = getPool(),
): Promise<ReleaseCandidateReadinessState> {
  const result = await client.query<{
    unreconciled_dry_run_attempts: string;
    unreconciled_history: string;
    pending_history_imports: string;
    open_aruba_batches: string;
  }>(
    `SELECT
       (SELECT count(*) FROM aruba_submission_attempts AS attempts
        JOIN aruba_submissions AS submissions ON submissions.id = attempts.submission_id
        JOIN aruba_batches AS batches ON batches.id = submissions.batch_id
        WHERE attempts.operation = 'DRY_RUN'
          AND submissions.environment = 'PRODUCTION'
          AND (attempts.status IN ('RUNNING', 'UNKNOWN_REMOTE_STATE')
            OR submissions.status = 'UNKNOWN_REMOTE_STATE'
            OR batches.requires_reconciliation))::text AS unreconciled_dry_run_attempts,
       (SELECT count(*) FROM orders
        WHERE coalesce((normalized_snapshot_json ->> 'historical')::boolean, false)
          AND ((historical_reconciliation_outcome IS NULL
              AND (trigger_status <> 'LEGACY_BILLING_REVIEW'
                OR historical_reconciled_at IS NOT NULL
                OR billing_case_id IS NOT NULL
                OR EXISTS (
                  SELECT 1 FROM document_orders
                  WHERE document_orders.order_id = orders.id)))
            OR (historical_reconciliation_outcome = 'ALREADY_INVOICED'
              AND NOT EXISTS (
                SELECT 1 FROM document_orders
                JOIN documents ON documents.id = document_orders.document_id
                WHERE document_orders.order_id = orders.id
                  AND documents.origin = 'ARUBA_HISTORY'))))::text
         AS unreconciled_history,
       (SELECT count(*) FROM (VALUES ('SHOPIFY'), ('EBAY')) AS expected(provider)
        WHERE NOT EXISTS (
          SELECT 1 FROM connections
          WHERE connections.provider = expected.provider
            AND connections.environment = 'PRODUCTION'
            AND connections.status = 'CONNECTED'
            AND EXISTS (
              SELECT 1 FROM sync_cursors
              WHERE sync_cursors.provider = connections.provider
                AND sync_cursors.stream = 'history_import')))::text
         AS pending_history_imports,
       (SELECT count(*) FROM aruba_batches
        WHERE aruba_batches.status NOT IN ('RECONCILED', 'CANCELLED', 'DOCUMENT_ONLY'))::text
         AS open_aruba_batches`,
  );
  const row = result.rows[0]!;
  return {
    unreconciledDryRunAttempts: Number(row.unreconciled_dry_run_attempts),
    unreconciledHistory: Number(row.unreconciled_history),
    pendingHistoryImports: Number(row.pending_history_imports),
    openArubaBatches: Number(row.open_aruba_batches),
  };
}
