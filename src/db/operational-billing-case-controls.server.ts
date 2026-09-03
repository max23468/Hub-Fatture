import { openBillingCaseReasonCodesSql } from "./billing-case-operational-projection.server.ts";
import { openBillingCaseSql } from "./billing-case-sql.server.ts";
import { getPool } from "./client.server.ts";

export type OperationalBillingCaseAnomaly =
  | "TOTALS_MISMATCH"
  | "CUSTOMER_MISMATCH"
  | "SOURCE_CONFLICT"
  | "ORDER_NOT_BILLABLE";

/** Cause della preparazione che non hanno già una propria identità operativa. */
export async function listOperationalBillingCaseAnomalies() {
  const result = await getPool().query<{
    id: string;
    public_number: string;
    customer_name: string;
    local_order_date: string;
    anomaly: OperationalBillingCaseAnomaly;
    order_references: string[];
    updated_at: string;
  }>(
    `SELECT billing_cases.id::text, billing_cases.public_number,
            billing_cases.customer_snapshot_json ->> 'displayName' AS customer_name,
            billing_cases.local_order_date::text,
            anomalies.anomaly::text AS anomaly,
            coalesce((
              SELECT jsonb_agg(
                orders.display_number || ' ' ||
                  CASE orders.provider WHEN 'SHOPIFY' THEN 'Shopify' ELSE 'eBay' END
                ORDER BY orders.id
              )
              FROM orders
              WHERE orders.billing_case_id = billing_cases.id
            ), '[]'::jsonb) AS order_references,
            billing_cases.updated_at::text
     FROM billing_cases
     CROSS JOIN LATERAL unnest(${openBillingCaseReasonCodesSql("false")}) AS anomalies(anomaly)
     WHERE ${openBillingCaseSql("billing_cases")}
       AND anomalies.anomaly = ANY($1::text[])
     ORDER BY billing_cases.updated_at, billing_cases.id, anomalies.anomaly`,
    [["TOTALS_MISMATCH", "CUSTOMER_MISMATCH", "SOURCE_CONFLICT", "ORDER_NOT_BILLABLE"]],
  );
  return result.rows;
}
