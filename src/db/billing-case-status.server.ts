import type pg from "pg";

import {
  arubaPotentialMatchSql,
  customerProfileMismatchSql,
  openBillingCaseSql,
} from "./billing-case-sql.server.ts";

export async function recomputeBillingCaseStatus(client: pg.PoolClient, caseId: string) {
  // I frammenti interpolati sono costanti di modulo di billing-case-sql.server.ts:
  // nessun valore della richiesta entra nel testo SQL, i dati restano in $1.
  // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk
  const result = await client.query<{ status: string }>(
    `UPDATE billing_cases
     SET status = CASE
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
         END,
         revision = revision + 1,
         updated_at = now()
     WHERE id = $1 AND ${openBillingCaseSql()}
     RETURNING status`,
    [caseId],
  );
  return result.rows[0]?.status ?? null;
}
