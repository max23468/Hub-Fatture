import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { AppError } from "../../errors.ts";
import { PAGE_SIZE } from "../../orders.ts";
import type { OrdersTestContext } from "./orders-test-support.test.ts";

export async function run(context: OrdersTestContext) {
  const { orders, database, caseRevision, fixture } = context;
  const historicalRefunded = structuredClone(fixture[0]);
  historicalRefunded.externalOrderId = "shop-order-historical-refunded";
  historicalRefunded.externalCustomerId = "shop-customer-historical-refunded";
  historicalRefunded.customer.taxIdentifiers[0].value = "RSSMRA80A01H501F";
  historicalRefunded.createdAt = "2026-08-19T11:00:00Z";
  historicalRefunded.updatedAt = "2026-08-19T12:00:00Z";
  historicalRefunded.historical = true;
  historicalRefunded.refunds = [
    {
      externalRefundId: "historical-total-refund",
      status: "COMPLETED",
      amount: historicalRefunded.total,
      completedAt: "2026-08-19T12:00:00Z",
      raw: {},
    },
  ];
  await orders.importOrders([historicalRefunded], {
    id: 1,
    requestId: "test-historical-refunded-import",
  });
  const historicalRefundedBefore = (
    await database
      .getPool()
      .query(
        `SELECT id, billing_case_id, trigger_status FROM orders WHERE external_order_id = $1`,
        [historicalRefunded.externalOrderId],
      )
  ).rows[0];
  assert.deepEqual(historicalRefundedBefore, {
    id: historicalRefundedBefore.id,
    billing_case_id: null,
    trigger_status: "LEGACY_BILLING_REVIEW",
  });
  const historicalRefundedResult = await orders.reconcileHistoricalOrder(
    historicalRefundedBefore.id,
    {
      outcome: "NOT_INVOICED",
      reference: "Ricerca Aruba per ordine rimborsato: nessun documento emesso",
    },
    { id: 1, canApprove: true, requestId: "test-historical-refunded-reconcile" },
  );
  assert.ok(historicalRefundedResult?.caseId);
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT orders.trigger_status, billing_cases.status
           FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
           WHERE orders.id = $1`,
        [historicalRefundedBefore.id],
      )
    ).rows[0],
    { trigger_status: "REFUNDED_BEFORE_ISSUE", status: "DO_NOT_TRANSMIT" },
  );

  const historicalPartialRefund = structuredClone(historicalRefunded);
  historicalPartialRefund.externalOrderId = "shop-order-historical-partial-refund";
  historicalPartialRefund.externalCustomerId = "shop-customer-historical-partial-refund";
  historicalPartialRefund.customer.taxIdentifiers[0].value = "RSSMRA80A01H501G";
  historicalPartialRefund.createdAt = "2026-08-19T13:00:00Z";
  historicalPartialRefund.updatedAt = "2026-08-19T14:00:00Z";
  historicalPartialRefund.refunds[0].externalRefundId = "historical-partial-refund";
  historicalPartialRefund.refunds[0].amount = "10.00";
  await orders.importOrders([historicalPartialRefund], {
    id: 1,
    requestId: "test-historical-partial-refund-import",
  });
  const historicalPartialId = (
    await database
      .getPool()
      .query("SELECT id FROM orders WHERE external_order_id = $1", [
        historicalPartialRefund.externalOrderId,
      ])
  ).rows[0].id;
  const historicalPartialResult = await orders.reconcileHistoricalOrder(
    historicalPartialId,
    {
      outcome: "NOT_INVOICED",
      reference: "Ricerca Aruba per ordine parzialmente rimborsato: nessun documento",
    },
    { id: 1, canApprove: true, requestId: "test-historical-partial-refund-reconcile" },
  );
  assert.ok(historicalPartialResult?.caseId);
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT orders.trigger_status, billing_cases.status,
                  (SELECT sum(amount)::integer FROM refunds
                   WHERE refunds.order_id = orders.id AND applied_before_issue) AS refunded
           FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
           WHERE orders.id = $1`,
        [historicalPartialId],
      )
    ).rows[0],
    { trigger_status: "GROUPED", status: "READY", refunded: 1000 },
  );

  const concurrentA = structuredClone(fixture[0]);
  concurrentA.externalOrderId = "shop-order-concurrent-a";
  concurrentA.externalCustomerId = "shop-customer-concurrent";
  concurrentA.customer.taxIdentifiers[0].value = "RSSMRA80A01H501Z";
  concurrentA.createdAt = "2026-08-17T08:00:00Z";
  concurrentA.updatedAt = "2026-08-17T09:00:00Z";
  const concurrentB = structuredClone(concurrentA);
  concurrentB.externalOrderId = "shop-order-concurrent-b";
  const concurrentImports = await Promise.all([
    orders.importOrders([concurrentA, concurrentB], {
      id: 1,
      requestId: "test-concurrent-forward",
    }),
    orders.importOrders([concurrentB, concurrentA], {
      id: 1,
      requestId: "test-concurrent-reverse",
    }),
  ]);
  assert.deepEqual(concurrentImports.map(({ imported }) => imported).sort(), [0, 2]);
  // Il criterio chiede una sola preparazione, non solo un solo import vincente.
  assert.equal(
    (
      await database.getPool().query(
        `SELECT count(DISTINCT billing_case_id) FROM orders
           WHERE external_order_id IN ($1, $2)`,
        [concurrentA.externalOrderId, concurrentB.externalOrderId],
      )
    ).rows[0].count,
    "1",
  );

  // 7.3: una preparazione già approvata non assorbe un ordine successivo dello stesso giorno.
  const afterApproval = structuredClone(fixture[0]);
  afterApproval.externalOrderId = "shop-order-after-approval";
  afterApproval.externalCustomerId = "shop-customer-after-approval";
  afterApproval.customer.taxIdentifiers[0].value = "RSSMRA80A01H501B";
  afterApproval.createdAt = "2026-08-23T08:00:00Z";
  afterApproval.updatedAt = "2026-08-23T09:00:00Z";
  await orders.importOrders([afterApproval], { id: 1, requestId: "test-before-approval" });
  const approvedDayCaseId = (
    await database
      .getPool()
      .query("SELECT billing_case_id FROM orders WHERE external_order_id = $1", [
        afterApproval.externalOrderId,
      ])
  ).rows[0].billing_case_id;
  await database
    .getPool()
    .query("UPDATE billing_cases SET status = 'APPROVED' WHERE id = $1", [approvedDayCaseId]);
  const sameDayOrder = structuredClone(afterApproval);
  sameDayOrder.externalOrderId = "shop-order-after-approval-second";
  sameDayOrder.payments[0].externalPaymentId = "shop-payment-after-approval-second";
  await orders.importOrders([sameDayOrder], { id: 1, requestId: "test-after-approval" });
  const sameDayCase = (
    await database.getPool().query(
      `SELECT orders.billing_case_id, billing_cases.status
           FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
           WHERE orders.external_order_id = $1`,
      [sameDayOrder.externalOrderId],
    )
  ).rows[0];
  assert.notEqual(sameDayCase.billing_case_id, approvedDayCaseId);
  assert.equal(sameDayCase.status, "READY");
  assert.equal(
    (
      await database
        .getPool()
        .query("SELECT status FROM billing_cases WHERE id = $1", [approvedDayCaseId])
    ).rows[0].status,
    "APPROVED",
  );

  // Il cambio del trigger non ricrea, non scioglie e non riapre una preparazione esistente.
  // Gli ordini ancora senza preparazione confluiscono invece nel giorno aperto.
  const settledCase = structuredClone(fixture[0]);
  settledCase.externalOrderId = "shop-order-trigger-settled";
  settledCase.externalCustomerId = "shop-customer-trigger-gate";
  settledCase.customer.taxIdentifiers[0].value = "RSSMRA80A01H501C";
  settledCase.createdAt = "2026-08-24T08:00:00Z";
  settledCase.updatedAt = "2026-08-24T09:00:00Z";
  const waitingSameDay = structuredClone(settledCase);
  waitingSameDay.externalOrderId = "shop-order-trigger-waiting";
  waitingSameDay.payments[0].externalPaymentId = "shop-payment-trigger-waiting";
  waitingSameDay.paymentStatus = "PENDING";
  waitingSameDay.payments[0].status = "PENDING";
  waitingSameDay.payments[0].paidAt = null;
  waitingSameDay.fulfillmentStatus = "FULFILLED";
  await database.getPool().query(
    `UPDATE settings SET value_json = '"PAID"', version = version + 1
       WHERE key = 'draft_trigger'`,
  );
  await orders.importOrders([settledCase, waitingSameDay], {
    id: 1,
    requestId: "test-trigger-gate-import",
  });
  const gateCaseBefore = (
    await database.getPool().query(
      `SELECT billing_cases.id, billing_cases.status,
                (SELECT count(*)::int FROM orders WHERE billing_case_id = billing_cases.id)
                  AS order_count
           FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
           WHERE orders.external_order_id = $1`,
      [settledCase.externalOrderId],
    )
  ).rows[0];
  assert.deepEqual(
    { status: gateCaseBefore.status, order_count: gateCaseBefore.order_count },
    { status: "READY", order_count: 1 },
  );
  const casesBeforeTrigger = (
    await database.getPool().query("SELECT count(*)::int AS total FROM billing_cases")
  ).rows[0].total;
  const triggerVersion = (
    await database.getPool().query("SELECT version FROM settings WHERE key = 'draft_trigger'")
  ).rows[0].version;
  await orders.setDraftTrigger("FULFILLED", triggerVersion, {
    id: 1,
    requestId: "test-trigger-gate-change",
  });
  const gateCaseAfter = (
    await database.getPool().query(
      `SELECT id, status,
                (SELECT count(*)::int FROM orders WHERE billing_case_id = billing_cases.id)
                  AS order_count
           FROM billing_cases WHERE id = $1`,
      [gateCaseBefore.id],
    )
  ).rows[0];
  assert.equal(gateCaseAfter.id, gateCaseBefore.id);
  assert.equal(gateCaseAfter.order_count, 2);
  assert.equal(gateCaseAfter.status, "NEEDS_REVIEW");
  assert.equal(
    (await database.getPool().query("SELECT count(*)::int AS total FROM billing_cases")).rows[0]
      .total,
    casesBeforeTrigger,
  );
  assert.equal(
    (
      await database.getPool().query(
        `SELECT count(*) FROM audit_events
           WHERE action = 'BILLING_CASE_CREATED' AND request_id = 'test-trigger-gate-change'`,
      )
    ).rows[0].count,
    "0",
  );

  // 13.5: separazione, aggiunta e ultimo ordine protetto sulla stessa preparazione.
  const gateCaseId = String(gateCaseBefore.id);
  const separatedOrderId = (
    await database
      .getPool()
      .query("SELECT id FROM orders WHERE external_order_id = $1", [waitingSameDay.externalOrderId])
  ).rows[0].id;
  await assert.rejects(
    orders.separateOrderFromBillingCase(gateCaseId, String(separatedOrderId), 0, {
      id: 1,
      requestId: "test-separate-stale-revision",
    }),
    (error: unknown) => error instanceof AppError && error.code === "CONFLICT_REVISION",
  );
  assert.equal(
    await orders.separateOrderFromBillingCase(
      gateCaseId,
      String(separatedOrderId),
      await caseRevision(gateCaseId),
      { id: 1, requestId: "test-separate-order" },
    ),
    "READY",
  );
  assert.deepEqual(
    (
      await database
        .getPool()
        .query("SELECT billing_case_id, trigger_status FROM orders WHERE id = $1", [
          separatedOrderId,
        ])
    ).rows[0],
    { billing_case_id: null, trigger_status: "ELIGIBLE" },
  );
  const separableCase = await orders.getBillingCase(gateCaseId);
  assert.equal(separableCase!.addableOrders.length, 1);
  assert.deepEqual(separableCase!.anomalies, []);
  await assert.rejects(
    orders.separateOrderFromBillingCase(
      gateCaseId,
      String(separableCase!.orders[0]!.id),
      await caseRevision(gateCaseId),
      { id: 1, requestId: "test-separate-last-order" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "BILLING_CASE_EMPTY",
  );
  assert.equal(
    await orders.addOrderToBillingCase(
      gateCaseId,
      String(separatedOrderId),
      await caseRevision(gateCaseId),
      { id: 1, requestId: "test-add-order" },
    ),
    gateCaseId,
  );
  const recomposed = await orders.getBillingCase(gateCaseId);
  assert.equal(recomposed!.orders.length, 2);
  assert.deepEqual(recomposed!.anomalies, ["PENDING_PAYMENT"]);
  assert.equal(recomposed!.status, "NEEDS_REVIEW");

  // 7.5: un'anagrafica incompleta si chiude con la correzione, non cambiando la sorgente.
  const incompleteForCorrection = structuredClone(fixture[0]);
  incompleteForCorrection.externalOrderId = "shop-order-correction";
  incompleteForCorrection.externalCustomerId = "shop-customer-correction";
  incompleteForCorrection.customer.taxIdentifiers = [];
  incompleteForCorrection.customer.billingAddress = {};
  incompleteForCorrection.createdAt = "2026-08-25T08:00:00Z";
  incompleteForCorrection.updatedAt = "2026-08-25T09:00:00Z";
  await orders.importOrders([incompleteForCorrection], {
    id: 1,
    requestId: "test-correction-import",
  });
  const correctionCaseId = String(
    (
      await database
        .getPool()
        .query("SELECT billing_case_id FROM orders WHERE external_order_id = $1", [
          incompleteForCorrection.externalOrderId,
        ])
    ).rows[0].billing_case_id,
  );
  const beforeCorrection = await orders.getBillingCase(correctionCaseId);
  assert.equal(beforeCorrection!.status, "NEEDS_REVIEW");
  assert.ok(beforeCorrection!.anomalies.includes("CUSTOMER_INCOMPLETE"));
  await database.getPool().query(
    `UPDATE orders
       SET trigger_status = 'NEEDS_REVIEW',
           normalized_snapshot_json = jsonb_set(
             normalized_snapshot_json, '{sourceConflictRequired}', 'true'::jsonb)
       WHERE billing_case_id = $1`,
    [correctionCaseId],
  );
  const correction = {
    kind: "BUSINESS_IT",
    displayName: "Rossi Srl",
    companyName: "Rossi Srl",
    email: "AMMINISTRAZIONE@EXAMPLE.INVALID",
    recipientCode: "abc1234",
    billingAddress: {
      line1: "VIA XX SETTEMBRE 1",
      postalCode: "20 100",
      city: "MILANO",
      province: "mi",
      countryCode: "IT",
    },
    taxIdentifiers: [
      { type: "CODICE_FISCALE", value: "RSSMRA80A01H501D", sourceField: "correzione-manuale" },
      { type: "PARTITA_IVA", value: "12345678901", sourceField: "correzione-manuale" },
    ],
  };
  await assert.rejects(
    orders.correctBillingCaseCustomer(correctionCaseId, correction, 0, null, {
      id: 1,
      requestId: "test-correction-stale",
    }),
    (error: unknown) => error instanceof AppError && error.code === "CONFLICT_REVISION",
  );
  await assert.rejects(
    orders.correctBillingCaseCustomer(
      correctionCaseId,
      { ...correction, email: "non-una-email" },
      await caseRevision(correctionCaseId),
      null,
      { id: 1, requestId: "test-correction-invalid" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_INVALID_INPUT",
  );
  assert.equal(
    await orders.correctBillingCaseCustomer(
      correctionCaseId,
      correction,
      await caseRevision(correctionCaseId),
      "Dati fiscali confermati dal cliente",
      { id: 1, requestId: "test-correction" },
    ),
    "NEEDS_REVIEW",
  );
  const afterCorrection = await orders.getBillingCase(correctionCaseId);
  assert.deepEqual(afterCorrection!.anomalies, ["SOURCE_CONFLICT"]);
  assert.equal(afterCorrection!.customer_name, "Rossi Srl");
  assert.equal(afterCorrection!.customer_snapshot_json.email, "amministrazione@example.invalid");
  assert.equal(afterCorrection!.customer_snapshot_json.recipientCode, "ABC1234");
  assert.deepEqual(afterCorrection!.customer_snapshot_json.billingAddress, {
    line1: "Via XX Settembre 1",
    postalCode: "20100",
    city: "Milano",
    province: "MI",
    countryCode: "IT",
  });
  assert.ok(afterCorrection!.customer_corrected_at);
  // Una correzione non fiscale non cancella gli identificativi che non stava modificando.
  assert.equal(afterCorrection!.customer_snapshot_json.taxIdentifiers?.length, 2);
  assert.equal(
    await orders.correctBillingCaseCustomer(
      correctionCaseId,
      { ...correction, phone: "+39 02 0000000" },
      await caseRevision(correctionCaseId),
      null,
      { id: 1, requestId: "test-correction-non-fiscal" },
    ),
    "NEEDS_REVIEW",
  );
  assert.equal(
    (await orders.getBillingCase(correctionCaseId))!.customer_snapshot_json.taxIdentifiers?.length,
    2,
  );
  const correctedActivity = (await orders.listOpenActivities()).rows.find(
    (activity) => activity.kind === "BILLING_CASE" && activity.id === correctionCaseId,
  );
  assert.equal(correctedActivity?.customer_tax_id, "RSSMRA80A01H501D");
  // L'ordine conserva il valore importato: la correzione non riscrive la storia.
  assert.equal(
    (
      await database.getPool().query(
        `SELECT normalized_snapshot_json #>> '{customerSnapshot,billingAddress,city}' AS city
           FROM orders WHERE external_order_id = $1`,
        [incompleteForCorrection.externalOrderId],
      )
    ).rows[0].city,
    null,
  );
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT before_json #>> '{billingAddress,city}' AS before_city,
                  after_json #>> '{billingAddress,city}' AS after_city, reason
             FROM audit_events
             WHERE action = 'CUSTOMER_CORRECTED' AND request_id = 'test-correction'`,
      )
    ).rows[0],
    {
      before_city: null,
      after_city: "Milano",
      reason: "Dati fiscali confermati dal cliente",
    },
  );
  await assert.rejects(
    orders.reviewBillingCaseSourceChanges(
      correctionCaseId,
      await caseRevision(correctionCaseId),
      false,
      { id: 1, requestId: "test-source-review-missing-confirmation" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_INVALID_INPUT",
  );
  await assert.rejects(
    orders.reviewBillingCaseSourceChanges(
      correctionCaseId,
      (await caseRevision(correctionCaseId)) - 1,
      true,
      { id: 1, requestId: "test-source-review-stale" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "CONFLICT_REVISION",
  );
  assert.equal(
    await orders.reviewBillingCaseSourceChanges(
      correctionCaseId,
      await caseRevision(correctionCaseId),
      true,
      { id: 1, requestId: "test-source-review" },
    ),
    "READY",
  );
  assert.deepEqual((await orders.getBillingCase(correctionCaseId))!.anomalies, []);
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT orders.trigger_status,
                  (orders.normalized_snapshot_json ->> 'deferredReviewRequired')::boolean
                    AS deferred_review_required,
                  audit_events.before_json ->> 'triggerStatus' AS before_trigger,
                  audit_events.after_json ->> 'triggerStatus' AS after_trigger
           FROM orders
           JOIN audit_events ON audit_events.entity_type = 'ORDER'
             AND audit_events.entity_id = orders.id::text
             AND audit_events.action = 'ORDER_SOURCE_REVIEWED'
           WHERE orders.external_order_id = $1`,
        [incompleteForCorrection.externalOrderId],
      )
    ).rows[0],
    {
      trigger_status: "GROUPED",
      deferred_review_required: false,
      before_trigger: "NEEDS_REVIEW",
      after_trigger: "GROUPED",
    },
  );
  assert.equal(
    (await orders.listOpenActivities()).rows.some(
      (activity) => activity.kind === "BILLING_CASE" && activity.id === correctionCaseId,
    ),
    false,
  );
  await assert.rejects(
    orders.reviewBillingCaseSourceChanges(
      correctionCaseId,
      await caseRevision(correctionCaseId),
      true,
      { id: 1, requestId: "test-source-review-repeat" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "CONFLICT_REVISION",
  );

  // 7.3: l'identità non certa non accorpa e la corrispondenza possibile resta visibile.
  const ambiguousA = structuredClone(fixture[0]);
  ambiguousA.externalOrderId = "shop-order-ambiguous-a";
  delete ambiguousA.externalCustomerId;
  ambiguousA.createdAt = "2026-08-26T08:00:00Z";
  ambiguousA.updatedAt = "2026-08-26T09:00:00Z";
  ambiguousA.customer = { kind: "UNKNOWN", billingAddress: {}, taxIdentifiers: [] };
  const ambiguousB = structuredClone(ambiguousA);
  ambiguousB.externalOrderId = "shop-order-ambiguous-b";
  ambiguousB.payments[0].externalPaymentId = "shop-payment-ambiguous-b";
  await orders.importOrders([ambiguousA, ambiguousB], {
    id: 1,
    requestId: "test-ambiguous-grouping",
  });
  assert.equal(
    (
      await database.getPool().query(
        `SELECT count(DISTINCT billing_case_id) FROM orders
           WHERE external_order_id IN ($1, $2)`,
        [ambiguousA.externalOrderId, ambiguousB.externalOrderId],
      )
    ).rows[0].count,
    "2",
  );
  const ambiguousOrderId = (
    await database
      .getPool()
      .query("SELECT id FROM orders WHERE external_order_id = $1", [ambiguousA.externalOrderId])
  ).rows[0].id;
  assert.deepEqual((await orders.getOrder(String(ambiguousOrderId)))!.possibleMatches, []);
  const namedAmbiguous = structuredClone(ambiguousA);
  namedAmbiguous.externalOrderId = "shop-order-ambiguous-named";
  namedAmbiguous.payments[0].externalPaymentId = "shop-payment-ambiguous-named";
  namedAmbiguous.customer.displayName = fixture[0].customer.displayName;
  await orders.importOrders([namedAmbiguous], {
    id: 1,
    requestId: "test-ambiguous-named-match",
  });
  const namedAmbiguousOrderId = (
    await database
      .getPool()
      .query("SELECT id FROM orders WHERE external_order_id = $1", [namedAmbiguous.externalOrderId])
  ).rows[0].id;
  assert.ok(
    (await orders.getOrder(String(namedAmbiguousOrderId)))!.possibleMatches.some(
      (candidate) => candidate.display_name === fixture[0].customer.displayName,
    ),
  );
  assert.deepEqual((await orders.getOrder("1"))!.possibleMatches, []);

  // La ricerca tratta `%` come testo, non come carattere jolly.
  assert.deepEqual((await orders.listOrders({ query: "%" })).rows, []);
  assert.equal((await orders.listOrders({ query: "shop-order-ambiguous-a" })).rows.length, 1);
  // Una pagina fuori dal dominio PostgreSQL vale come prima pagina, non come errore.
  assert.deepEqual(
    (await orders.listOrders({ page: "Infinity" })).rows,
    (await orders.listOrders({ page: 1 })).rows,
  );

  // Le liste sono paginate: la pagina piena dichiara la successiva e non la ripete.
  await database.getPool().query(
    `INSERT INTO audit_events
        (actor_type, action, event_class, entity_type, entity_id, request_id)
       SELECT 'ADMIN', 'ORDER_GROUPED', 'OPERATIONAL', 'ORDER', generate_series::text,
              'test-pagina-' || generate_series
       FROM generate_series(1, $1)`,
    [PAGE_SIZE + 10],
  );
  const firstPage = await orders.listAuditHistory({ query: "test-pagina-" });
  const secondPage = await orders.listAuditHistory({ query: "test-pagina-", page: 2 });
  assert.equal(firstPage.rows.length, PAGE_SIZE);
  assert.equal(firstPage.hasNext, true);
  assert.equal(secondPage.rows.length, 10);
  assert.equal(secondPage.hasNext, false);
  assert.equal(
    firstPage.rows.some((event) => secondPage.rows.some((other) => other.id === event.id)),
    false,
  );
  await database.getPool().query("DELETE FROM audit_events WHERE request_id LIKE 'test-pagina-%'");

  // Il registro attività espone ciò che richiede un intervento e la cronologia filtrabile.
  assert.ok(
    (await orders.listOpenActivities()).rows.some(
      (activity) => activity.href === `/ordini/preparazione/${gateCaseId}`,
    ),
  );
  const history = await orders.listAuditHistory({ action: "CUSTOMER_CORRECTED" });
  assert.equal(history.rows.length, 4);
  assert.ok(history.rows.some((event) => event.reason === "Dati fiscali confermati dal cliente"));
  assert.ok(
    history.rows.some(
      (event) => event.reason === "Rilettura dello stesso payload con il mapper Shopify corretto",
    ),
  );
  assert.ok(
    history.rows.some(
      (event) => event.reason === "Rilettura dello stesso payload con il mapper eBay corretto",
    ),
  );
  assert.match(history.rows[0]!.case_number ?? "", /^\d{6}$/);
  // Un'azione fuori allowlist non deve valere "tutte".
  assert.deepEqual((await orders.listAuditHistory({ action: "NON_ESISTE" })).rows, []);
  assert.deepEqual((await orders.listAuditHistory({ query: "test\0non valido" })).rows, []);

  const mixedRefund = structuredClone(fixture[0]);
  mixedRefund.externalOrderId = "shop-order-mixed-refund";
  mixedRefund.displayNumber = "#MIXED-REFUND";
  mixedRefund.createdAt = "2026-08-20T08:00:00Z";
  mixedRefund.updatedAt = "2026-08-20T09:00:00Z";
  mixedRefund.refunds = [
    {
      externalRefundId: "completed-refund",
      status: "COMPLETED",
      amount: "25.00",
      completedAt: "2026-08-20T08:30:00Z",
      raw: {},
    },
    {
      externalRefundId: "pending-refund",
      status: "PENDING",
      amount: "10.00",
      completedAt: null,
      raw: {},
    },
  ];
  await orders.importOrders([mixedRefund], { id: 1, requestId: "test-mixed-refund" });
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT orders.trigger_status, billing_cases.status,
                  (orders.normalized_snapshot_json ->> 'orderReviewRequired')::boolean
                    AS review_required
           FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
           WHERE orders.external_order_id = $1`,
        [mixedRefund.externalOrderId],
      )
    ).rows[0],
    { trigger_status: "GROUPED", status: "READY", review_required: false },
  );
  const totalRefund = structuredClone(fixture[0]);
  totalRefund.externalOrderId = "shop-order-total-refund";
  totalRefund.displayNumber = "#TOTAL-REFUND";
  totalRefund.createdAt = "2026-08-20T10:00:00Z";
  totalRefund.updatedAt = "2026-08-20T11:00:00Z";
  totalRefund.refunds = [
    {
      externalRefundId: "total-refund",
      status: "COMPLETED",
      amount: totalRefund.total,
      completedAt: "2026-08-21T08:30:00Z",
      raw: {},
    },
  ];
  await orders.importOrders([totalRefund], { id: 1, requestId: "test-total-refund" });
  const isolatedRefund = (
    await database.getPool().query(
      `SELECT orders.trigger_status, billing_cases.id AS case_id, billing_cases.status,
                billing_cases.do_not_transmit_reason,
                healthy.billing_case_id AS healthy_case_id, healthy_case.status AS healthy_status
         FROM orders
         JOIN billing_cases ON billing_cases.id = orders.billing_case_id
         JOIN orders AS healthy ON healthy.external_order_id = $2
         JOIN billing_cases AS healthy_case ON healthy_case.id = healthy.billing_case_id
         WHERE orders.external_order_id = $1`,
      [totalRefund.externalOrderId, mixedRefund.externalOrderId],
    )
  ).rows[0];
  assert.deepEqual(
    {
      trigger_status: isolatedRefund.trigger_status,
      status: isolatedRefund.status,
      do_not_transmit_reason: isolatedRefund.do_not_transmit_reason,
      healthy_status: isolatedRefund.healthy_status,
    },
    {
      trigger_status: "REFUNDED_BEFORE_ISSUE",
      status: "DO_NOT_TRANSMIT",
      do_not_transmit_reason: "Ordine rimborsato prima dell’emissione",
      healthy_status: "READY",
    },
  );
  assert.notEqual(isolatedRefund.case_id, isolatedRefund.healthy_case_id);
  const totalRefundCase = await orders.getBillingCase(isolatedRefund.case_id);
  assert.equal(totalRefundCase!.reactivation_blocker, "INCOMPATIBLE_ORDERS");

  await database.getPool().query(
    `UPDATE settings SET value_json = '"PAID"', version = version + 1
       WHERE key = 'draft_trigger'`,
  );
  const refundAnchor = structuredClone(fixture[0]);
  refundAnchor.externalOrderId = "shop-order-historical-refund-anchor";
  refundAnchor.displayNumber = "#HISTORICAL-REFUND-ANCHOR";
  refundAnchor.createdAt = "2026-09-01T08:00:00Z";
  refundAnchor.updatedAt = "2026-09-01T09:00:00Z";
  refundAnchor.payments[0].externalPaymentId = "historical-refund-anchor-payment";
  await orders.importOrders([refundAnchor], {
    id: 1,
    requestId: "test-historical-refund-anchor-import",
  });
  const refundAnchorRow = (
    await database
      .getPool()
      .query<{ id: string; billing_case_id: string }>(
        "SELECT id, billing_case_id FROM orders WHERE external_order_id = $1",
        [refundAnchor.externalOrderId],
      )
  ).rows[0]!;
  await database.getPool().query(
    `INSERT INTO fiscal_profiles (version, status, profile_json)
       VALUES (1, 'MOCK', $1) ON CONFLICT (version) DO NOTHING`,
    [JSON.parse(await readFile("tests/fixtures/fatturapa/profile.mock.json", "utf8"))],
  );
  const documents = await import("../documents.server.ts");

  const reviewedDraftOrder = structuredClone(fixture[0]);
  reviewedDraftOrder.externalOrderId = "shop-order-reviewed-draft";
  reviewedDraftOrder.displayNumber = "#REVIEWED-DRAFT";
  reviewedDraftOrder.externalCustomerId = "shop-customer-reviewed-draft";
  reviewedDraftOrder.customer.taxIdentifiers[0].value = "RSSMRA80A01H501E";
  reviewedDraftOrder.createdAt = "2026-09-03T08:00:00Z";
  reviewedDraftOrder.updatedAt = "2026-09-03T09:00:00Z";
  reviewedDraftOrder.payments[0].externalPaymentId = "reviewed-draft-payment";
  await orders.importOrders([reviewedDraftOrder], {
    id: 1,
    requestId: "test-reviewed-draft-import",
  });
  const reviewedDraftCaseId = String(
    (
      await database
        .getPool()
        .query("SELECT billing_case_id FROM orders WHERE external_order_id = $1", [
          reviewedDraftOrder.externalOrderId,
        ])
    ).rows[0].billing_case_id,
  );
  const reviewedDraftProjection = await documents.getInvoiceProjection(reviewedDraftCaseId);
  assert.ok(
    reviewedDraftProjection &&
      !reviewedDraftProjection.profileMissing &&
      "lines" in reviewedDraftProjection,
  );
  await documents.saveInvoiceDraft(
    reviewedDraftCaseId,
    {
      caseRevision: reviewedDraftProjection.caseRevision,
      draftVersion: reviewedDraftProjection.draftVersion,
      differenceReason: "Rettifica manuale prima dell’aggiornamento ordine",
      paymentStatus: reviewedDraftProjection.paymentStatus,
      paymentMethod: reviewedDraftProjection.paymentMethod,
      causale: reviewedDraftProjection.causale,
      notes: reviewedDraftProjection.notes,
      lines: reviewedDraftProjection.lines.map((line) => ({
        ...line,
        unitAmount: line.unitAmount - 200,
      })),
    },
    { id: 1, canApprove: true, requestId: "test-reviewed-draft-save" },
  );
  reviewedDraftOrder.total = "130.00";
  reviewedDraftOrder.lines[0].grossAmount = "130.00";
  reviewedDraftOrder.payments[0].amount = "130.00";
  reviewedDraftOrder.updatedAt = "2026-09-03T10:00:00Z";
  await orders.importOrders([reviewedDraftOrder], {
    id: 1,
    requestId: "test-reviewed-draft-source-update",
  });
  assert.equal(
    await orders.reviewBillingCaseSourceChanges(
      reviewedDraftCaseId,
      await caseRevision(reviewedDraftCaseId),
      true,
      { id: 1, requestId: "test-reviewed-draft-source-review" },
    ),
    "READY",
  );
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT documents.source_total_amount, documents.total_amount,
                  documents.difference_amount, documents.difference_reason,
                  documents.draft_version, documents.projection_sha256,
                  document_orders.amount AS source_order_amount,
                  document_lines.unit_amount AS manual_line_amount,
                  audit_events.before_json #>> '{invoiceDraft,sourceTotal}' AS before_source_total,
                  audit_events.after_json #>> '{invoiceDraft,sourceTotal}' AS after_source_total,
                  audit_events.after_json #>> '{invoiceDraft,difference}' AS after_difference
           FROM documents
           JOIN document_orders ON document_orders.document_id = documents.id
           JOIN document_lines ON document_lines.document_id = documents.id
           JOIN audit_events ON audit_events.request_id = 'test-reviewed-draft-source-review'
           WHERE documents.billing_case_id = $1`,
        [reviewedDraftCaseId],
      )
    ).rows[0],
    {
      source_total_amount: 13_000,
      total_amount: 12_000,
      difference_amount: -1_000,
      difference_reason: "Rettifica manuale prima dell’aggiornamento ordine",
      draft_version: 2,
      projection_sha256: "0".repeat(64),
      source_order_amount: 13_000,
      manual_line_amount: 12_000,
      before_source_total: "12200",
      after_source_total: "13000",
      after_difference: "-1000",
    },
  );
  const reconciledProjection = await documents.getInvoiceProjection(reviewedDraftCaseId);
  assert.ok(reconciledProjection && !reconciledProjection.profileMissing);
  assert.equal(reconciledProjection.requiresResave, true);

  const refundDocumentId = (
    await database.getPool().query<{ id: string }>(
      `INSERT INTO documents
           (billing_case_id, kind, status, document_type, series, document_date,
            fiscal_profile_version, currency, total_amount, source_total_amount,
            difference_amount, projection_sha256, payment_status, payment_method,
            recipient_snapshot_json)
         VALUES ($1, 'INVOICE', 'DRAFT', 'TD01', 'FPR', '2026-09-01', 1, 'EUR',
                 12200, 12200, 0, $2, 'PAID', 'MP08', $3)
         RETURNING id`,
      [
        refundAnchorRow.billing_case_id,
        "0".repeat(64),
        {
          kind: refundAnchor.customer.kind,
          displayName: refundAnchor.customer.displayName,
          firstName: refundAnchor.customer.firstName,
          lastName: refundAnchor.customer.lastName,
          taxIdentifiers: refundAnchor.customer.taxIdentifiers.map(
            (identifier: { type: string; value: string; countryCode?: string }) => ({
              type: identifier.type,
              value: identifier.value,
              countryCode: identifier.countryCode,
            }),
          ),
          address: refundAnchor.customer.billingAddress,
        },
      ],
    )
  ).rows[0]!.id;
  await database.getPool().query(
    `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
       VALUES ($1, 'INVOICE', $2, 12200)`,
    [refundDocumentId, refundAnchorRow.id],
  );
  await database.getPool().query(
    `INSERT INTO document_lines
         (document_id, order_id, line_number, description, quantity, unit_amount,
          total_amount, tax_nature)
       VALUES ($1, $2, 1, 'Ordine di controllo', 1, 12200, 12200, 'N5')`,
    [refundDocumentId, refundAnchorRow.id],
  );
  const deferredHistorical = structuredClone(fixture[0]);
  deferredHistorical.externalOrderId = "shop-order-historical-refund-deferred-force";
  deferredHistorical.displayNumber = "#HISTORICAL-REFUND-DEFERRED-FORCE";
  deferredHistorical.createdAt = "2026-09-01T08:00:00Z";
  deferredHistorical.updatedAt = "2026-09-01T09:00:00Z";
  deferredHistorical.historical = true;
  deferredHistorical.paymentStatus = "PENDING";
  deferredHistorical.fulfillmentStatus = "FULFILLED";
  deferredHistorical.payments[0].externalPaymentId = "historical-refund-deferred-force-payment";
  deferredHistorical.payments[0].status = "PENDING";
  deferredHistorical.payments[0].paidAt = null;
  deferredHistorical.refunds = [
    {
      externalRefundId: "historical-refund-deferred-force",
      status: "COMPLETED",
      amount: "10.00",
      completedAt: "2026-09-01T09:00:00Z",
      raw: {},
    },
  ];
  const triggeredHistorical = structuredClone(deferredHistorical);
  triggeredHistorical.externalOrderId = "shop-order-historical-refund-deferred-trigger";
  triggeredHistorical.displayNumber = "#HISTORICAL-REFUND-DEFERRED-TRIGGER";
  triggeredHistorical.payments[0].externalPaymentId = "historical-refund-deferred-trigger-payment";
  triggeredHistorical.refunds[0].externalRefundId = "historical-refund-deferred-trigger";
  await orders.importOrders([deferredHistorical, triggeredHistorical], {
    id: 1,
    requestId: "test-historical-refund-deferred-import",
  });
  const deferredIds = (
    await database.getPool().query<{ id: string; external_order_id: string }>(
      `SELECT id, external_order_id FROM orders
         WHERE external_order_id IN ($1, $2)`,
      [deferredHistorical.externalOrderId, triggeredHistorical.externalOrderId],
    )
  ).rows;
  for (const order of deferredIds) {
    await orders.reconcileHistoricalOrder(
      order.id,
      {
        outcome: "NOT_INVOICED",
        reference: `Ricerca Aruba senza documento per ${order.external_order_id}`,
      },
      { id: 1, canApprove: true, requestId: `test-${order.external_order_id}-reconcile` },
    );
  }
  const forcedId = deferredIds.find(
    (order) => order.external_order_id === deferredHistorical.externalOrderId,
  )!.id;
  await orders.forcePrepareOrder(forcedId, {
    id: 1,
    requestId: "test-historical-refund-deferred-force",
  });
  const finalTriggerVersion = (
    await database.getPool().query("SELECT version FROM settings WHERE key = 'draft_trigger'")
  ).rows[0].version;
  await orders.setDraftTrigger("FULFILLED", finalTriggerVersion, {
    id: 1,
    requestId: "test-historical-refund-deferred-trigger",
  });
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT orders.external_order_id, orders.trigger_status, document_orders.amount
           FROM orders JOIN document_orders ON document_orders.order_id = orders.id
           WHERE orders.external_order_id IN ($1, $2)
           ORDER BY orders.external_order_id`,
        [deferredHistorical.externalOrderId, triggeredHistorical.externalOrderId],
      )
    ).rows,
    [
      {
        external_order_id: deferredHistorical.externalOrderId,
        trigger_status: "GROUPED",
        amount: 11_200,
      },
      {
        external_order_id: triggeredHistorical.externalOrderId,
        trigger_status: "GROUPED",
        amount: 11_200,
      },
    ],
  );

  const firstDraftHistorical = structuredClone(fixture[0]);
  firstDraftHistorical.externalOrderId = "shop-order-historical-refund-first-draft";
  firstDraftHistorical.displayNumber = "#HISTORICAL-REFUND-FIRST-DRAFT";
  firstDraftHistorical.createdAt = "2026-09-02T08:00:00Z";
  firstDraftHistorical.updatedAt = "2026-09-02T09:00:00Z";
  firstDraftHistorical.historical = true;
  firstDraftHistorical.payments[0].externalPaymentId = "historical-refund-first-draft-payment";
  firstDraftHistorical.refunds = [
    {
      externalRefundId: "historical-refund-first-draft",
      status: "COMPLETED",
      amount: "10.00",
      completedAt: "2026-09-02T09:00:00Z",
      raw: {},
    },
  ];
  await orders.importOrders([firstDraftHistorical], {
    id: 1,
    requestId: "test-historical-refund-first-draft-import",
  });
  const firstDraftHistoricalId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        firstDraftHistorical.externalOrderId,
      ])
  ).rows[0]!.id;
  const firstDraftReconciliation = await orders.reconcileHistoricalOrder(
    firstDraftHistoricalId,
    {
      outcome: "NOT_INVOICED",
      reference: "Ricerca Aruba senza documento per prima bozza netta",
    },
    {
      id: 1,
      canApprove: true,
      requestId: "test-historical-refund-first-draft-reconcile",
    },
  );
  const firstProjection = await documents.getInvoiceProjection(firstDraftReconciliation!.caseId!);
  assert.ok(firstProjection && !firstProjection.profileMissing && "lines" in firstProjection);
  assert.equal(firstProjection.sourceTotal, 11_200);
  assert.equal(firstProjection.lines[0]!.unitAmount, 11_200);
  await documents.saveInvoiceDraft(
    firstDraftReconciliation!.caseId!,
    {
      caseRevision: firstProjection.caseRevision,
      draftVersion: firstProjection.draftVersion,
      differenceReason: "",
      paymentStatus: firstProjection.paymentStatus,
      paymentMethod: firstProjection.paymentMethod,
      causale: firstProjection.causale,
      notes: firstProjection.notes,
      lines: firstProjection.lines,
    },
    { id: 1, canApprove: true, requestId: "test-historical-refund-first-draft-save" },
  );
  assert.equal(
    (
      await database.getPool().query(
        `SELECT document_orders.amount FROM document_orders
           WHERE document_orders.order_id = $1`,
        [firstDraftHistoricalId],
      )
    ).rows[0].amount,
    11_200,
  );
}
