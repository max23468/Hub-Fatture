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

/** Un ordine annullato, rimborsato o storico non riconciliato non entra in una preparazione. */
export const orderBillableSql = (alias = "orders") =>
  `${alias}.cancelled_at IS NULL AND ${alias}.payment_status <> 'REFUNDED' AND ${alias}.trigger_status NOT IN ('LEGACY_BILLING_REVIEW', 'REFUNDED_BEFORE_ISSUE') AND (NOT coalesce((${alias}.normalized_snapshot_json ->> 'historical')::boolean, false) OR ${alias}.historical_reconciliation_outcome = 'NOT_INVOICED')`;

export const orderNotBillableSql = (alias = "orders") =>
  `(${alias}.cancelled_at IS NOT NULL OR ${alias}.payment_status = 'REFUNDED' OR ${alias}.trigger_status IN ('LEGACY_BILLING_REVIEW', 'REFUNDED_BEFORE_ISSUE') OR (coalesce((${alias}.normalized_snapshot_json ->> 'historical')::boolean, false) AND ${alias}.historical_reconciliation_outcome IS DISTINCT FROM 'NOT_INVOICED'))`;

/**
 * Un tentativo pendente non rappresenta più un saldo aperto quando gli incassi riusciti
 * coprono già l'intero totale dell'ordine. Le righe restano nello storico del provider.
 */
export const pendingPaymentSql = (alias = "orders") =>
  `((${alias}.payment_status = 'PENDING' OR EXISTS (
      SELECT 1 FROM payments AS pending_payment
      WHERE pending_payment.order_id = ${alias}.id AND pending_payment.status = 'PENDING'
    )) AND coalesce((
      SELECT sum(paid_payment.amount) FROM payments AS paid_payment
      WHERE paid_payment.order_id = ${alias}.id AND paid_payment.status = 'PAID'
    ), 0) < ${alias}.gross_amount)`;

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

/** Un possibile documento Aruba non ancora risolto trattiene la preparazione. */
export const arubaPotentialMatchSql = `EXISTS (
  SELECT 1
  FROM aruba_document_matches AS aruba_matches
  JOIN aruba_remote_documents AS aruba_remote
    ON aruba_remote.id = aruba_matches.remote_document_id
  CROSS JOIN LATERAL jsonb_array_elements(aruba_matches.candidates_json) AS aruba_candidate
  WHERE aruba_matches.status IN ('UNMATCHED', 'AMBIGUOUS')
    AND aruba_matches.method <> 'MANUAL'
    AND aruba_remote.remote_status <> 'REJECTED'
    AND coalesce((aruba_candidate ->> 'potential')::boolean, false)
    AND (
      aruba_candidate ->> 'candidateId' IN (
        SELECT aruba_orders.id::text FROM orders AS aruba_orders
        WHERE aruba_orders.billing_case_id = billing_cases.id
      )
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(
          coalesce(aruba_candidate -> 'orderIds', '[]'::jsonb)
        ) AS aruba_candidate_order_id
        JOIN orders AS aruba_orders
          ON aruba_orders.id::text = aruba_candidate_order_id
        WHERE aruba_orders.billing_case_id = billing_cases.id
      )
    )
)`;

/** Il primo fatto che impedisce di riattivare la preparazione, nell'ordine in cui va spiegato. */
export const reactivationBlockerSql = `CASE
  WHEN NOT ${hasCaseOrdersSql} THEN 'EMPTY'
  WHEN ${hasIncompatibleCaseOrdersSql} THEN 'INCOMPATIBLE_ORDERS'
  WHEN ${hasOtherOpenCaseSql} THEN 'OTHER_OPEN_CASE'
  ELSE NULL
END`;
