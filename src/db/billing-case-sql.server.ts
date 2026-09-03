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
  `${alias}.cancelled_at IS NULL AND ${alias}.payment_status <> 'REFUNDED' AND ${alias}.trigger_status NOT IN ('INVOICED', 'LEGACY_BILLING_REVIEW', 'REFUNDED_BEFORE_ISSUE') AND NOT ${approvedInvoiceOrderLinkSql(alias)} AND (NOT coalesce((${alias}.normalized_snapshot_json ->> 'historical')::boolean, false) OR ${alias}.historical_reconciliation_outcome = 'NOT_INVOICED')`;

export const orderNotBillableSql = (alias = "orders") =>
  `(${alias}.cancelled_at IS NOT NULL OR ${alias}.payment_status = 'REFUNDED' OR ${alias}.trigger_status IN ('INVOICED', 'LEGACY_BILLING_REVIEW', 'REFUNDED_BEFORE_ISSUE') OR ${approvedInvoiceOrderLinkSql(alias)} OR (coalesce((${alias}.normalized_snapshot_json ->> 'historical')::boolean, false) AND ${alias}.historical_reconciliation_outcome IS DISTINCT FROM 'NOT_INVOICED'))`;

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

/** Ordini ancora fatturabili con incasso aperto e senza una preparazione che li rappresenti. */
export const unpreparedPendingPaymentSql = (alias = "orders") =>
  `${alias}.billing_case_id IS NULL AND ${orderBillableSql(alias)} AND ${pendingPaymentSql(alias)}`;

/** Le code Dashboard sono disgiunte: il pagamento pendente ha precedenza sulla revisione. */
export const billingCasePendingPaymentSql = (alias = "billing_cases") => `EXISTS (
  SELECT 1 FROM orders AS pending_case_order
  WHERE pending_case_order.billing_case_id = ${alias}.id
    AND ${pendingPaymentSql("pending_case_order")}
)`;

/** Un documento approvato collegato rende l'ordine definitivamente già fatturato. */
export const approvedInvoiceOrderLinkSql = (orderAlias = "orders") => `EXISTS (
  SELECT 1
  FROM document_orders AS issued_document_orders
  JOIN documents AS issued_documents
    ON issued_documents.id = issued_document_orders.document_id
  WHERE issued_document_orders.order_id = ${orderAlias}.id
    AND issued_document_orders.document_kind = 'INVOICE'
    AND issued_documents.status = 'APPROVED'
)`;

/** Una preparazione con almeno un ordine già fatturato resta fail-closed per intero. */
export const billingCaseHasApprovedInvoiceOrderSql = (alias = "billing_cases") => `EXISTS (
  SELECT 1
  FROM orders AS issued_case_order
  WHERE issued_case_order.billing_case_id = ${alias}.id
    AND ${approvedInvoiceOrderLinkSql("issued_case_order")}
)`;

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

/**
 * Un segnale debole (data/importo/nome) serve soltanto finché non è disponibile
 * l'XML ufficiale. Dopo il download del file, trattiene il caso anche quando
 * data, importo e almeno un'identità coincidono: il collegamento resta manuale,
 * ma il documento non deve sparire dalla coda prima della decisione.
 * Anche data vicina e destinatario coincidente, senza totale coerente, sono
 * sufficienti a bloccare l'emissione finché manca il file ufficiale: possono
 * indicare una fattura già emessa con una diversa composizione dell'importo.
 */
export const arubaActionableCandidateSql = (
  candidateAlias = "aruba_candidate",
  remoteAlias = "aruba_remote",
) => `(
  coalesce((${candidateAlias} ->> 'compatible')::boolean, false)
  OR coalesce((${candidateAlias} ->> 'reviewable')::boolean, false)
  OR coalesce((${candidateAlias} -> 'signals' ->> 'explicitReference')::boolean, false)
  OR (${remoteAlias}.xml_sha256 IS NULL AND (
    coalesce((${candidateAlias} ->> 'probe')::boolean, false)
    OR coalesce((${candidateAlias} ->> 'potential')::boolean, false)
    OR (
      coalesce((${candidateAlias} -> 'signals' ->> 'nearDate')::boolean, false)
      AND coalesce((${candidateAlias} -> 'signals' ->> 'recipient')::boolean, false)
    )
  ))
)`;

/**
 * L'XML ufficiale può confermare destinatario e prossimità temporale senza confermare
 * il totale. Il candidato non è collegabile automaticamente: resta visibile e trattiene
 * soltanto la preparazione correlata finché il proprietario non conferma esplicitamente
 * il collegamento con differenza oppure lo esclude dal perimetro.
 */
export const arubaAmountMismatchCandidateSql = (
  candidateAlias = "aruba_candidate",
  remoteAlias = "aruba_remote",
) => `(
  ${remoteAlias}.xml_sha256 IS NOT NULL
  AND ${candidateAlias} ->> 'issuedInvoiceDocumentId' IS NULL
  AND coalesce((${candidateAlias} -> 'signals' ->> 'provider')::boolean, false)
  AND coalesce((${candidateAlias} -> 'signals' ->> 'nearDate')::boolean, false)
  AND (
    coalesce((${candidateAlias} -> 'signals' ->> 'recipient')::boolean, false)
    OR coalesce((${candidateAlias} -> 'signals' ->> 'fiscalCode')::boolean, false)
    OR (
      coalesce((${candidateAlias} -> 'signals' ->> 'taxId')::boolean, false)
      AND coalesce((${candidateAlias} -> 'signals' ->> 'address')::boolean, false)
    )
  )
  AND NOT coalesce((${candidateAlias} -> 'signals' ->> 'total')::boolean, false)
)`;

/**
 * Una prova esterna può identificare un documento con stesso giorno e totale anche
 * quando l'anagrafica fiscale non coincide. Il segnale resta non automatico e non
 * blocca da solo la preparazione: serve la doppia conferma esplicita del titolare.
 */
export const arubaExternalEvidenceCandidateSql = (
  candidateAlias = "aruba_candidate",
  remoteAlias = "aruba_remote",
) => `(
  ${remoteAlias}.xml_sha256 IS NOT NULL
  AND ${candidateAlias} ->> 'issuedInvoiceDocumentId' IS NULL
  AND coalesce((${candidateAlias} ->> 'probe')::boolean, false)
  AND coalesce((${candidateAlias} -> 'signals' ->> 'provider')::boolean, false)
  AND coalesce((${candidateAlias} -> 'signals' ->> 'sameDay')::boolean, false)
  AND coalesce((${candidateAlias} -> 'signals' ->> 'total')::boolean, false)
  AND NOT coalesce((${candidateAlias} -> 'signals' ->> 'recipient')::boolean, false)
  AND NOT coalesce((${candidateAlias} -> 'signals' ->> 'taxId')::boolean, false)
  AND NOT coalesce((${candidateAlias} -> 'signals' ->> 'address')::boolean, false)
)`;

/** Un candidato che richiede una decisione sulla singola preparazione. */
export const arubaCaseCandidateSql = (
  candidateAlias = "aruba_candidate",
  remoteAlias = "aruba_remote",
) => `(
  ${arubaActionableCandidateSql(candidateAlias, remoteAlias)}
  OR ${arubaAmountMismatchCandidateSql(candidateAlias, remoteAlias)}
)`;

export const standardInvoiceApprovalCriteriaSql = (
  billingCaseAlias = "billing_cases",
  documentAlias = "documents",
  fiscalProfileAlias = "fiscal_profiles",
) => `(
  ${documentAlias}.kind = 'INVOICE'
  AND ${documentAlias}.status = 'DRAFT'
  AND ${documentAlias}.difference_amount = 0
  AND ${documentAlias}.payment_status = 'PAID'
  AND ${documentAlias}.projection_sha256 <> repeat('0', 64)
  AND ${documentAlias}.document_date =
    (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Rome')::date
  AND ${billingCaseAlias}.status = 'READY'
  AND ${fiscalProfileAlias}.status IN ('MOCK', 'AUDITED')
)`;

/**
 * La proposta server-side di una preparazione READY è approvabile senza un salvataggio
 * preventivo. Una bozza già materializzata conserva invece i gate stretti su data, hash,
 * pagamento e differenza usati dall'approvazione massiva.
 */
export const standardInvoiceApprovalCandidateSql = (
  billingCaseAlias = "billing_cases",
  documentAlias = "documents",
  fiscalProfileAlias = "fiscal_profiles",
) => `(
  ${billingCaseAlias}.status = 'READY'
  AND NOT ${billingCasePendingPaymentSql(billingCaseAlias)}
  AND NOT ${billingCaseHasApprovedInvoiceOrderSql(billingCaseAlias)}
  AND (
    (
      ${documentAlias}.id IS NULL
      AND EXISTS (
        SELECT 1 FROM orders AS approval_order
        WHERE approval_order.billing_case_id = ${billingCaseAlias}.id
      )
      AND EXISTS (
        SELECT 1 FROM fiscal_profiles AS active_approval_profile
        WHERE active_approval_profile.status IN ('MOCK', 'AUDITED')
      )
    )
    OR ${standardInvoiceApprovalCriteriaSql(billingCaseAlias, documentAlias, fiscalProfileAlias)}
  )
)`;

/** Il candidato standard correlato a una preparazione, riusato da liste e contatori. */
export const billingCaseApprovalCandidateSql = (billingCaseAlias = "billing_cases") => `EXISTS (
  SELECT 1
  FROM billing_cases AS approval_case
  LEFT JOIN documents AS approval_document
    ON approval_document.billing_case_id = approval_case.id
   AND approval_document.kind = 'INVOICE'
  LEFT JOIN fiscal_profiles AS approval_profile
    ON approval_profile.version = approval_document.fiscal_profile_version
  WHERE approval_case.id = ${billingCaseAlias}.id
    AND ${standardInvoiceApprovalCandidateSql(
      "approval_case",
      "approval_document",
      "approval_profile",
    )}
)`;

/** Un possibile documento Aruba non ancora risolto trattiene la preparazione. */
export const arubaPotentialMatchSql = `EXISTS (
  SELECT 1
  FROM aruba_document_matches AS aruba_matches
  JOIN aruba_remote_documents AS aruba_remote
    ON aruba_remote.id = aruba_matches.remote_document_id
  CROSS JOIN LATERAL jsonb_array_elements(aruba_matches.candidates_json) AS aruba_candidate
  WHERE aruba_remote.remote_status <> 'REJECTED'
    AND (
      (aruba_matches.method <> 'MANUAL' AND (
        (aruba_matches.status = 'UNMATCHED'
          AND ${arubaCaseCandidateSql()})
        OR (aruba_matches.status = 'AMBIGUOUS'
          AND ${arubaCaseCandidateSql()})
        OR (aruba_matches.status = 'MATCHED'
          AND aruba_remote.remote_status IN ('SUBMITTED', 'SDI_PROCESSING')
          AND coalesce((aruba_candidate ->> 'compatible')::boolean, false))
        OR (aruba_matches.status = 'PROFILE_CONFLICT'
          AND ${arubaCaseCandidateSql()})
      ))
      OR (aruba_matches.method = 'MANUAL'
        AND aruba_matches.status = 'MATCHED'
        AND aruba_remote.remote_status IN ('SUBMITTED', 'SDI_PROCESSING')
        AND aruba_candidate ->> 'candidateId' = aruba_matches.order_id::text)
    )
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
