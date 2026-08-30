import type pg from "pg";

import {
  arubaPotentialMatchSql,
  customerProfileMismatchSql,
  openBillingCaseSql,
} from "./billing-case-sql.server.ts";

export async function recomputeBillingCaseStatus(
  client: pg.PoolClient,
  caseId: string,
  onlyWhenStatusChanges = false,
) {
  // I frammenti interpolati sono costanti di modulo di billing-case-sql.server.ts:
  // nessun valore della richiesta entra nel testo SQL, i dati restano in $1.
  // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk
  const result = await client.query<{ status: string }>(
    `WITH desired AS (
       SELECT billing_cases.id, CASE
           WHEN ${arubaPotentialMatchSql}
             OR coalesce((customer_snapshot_json ->> 'reviewRequired')::boolean, true)
             OR EXISTS (
               SELECT 1 FROM orders
               WHERE orders.billing_case_id = billing_cases.id
                 AND (
                   coalesce(
                     (orders.normalized_snapshot_json ->> 'orderReviewRequired')::boolean, true)
                   OR coalesce(
                     (orders.normalized_snapshot_json ->> 'deferredReviewRequired')::boolean, false)
                   OR orders.trigger_status = 'NEEDS_REVIEW'
                   OR ${customerProfileMismatchSql}
                 )
             )
           THEN 'NEEDS_REVIEW'
           ELSE 'READY'
         END AS status
       FROM billing_cases
       WHERE id = $1 AND ${openBillingCaseSql()}
     ), updated AS (
       UPDATE billing_cases
       SET status = desired.status, revision = revision + 1, updated_at = now()
       FROM desired
       WHERE billing_cases.id = desired.id
         AND (NOT $2::boolean OR billing_cases.status IS DISTINCT FROM desired.status)
       RETURNING billing_cases.status
     )
     SELECT status FROM updated
     UNION ALL
     SELECT status FROM desired WHERE NOT EXISTS (SELECT 1 FROM updated)
     LIMIT 1`,
    [caseId, onlyWhenStatusChanges],
  );
  return result.rows[0]?.status ?? null;
}

/**
 * Chiusura di riconciliazione dopo ogni run Aruba canonico. Ricalcola in un solo
 * passaggio tutti i casi aperti, così un segnale debole smentito dall'XML ufficiale
 * non resta memorizzato come revisione manuale fino a un successivo evento ordine.
 */
export async function recomputeOpenBillingCaseStatuses(client: pg.PoolClient) {
  const result = await client.query<{ updated_count: number }>(
    `WITH desired AS (
       SELECT billing_cases.id, CASE
           WHEN ${arubaPotentialMatchSql}
             OR coalesce((customer_snapshot_json ->> 'reviewRequired')::boolean, true)
             OR EXISTS (
               SELECT 1 FROM orders
               WHERE orders.billing_case_id = billing_cases.id
                 AND (
                   coalesce(
                     (orders.normalized_snapshot_json ->> 'orderReviewRequired')::boolean, true)
                   OR coalesce(
                     (orders.normalized_snapshot_json ->> 'deferredReviewRequired')::boolean, false)
                   OR orders.trigger_status = 'NEEDS_REVIEW'
                   OR ${customerProfileMismatchSql}
                 )
             )
           THEN 'NEEDS_REVIEW'
           ELSE 'READY'
         END AS status
       FROM billing_cases
       WHERE billing_cases.status IN ('READY', 'NEEDS_REVIEW')
     ), updated AS (
       UPDATE billing_cases
       SET status = desired.status, revision = revision + 1, updated_at = now()
       FROM desired
       WHERE billing_cases.id = desired.id
         AND billing_cases.status IS DISTINCT FROM desired.status
       RETURNING billing_cases.id
     )
     SELECT count(*)::integer AS updated_count FROM updated`,
  );
  return result.rows[0]?.updated_count ?? 0;
}
