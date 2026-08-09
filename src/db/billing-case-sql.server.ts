/**
 * Frammenti SQL delle regole che il lock e la lettura devono applicare allo stesso modo.
 * Scritte due volte divergono in silenzio: la scheda offrirebbe un'azione che la transazione
 * poi rifiuta. Vivono qui una volta sola e le due query si compongono dagli stessi pezzi.
 */

/** Gli stati in cui una preparazione è ancora aperta e modificabile. */
export const OPEN_BILLING_CASE_STATUSES = ["DRAFT", "READY", "NEEDS_REVIEW"] as const;

const openStatusList = OPEN_BILLING_CASE_STATUSES.map((status) => `'${status}'`).join(", ");

export const openBillingCaseSql = (alias = "billing_cases") =>
  `${alias}.status IN (${openStatusList})`;

/** Un ordine annullato o rimborsato non entra in una preparazione e ne blocca la riattivazione. */
export const orderBillableSql = (alias = "orders") =>
  `${alias}.cancelled_at IS NULL AND ${alias}.payment_status <> 'REFUNDED' AND ${alias}.trigger_status <> 'LEGACY_BILLING_REVIEW'`;

export const orderNotBillableSql = (alias = "orders") =>
  `(${alias}.cancelled_at IS NOT NULL OR ${alias}.payment_status = 'REFUNDED' OR ${alias}.trigger_status = 'LEGACY_BILLING_REVIEW')`;

export const hasCaseOrdersSql = `EXISTS (
  SELECT 1 FROM orders WHERE orders.billing_case_id = billing_cases.id
)`;

export const hasIncompatibleCaseOrdersSql = `EXISTS (
  SELECT 1 FROM orders
  WHERE orders.billing_case_id = billing_cases.id
    AND ${orderNotBillableSql()}
)`;

export const hasOtherOpenCaseSql = `EXISTS (
  SELECT 1 FROM billing_cases AS other
  WHERE other.id <> billing_cases.id
    AND other.customer_id = billing_cases.customer_id
    AND other.local_order_date = billing_cases.local_order_date
    AND other.currency = billing_cases.currency
    AND ${openBillingCaseSql("other")}
)`;

/**
 * Il destinatario della preparazione ha smesso di coincidere con l'anagrafica importata
 * dall'ordine, e nessuna correzione manuale ha ancora deciso quale delle due vale.
 */
export const customerProfileMismatchSql = `(
  billing_cases.customer_corrected_at IS NULL
  AND orders.normalized_snapshot_json #> '{customerSnapshot,canonicalProfile}'
      IS DISTINCT FROM billing_cases.customer_snapshot_json -> 'canonicalProfile'
)`;

/** Il primo fatto che impedisce di riattivare la preparazione, nell'ordine in cui va spiegato. */
export const reactivationBlockerSql = `CASE
  WHEN NOT ${hasCaseOrdersSql} THEN 'EMPTY'
  WHEN ${hasIncompatibleCaseOrdersSql} THEN 'INCOMPATIBLE_ORDERS'
  WHEN ${hasOtherOpenCaseSql} THEN 'OTHER_OPEN_CASE'
  ELSE NULL
END`;
