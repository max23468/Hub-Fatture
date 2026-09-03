import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { AppError } from "../../errors.ts";
import type { OrdersTestContext } from "./orders-test-support.test.ts";

export async function runPaymentsCoreScenario(context: OrdersTestContext) {
  const { orders, database, caseRevision, fixture } = context;
  const pendingPaymentsBefore = Number((await orders.dashboardSummary()).pending_payments);
  const pendingPayment = structuredClone(fixture[0]);
  pendingPayment.externalOrderId = "shop-order-pending-payment";
  pendingPayment.externalCustomerId = "shop-customer-pending-payment";
  pendingPayment.customer.taxIdentifiers[0].value = "RSSMRA80A01H501W";
  // Anche lo stato aggregato può essere in ritardo: l'incasso completo è autorevole.
  pendingPayment.paymentStatus = "PENDING";
  pendingPayment.payments[0].status = "PENDING";
  pendingPayment.payments[0].paidAt = null;
  pendingPayment.payments.push({
    ...pendingPayment.payments[0],
    externalPaymentId: "shop-payment-settled-after-pending",
    status: "PAID",
    paidAt: "2026-08-11T08:45:00Z",
  });
  pendingPayment.createdAt = "2026-08-11T08:15:00Z";
  pendingPayment.updatedAt = "2026-08-11T09:00:00Z";
  await orders.importOrders([pendingPayment], {
    id: 1,
    requestId: "test-pending-payment",
  });
  const settledPaymentCase = (
    await database.getPool().query(
      `SELECT billing_cases.id::text AS case_id, billing_cases.status
               FROM billing_cases JOIN orders ON orders.billing_case_id = billing_cases.id
               WHERE orders.external_order_id = 'shop-order-pending-payment'`,
    )
  ).rows[0];
  assert.equal(settledPaymentCase.status, "READY");
  const invoiceDocuments = await import("../documents.server.ts");
  assert.equal(Number((await orders.dashboardSummary()).pending_payments), pendingPaymentsBefore);
  assert.ok(
    !(await orders.listOrders({ status: "ACTIVE", paymentStatus: "PENDING" })).rows.some(
      (order) => order.display_number === pendingPayment.displayNumber,
    ),
  );
  const incompleteCustomer = structuredClone(fixture[0]);
  incompleteCustomer.externalOrderId = "shop-order-incomplete-customer";
  incompleteCustomer.externalCustomerId = "shop-customer-incomplete";
  incompleteCustomer.customer.taxIdentifiers[0].value = "RSSMRA80A01H501V";
  incompleteCustomer.customer.billingAddress = {};
  incompleteCustomer.updatedAt = "2026-08-08T12:00:00Z";
  assert.deepEqual(
    await orders.importOrders([incompleteCustomer], {
      id: 1,
      requestId: "test-incomplete-customer",
    }),
    { imported: 1, updated: 0, ignored: 0 },
  );
  assert.equal(
    (
      await database.getPool().query(
        `SELECT billing_cases.status
               FROM billing_cases JOIN orders ON orders.billing_case_id = billing_cases.id
               WHERE orders.external_order_id = 'shop-order-incomplete-customer'`,
      )
    ).rows[0].status,
    "NEEDS_REVIEW",
  );
  const completedCustomer = structuredClone(incompleteCustomer);
  completedCustomer.externalOrderId = "shop-order-completed-customer";
  completedCustomer.createdAt = "2026-08-09T08:15:00Z";
  completedCustomer.updatedAt = "2026-08-09T09:00:00Z";
  completedCustomer.customer.billingAddress = fixture[0].customer.billingAddress;
  await orders.importOrders([completedCustomer], {
    id: 1,
    requestId: "test-completed-customer",
  });
  const completedCase = (
    await database.getPool().query(
      `SELECT billing_cases.status, customers.review_required,
                  customers.billing_address_json ->> 'city' AS city
             FROM billing_cases
             JOIN customers ON customers.id = billing_cases.customer_id
             JOIN orders ON orders.billing_case_id = billing_cases.id
             WHERE orders.external_order_id = 'shop-order-completed-customer'`,
    )
  ).rows[0];
  assert.deepEqual(completedCase, {
    status: "READY",
    review_required: false,
    city: "Milano",
  });
  const laterIncompleteCustomer = structuredClone(incompleteCustomer);
  laterIncompleteCustomer.externalOrderId = "shop-order-later-incomplete-customer";
  laterIncompleteCustomer.createdAt = "2026-08-10T08:15:00Z";
  laterIncompleteCustomer.updatedAt = "2026-08-10T09:00:00Z";
  await orders.importOrders([laterIncompleteCustomer], {
    id: 1,
    requestId: "test-later-incomplete-customer",
  });
  const preservedCase = (
    await database.getPool().query(
      `SELECT billing_cases.status,
                  billing_cases.customer_snapshot_json ->> 'reviewRequired' AS review_required,
                  billing_cases.customer_snapshot_json #>> '{billingAddress,city}' AS city
             FROM billing_cases
             JOIN orders ON orders.billing_case_id = billing_cases.id
             WHERE orders.external_order_id = 'shop-order-completed-customer'`,
    )
  ).rows[0];
  assert.deepEqual(preservedCase, {
    status: "READY",
    review_required: "false",
    city: "Milano",
  });

  const { externalCustomerId: _, ...noExternalCustomer } = structuredClone(fixture[0]);
  noExternalCustomer.externalOrderId = "shop-order-without-external-customer";
  noExternalCustomer.createdAt = "2026-08-13T08:00:00Z";
  noExternalCustomer.updatedAt = "2026-08-13T09:00:00Z";
  noExternalCustomer.customer = {
    kind: "UNKNOWN",
    billingAddress: {},
    taxIdentifiers: [],
  };
  await orders.importOrders([noExternalCustomer], {
    id: 1,
    requestId: "test-without-external-customer",
  });
  assert.equal(
    (
      await database.getPool().query(
        `SELECT billing_cases.status
               FROM billing_cases JOIN orders ON orders.billing_case_id = billing_cases.id
               WHERE orders.external_order_id = $1`,
        [noExternalCustomer.externalOrderId],
      )
    ).rows[0].status,
    "NEEDS_REVIEW",
  );

  const unreconciled = structuredClone(fixture[0]);
  unreconciled.externalOrderId = "shop-order-unreconciled";
  unreconciled.externalCustomerId = "shop-customer-unreconciled";
  unreconciled.customer.taxIdentifiers[0].value = "RSSMRA80A01H501X";
  unreconciled.createdAt = "2026-08-14T08:00:00Z";
  unreconciled.updatedAt = "2026-08-14T09:00:00Z";
  unreconciled.total = "123.00";
  await orders.importOrders([unreconciled], { id: 1, requestId: "test-unreconciled" });
  const unreconciledCase = (
    await database.getPool().query(
      `SELECT billing_cases.status,
                  orders.normalized_snapshot_json ->> 'totalsReconciled' AS totals_reconciled
             FROM billing_cases JOIN orders ON orders.billing_case_id = billing_cases.id
             WHERE orders.external_order_id = $1`,
      [unreconciled.externalOrderId],
    )
  ).rows[0];
  assert.deepEqual(unreconciledCase, {
    status: "NEEDS_REVIEW",
    totals_reconciled: "false",
  });

  const roundedBankTransfer = structuredClone(fixture[0]);
  roundedBankTransfer.externalOrderId = "shop-order-rounded-bank-transfer";
  roundedBankTransfer.externalCustomerId = "shop-customer-rounded-bank-transfer";
  roundedBankTransfer.customer.taxIdentifiers[0].value = "RSSMRA80A01H501R";
  roundedBankTransfer.createdAt = "2026-08-15T08:00:00Z";
  roundedBankTransfer.updatedAt = "2026-08-15T09:00:00Z";
  roundedBankTransfer.payments[0].method = "Bonifico Bancario";
  roundedBankTransfer.payments[0].amount = "122.02";
  await orders.importOrders([roundedBankTransfer], {
    id: 1,
    requestId: "test-rounded-bank-transfer",
  });
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT billing_cases.status,
                orders.normalized_snapshot_json ->> 'totalsReconciled' AS totals_reconciled
         FROM billing_cases JOIN orders ON orders.billing_case_id = billing_cases.id
         WHERE orders.external_order_id = $1`,
        [roundedBankTransfer.externalOrderId],
      )
    ).rows[0],
    { status: "READY", totals_reconciled: "true" },
  );

  for (const [suffix, amount] of [
    ["excessive", "122.03"],
    ["underpaid", "121.98"],
  ] as const) {
    const invalidRounding = structuredClone(roundedBankTransfer);
    invalidRounding.externalOrderId = `shop-order-bank-transfer-${suffix}`;
    invalidRounding.externalCustomerId = `shop-customer-bank-transfer-${suffix}`;
    invalidRounding.customer.taxIdentifiers[0].value =
      suffix === "excessive" ? "RSSMRA80A01H502S" : "RSSMRA80A01H503T";
    invalidRounding.createdAt =
      suffix === "excessive" ? "2026-08-16T08:00:00Z" : "2026-08-17T08:00:00Z";
    invalidRounding.updatedAt =
      suffix === "excessive" ? "2026-08-16T09:00:00Z" : "2026-08-17T09:00:00Z";
    invalidRounding.payments[0].amount = amount;
    await orders.importOrders([invalidRounding], {
      id: 1,
      requestId: `test-bank-transfer-${suffix}`,
    });
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT billing_cases.status,
                  orders.normalized_snapshot_json ->> 'totalsReconciled' AS totals_reconciled
           FROM billing_cases JOIN orders ON orders.billing_case_id = billing_cases.id
           WHERE orders.external_order_id = $1`,
          [invalidRounding.externalOrderId],
        )
      ).rows[0],
      { status: "NEEDS_REVIEW", totals_reconciled: "false" },
    );
  }

  const ebayNetPayment = structuredClone(fixture[0]);
  ebayNetPayment.provider = "EBAY";
  ebayNetPayment.externalAccountId = "connected-ebay";
  ebayNetPayment.externalOrderId = "ebay-order-net-seller-payment";
  ebayNetPayment.externalCustomerId = "ebay-customer-net-seller-payment";
  ebayNetPayment.displayNumber = "62341";
  ebayNetPayment.createdAt = "2026-08-14T10:00:00Z";
  ebayNetPayment.updatedAt = "2026-08-14T11:00:00Z";
  ebayNetPayment.customer.taxIdentifiers[0].value = "LCCMSM65L18A937C";
  ebayNetPayment.payments[0].externalPaymentId = "ebay-net-payment";
  ebayNetPayment.payments[0].method = "EBAY";
  ebayNetPayment.payments[0].amount = "106.73";
  await orders.importOrders([ebayNetPayment], {
    id: 1,
    requestId: "test-ebay-net-seller-payment",
  });
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT billing_cases.status,
                  orders.normalized_snapshot_json ->> 'totalsReconciled' AS totals_reconciled
             FROM billing_cases JOIN orders ON orders.billing_case_id = billing_cases.id
             WHERE orders.external_order_id = $1`,
        [ebayNetPayment.externalOrderId],
      )
    ).rows[0],
    { status: "READY", totals_reconciled: "true" },
  );
  await database.getPool().query(
    `WITH changed AS (
         UPDATE orders
         SET normalized_snapshot_json = jsonb_set(
               jsonb_set(normalized_snapshot_json, '{totalsReconciled}', 'false'::jsonb),
               '{orderReviewRequired}', 'true'::jsonb)
         WHERE external_order_id = $1
         RETURNING billing_case_id
       )
       UPDATE billing_cases SET status = 'NEEDS_REVIEW'
       WHERE id = (SELECT billing_case_id FROM changed)`,
    [ebayNetPayment.externalOrderId],
  );
  await orders.importOrders([ebayNetPayment], {
    id: 1,
    requestId: "test-ebay-net-seller-payment-replay",
  });
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT billing_cases.status,
                  orders.normalized_snapshot_json ->> 'totalsReconciled' AS totals_reconciled
             FROM billing_cases JOIN orders ON orders.billing_case_id = billing_cases.id
             WHERE orders.external_order_id = $1`,
        [ebayNetPayment.externalOrderId],
      )
    ).rows[0],
    { status: "READY", totals_reconciled: "true" },
  );

  const lowerCountry = {
    ...structuredClone(fixture[0]),
    externalOrderId: "shop-order-country-lower",
    externalCustomerId: "shop-customer-country-lower",
    createdAt: "2026-08-15T08:00:00Z",
    updatedAt: "2026-08-15T09:00:00Z",
    customer: {
      ...structuredClone(fixture[0].customer),
      kind: "EU" as const,
      billingAddress: {
        ...structuredClone(fixture[0].customer.billingAddress),
        countryCode: "DE",
      },
      taxIdentifiers: [
        {
          ...structuredClone(fixture[0].customer.taxIdentifiers[0]),
          type: "ALTRO" as const,
          value: "DE123456789",
          countryCode: "de",
        },
      ],
    },
  };
  const upperCountry = structuredClone(lowerCountry);
  upperCountry.externalOrderId = "shop-order-country-upper";
  upperCountry.externalCustomerId = "shop-customer-country-upper";
  upperCountry.customer.taxIdentifiers[0].countryCode = "DE";
  await orders.importOrders([lowerCountry, upperCountry], {
    id: 1,
    requestId: "test-country-grouping",
  });
  assert.equal(
    (
      await database.getPool().query(
        `SELECT count(DISTINCT billing_case_id) FROM orders
             WHERE external_order_id IN ($1, $2)`,
        [lowerCountry.externalOrderId, upperCountry.externalOrderId],
      )
    ).rows[0].count,
    "1",
  );
  lowerCountry.customer.taxIdentifiers[0].countryCode = "DE";
  lowerCountry.updatedAt = "2026-08-15T10:00:00Z";
  await orders.importOrders([lowerCountry], { id: 1, requestId: "test-country-reimport" });
  assert.equal(
    (
      await database.getPool().query(
        `SELECT count(*) FROM order_source_revisions
             JOIN orders ON orders.id = order_source_revisions.order_id
             WHERE orders.external_order_id = $1`,
        [lowerCountry.externalOrderId],
      )
    ).rows[0].count,
    "0",
  );

  const shipped = structuredClone(fixture[0]);
  shipped.externalOrderId = "shop-order-with-shipping";
  shipped.externalCustomerId = "shop-customer-with-shipping";
  shipped.customer.taxIdentifiers[0].value = "RSSMRA80A01H501Y";
  shipped.createdAt = "2026-08-16T08:00:00Z";
  shipped.updatedAt = "2026-08-16T09:00:00Z";
  shipped.total = "127.00";
  shipped.shippingAmount = "5.00";
  shipped.payments[0].amount = "127.00";
  await orders.importOrders([shipped], { id: 1, requestId: "test-shipping" });
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT billing_cases.status,
                    orders.normalized_snapshot_json ->> 'shippingAmount' AS shipping_amount,
                    orders.normalized_snapshot_json ->> 'totalsReconciled' AS totals_reconciled
               FROM billing_cases JOIN orders ON orders.billing_case_id = billing_cases.id
               WHERE orders.external_order_id = $1`,
        [shipped.externalOrderId],
      )
    ).rows[0],
    { status: "READY", shipping_amount: "500", totals_reconciled: "true" },
  );
  const manuallyClosedCaseId = (
    await database
      .getPool()
      .query("SELECT billing_case_id FROM orders WHERE external_order_id = $1", [
        shipped.externalOrderId,
      ])
  ).rows[0].billing_case_id;
  assert.equal(
    await orders.updateBillingCaseTransmission(
      manuallyClosedCaseId,
      "Già fatturato altrove",
      await caseRevision(manuallyClosedCaseId),
      {
        id: 1,
        requestId: "test-manual-do-not-transmit",
      },
    ),
    "DO_NOT_TRANSMIT",
  );
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT status, do_not_transmit_reason
             FROM billing_cases WHERE id = $1`,
        [manuallyClosedCaseId],
      )
    ).rows[0],
    { status: "DO_NOT_TRANSMIT", do_not_transmit_reason: "Già fatturato altrove" },
  );
  shipped.lines[0].description = "Descrizione aggiornata mentre la preparazione è chiusa";
  shipped.updatedAt = "2026-08-16T10:00:00Z";
  await orders.importOrders([shipped], {
    id: 1,
    requestId: "test-manual-do-not-transmit-source-update",
  });
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT billing_cases.id, billing_cases.status, billing_cases.do_not_transmit_reason
             FROM billing_cases JOIN orders ON orders.billing_case_id = billing_cases.id
             WHERE orders.external_order_id = $1`,
        [shipped.externalOrderId],
      )
    ).rows[0],
    {
      id: manuallyClosedCaseId,
      status: "DO_NOT_TRANSMIT",
      do_not_transmit_reason: "Già fatturato altrove",
    },
  );
  assert.equal(
    await orders.updateBillingCaseTransmission(
      manuallyClosedCaseId,
      null,
      await caseRevision(manuallyClosedCaseId),
      {
        id: 1,
        requestId: "test-manual-reactivation",
      },
    ),
    "NEEDS_REVIEW",
  );
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT status, do_not_transmit_reason,
                    (SELECT count(*)::int FROM audit_events
                     WHERE entity_type = 'BILLING_CASE'
                       AND entity_id = billing_cases.id::text
                       AND action IN ('BILLING_CASE_DO_NOT_TRANSMIT', 'BILLING_CASE_REACTIVATED'))
                      AS audit_count
             FROM billing_cases WHERE id = $1`,
        [manuallyClosedCaseId],
      )
    ).rows[0],
    { status: "NEEDS_REVIEW", do_not_transmit_reason: null, audit_count: 2 },
  );

  const reorderedCollections = structuredClone(fixture[0]);
  reorderedCollections.externalOrderId = "shop-order-reordered-collections";
  reorderedCollections.externalCustomerId = "shop-customer-reordered-collections";
  reorderedCollections.customer.taxIdentifiers[0].value = "RSSMRA80A01H501W";
  reorderedCollections.customer.taxIdentifiers.push({
    ...reorderedCollections.customer.taxIdentifiers[0],
    sourceField: "duplicate-source-field",
  });
  reorderedCollections.customer.taxIdentifiers.push(
    { type: "ALTRO", value: "DUPLICATO42", countryCode: "DE", sourceField: "field-de" },
    { type: "ALTRO", value: "DUPLICATO42", countryCode: "FR", sourceField: "field-fr" },
  );
  reorderedCollections.createdAt = "2026-08-17T08:00:00Z";
  reorderedCollections.updatedAt = "2026-08-17T09:00:00Z";
  reorderedCollections.lines = [
    { ...reorderedCollections.lines[0], externalLineId: "line-a", grossAmount: "60.00" },
    { ...reorderedCollections.lines[0], externalLineId: "line-b", grossAmount: "62.00" },
  ];
  reorderedCollections.payments = [
    { ...reorderedCollections.payments[0], externalPaymentId: "payment-a", amount: "60.00" },
    { ...reorderedCollections.payments[0], externalPaymentId: "payment-b", amount: "62.00" },
  ];
  await orders.importOrders([reorderedCollections], {
    id: 1,
    requestId: "test-collection-order-import",
  });
  reorderedCollections.lines.reverse();
  reorderedCollections.payments.reverse();
  reorderedCollections.payments.forEach(
    (payment: { paidAt: string | null }) => (payment.paidAt = "2026-08-07T11:00:00+02:00"),
  );
  reorderedCollections.updatedAt = "2026-08-17T10:00:00Z";
  await orders.importOrders([reorderedCollections], {
    id: 1,
    requestId: "test-collection-order-reimport",
  });
  assert.equal(
    (
      await database.getPool().query(
        `SELECT count(*) FROM order_source_revisions
             JOIN orders ON orders.id = order_source_revisions.order_id
             WHERE orders.external_order_id = $1`,
        [reorderedCollections.externalOrderId],
      )
    ).rows[0].count,
    "0",
  );
  assert.equal(
    (
      await database.getPool().query(
        `SELECT count(*) FROM order_tax_identifiers
             JOIN orders ON orders.id = order_tax_identifiers.order_id
             WHERE orders.external_order_id = $1`,
        [reorderedCollections.externalOrderId],
      )
    ).rows[0].count,
    "3",
  );
  reorderedCollections.cancelledAt = "2026-08-17T12:00:00Z";
  reorderedCollections.updatedAt = "2026-08-17T11:00:00Z";
  await orders.importOrders([reorderedCollections], {
    id: 1,
    requestId: "test-canonical-cancelled-at",
  });
  reorderedCollections.cancelledAt = "2026-08-17T14:00:00+02:00";
  reorderedCollections.updatedAt = "2026-08-17T12:00:00Z";
  await orders.importOrders([reorderedCollections], {
    id: 1,
    requestId: "test-canonical-cancelled-at-reimport",
  });
  assert.equal(
    (
      await database.getPool().query(
        `SELECT count(*) FROM order_source_revisions
             JOIN orders ON orders.id = order_source_revisions.order_id
             WHERE orders.external_order_id = $1`,
        [reorderedCollections.externalOrderId],
      )
    ).rows[0].count,
    "1",
  );

  const canonicalA = structuredClone(fixture[0]);
  canonicalA.externalOrderId = "shop-order-tax-order-a";
  canonicalA.externalCustomerId = "shop-customer-tax-order-a";
  canonicalA.createdAt = "2026-08-18T08:00:00Z";
  canonicalA.updatedAt = "2026-08-18T09:00:00Z";
  canonicalA.customer.kind = "EU";
  canonicalA.customer.billingAddress.countryCode = "DE";
  canonicalA.customer.taxIdentifiers = [
    {
      type: "PARTITA_IVA",
      value: "DE123456789",
      countryCode: "DE",
      sourceField: "fixture-vat",
    },
    {
      type: "ALTRO",
      value: "DE-ALT-42",
      countryCode: "DE",
      sourceField: "fixture-other",
    },
  ];
  delete canonicalA.customer.billingAddress.province;
  const canonicalB = structuredClone(canonicalA);
  canonicalB.externalOrderId = "shop-order-tax-order-b";
  canonicalB.externalCustomerId = "shop-customer-tax-order-b";
  canonicalB.customer.taxIdentifiers.reverse();
  canonicalB.customer.taxIdentifiers.find(
    (identifier: { type: string }) => identifier.type === "PARTITA_IVA",
  )!.value = "123456789";
  canonicalB.customer.phone = "";
  canonicalB.customer.billingAddress.province = "";
  await orders.importOrders([canonicalA, canonicalB], {
    id: 1,
    requestId: "test-tax-order-grouping",
  });
  const canonicalAOrderId = (
    await database
      .getPool()
      .query("SELECT id FROM orders WHERE external_order_id = $1", [canonicalA.externalOrderId])
  ).rows[0].id;
  assert.ok(
    (await orders.listOrders({ query: "DE123456789" })).rows.some(
      (order: { id: string }) => order.id === canonicalAOrderId,
    ),
  );
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT count(DISTINCT billing_case_id)::int AS case_count,
                    min(billing_cases.status) AS status
               FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
               WHERE external_order_id IN ($1, $2)`,
        [canonicalA.externalOrderId, canonicalB.externalOrderId],
      )
    ).rows[0],
    { case_count: 1, status: "READY" },
  );
  canonicalA.customer.taxIdentifiers.reverse();
  canonicalA.customer.phone = "";
  canonicalA.customer.billingAddress.province = "";
  canonicalA.updatedAt = "2026-08-18T10:00:00Z";
  await orders.importOrders([canonicalA], {
    id: 1,
    requestId: "test-tax-order-reimport",
  });
  assert.equal(
    (
      await database.getPool().query(
        `SELECT count(*) FROM order_source_revisions
             JOIN orders ON orders.id = order_source_revisions.order_id
             WHERE orders.external_order_id = $1`,
        [canonicalA.externalOrderId],
      )
    ).rows[0].count,
    "0",
  );
  canonicalA.displayNumber = "#1001-corretto";
  canonicalA.updatedAt = "2026-08-18T11:00:00Z";
  await orders.importOrders([canonicalA], {
    id: 1,
    requestId: "test-display-number-conflict",
  });
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT count(order_source_revisions.*)::int AS revision_count,
                    billing_cases.status
               FROM orders
               JOIN billing_cases ON billing_cases.id = orders.billing_case_id
               LEFT JOIN order_source_revisions ON order_source_revisions.order_id = orders.id
               WHERE orders.external_order_id = $1
               GROUP BY billing_cases.status`,
        [canonicalA.externalOrderId],
      )
    ).rows[0],
    { revision_count: 1, status: "NEEDS_REVIEW" },
  );
  canonicalA.updatedAt = "2026-08-18T12:00:00Z";
  await orders.importOrders([canonicalA], {
    id: 1,
    requestId: "test-technical-update-after-conflict",
  });
  canonicalA.lines[0].description = "Descrizione dopo aggiornamento tecnico";
  canonicalA.updatedAt = "2026-08-18T13:00:00Z";
  await orders.importOrders([canonicalA], {
    id: 1,
    requestId: "test-second-conflict-after-technical-update",
  });
  assert.equal(
    (
      await database.getPool().query(
        `SELECT previous_normalized_snapshot_json ->> 'updatedAt' AS previous_updated_at
             FROM order_source_revisions
             JOIN orders ON orders.id = order_source_revisions.order_id
             WHERE orders.external_order_id = $1
             ORDER BY order_source_revisions.id DESC LIMIT 1`,
        [canonicalA.externalOrderId],
      )
    ).rows[0].previous_updated_at,
    "2026-08-18T12:00:00Z",
  );

  const mapperCorrection = structuredClone(fixture[0]);
  mapperCorrection.externalOrderId = "shop-order-mapper-customer-correction";
  mapperCorrection.externalCustomerId = "shop-customer-mapper-customer-correction";
  mapperCorrection.createdAt = "2026-08-20T08:00:00Z";
  mapperCorrection.updatedAt = "2026-08-20T09:00:00Z";
  mapperCorrection.sourceSnapshot = { immutableProviderPayload: "same" };
  mapperCorrection.customer.taxIdentifiers = [];
  mapperCorrection.customer.billingAddress.line1 = "Via Esempio";
  mapperCorrection.customer.billingAddress.postalCode = "00100";
  mapperCorrection.customer.billingAddress.city = "Roma";
  mapperCorrection.customer.billingAddress.province = "RM";
  mapperCorrection.customer.shippingAddress = {
    line1: "Via Esempio 112",
    line2: "RSSMRA80A01H501U",
    postalCode: "00100",
    city: "Roma",
    province: "RM",
    countryCode: "IT",
  };
  await orders.importOrders([mapperCorrection], {
    id: 1,
    requestId: "test-mapper-customer-before",
  });
  const correctedMapperOrder = structuredClone(mapperCorrection);
  correctedMapperOrder.customer.taxIdentifiers = [
    {
      type: "CODICE_FISCALE",
      value: "RSSMRA80A01H501U",
      countryCode: "IT",
      sourceField: "shippingAddress.address2",
    },
  ];
  correctedMapperOrder.customer.billingAddress.line1 = "Via Esempio 112";
  delete correctedMapperOrder.customer.shippingAddress.line2;
  await orders.importOrders([correctedMapperOrder], {
    id: 1,
    requestId: "test-mapper-customer-after",
  });
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT billing_cases.status,
                  billing_cases.customer_id = orders.customer_id AS customer_aligned,
                  billing_cases.customer_snapshot_json ->> 'reviewRequired' AS review_required,
                  customers.tax_id_normalized,
                  (SELECT count(*) FROM order_source_revisions
                   WHERE order_id = orders.id)::int AS revision_count,
                  (SELECT count(*) FROM audit_events
                   WHERE entity_type = 'BILLING_CASE'
                     AND entity_id = billing_cases.id::text
                     AND action = 'CUSTOMER_CORRECTED'
                     AND actor_type = 'SYSTEM')::int AS correction_count
             FROM orders
             JOIN billing_cases ON billing_cases.id = orders.billing_case_id
             JOIN customers ON customers.id = orders.customer_id
             WHERE orders.external_order_id = $1`,
        [mapperCorrection.externalOrderId],
      )
    ).rows[0],
    {
      status: "READY",
      customer_aligned: true,
      review_required: "false",
      tax_id_normalized: "RSSMRA80A01H501U",
      revision_count: 0,
      correction_count: 1,
    },
  );

  const manualMapperReplay = structuredClone(mapperCorrection);
  manualMapperReplay.externalOrderId = "shop-order-manual-mapper-correction";
  manualMapperReplay.externalCustomerId = "shop-customer-manual-mapper-correction";
  manualMapperReplay.customer.email = "manual-mapper@example.invalid";
  await orders.importOrders([manualMapperReplay], {
    id: 1,
    requestId: "test-manual-mapper-before",
  });
  const manualMapperCaseId = (
    await database
      .getPool()
      .query("SELECT billing_case_id::text AS id FROM orders WHERE external_order_id = $1", [
        manualMapperReplay.externalOrderId,
      ])
  ).rows[0].id;
  await database.getPool().query(
    `UPDATE billing_cases
       SET customer_corrected_at = now(),
           customer_snapshot_json = jsonb_set(
             customer_snapshot_json, '{displayName}', '"Destinatario confermato manualmente"')
       WHERE id = $1`,
    [manualMapperCaseId],
  );
  const mapperAfterManualCorrection = structuredClone(manualMapperReplay);
  mapperAfterManualCorrection.customer.taxIdentifiers = [
    {
      type: "CODICE_FISCALE",
      value: "RSSMRA80A01H501U",
      countryCode: "IT",
      sourceField: "shippingAddress.address2",
    },
  ];
  mapperAfterManualCorrection.customer.billingAddress.line1 = "Via Esempio 112";
  delete mapperAfterManualCorrection.customer.shippingAddress.line2;
  await orders.importOrders([mapperAfterManualCorrection], {
    id: 1,
    requestId: "test-manual-mapper-after",
  });
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT billing_cases.customer_snapshot_json ->> 'displayName' AS display_name,
                  billing_cases.customer_corrected_at IS NOT NULL AS manually_corrected,
                  (SELECT count(*) FROM order_source_revisions
                   WHERE billing_case_id = billing_cases.id)::int AS revision_count
           FROM billing_cases WHERE id = $1`,
        [manualMapperCaseId],
      )
    ).rows[0],
    {
      display_name: "Destinatario confermato manualmente",
      manually_corrected: true,
      revision_count: 1,
    },
  );

  const profileA = structuredClone(fixture[0]);
  profileA.externalOrderId = "shop-order-profile-a";
  profileA.externalCustomerId = "shop-customer-profile-a";
  profileA.createdAt = "2026-08-21T08:00:00Z";
  profileA.updatedAt = "2026-08-21T09:00:00Z";
  profileA.customer.kind = "EU";
  profileA.customer.displayName = "ENTREPRISE EXEMPLE";
  profileA.customer.billingAddress.line1 = "Rue de Rome 1";
  profileA.customer.billingAddress.countryCode = "FR";
  profileA.customer.taxIdentifiers = [];
  const profileB = structuredClone(profileA);
  profileB.externalOrderId = "shop-order-profile-b";
  profileB.externalCustomerId = "shop-customer-profile-b";
  profileB.customer.displayName = "ENTREPRISE  EXEMPLE";
  profileB.customer.billingAddress.line1 = "RUE DE  ROME 1";
  await orders.importOrders([profileA, profileB], {
    id: 1,
    requestId: "test-profile-format-grouping",
  });
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT count(DISTINCT billing_case_id)::int AS case_count,
                    min(billing_cases.status) AS status
               FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
               WHERE external_order_id IN ($1, $2)`,
        [profileA.externalOrderId, profileB.externalOrderId],
      )
    ).rows[0],
    { case_count: 1, status: "READY" },
  );
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT orders.raw_snapshot_json #>> '{customer,displayName}' AS source_name,
                  orders.normalized_snapshot_json #>> '{customerSnapshot,displayName}' AS presentation_name,
                  customers.display_name AS customer_name
             FROM orders JOIN customers ON customers.id = orders.customer_id
             WHERE orders.external_order_id = $1`,
        [profileA.externalOrderId],
      )
    ).rows[0],
    {
      source_name: "ENTREPRISE EXEMPLE",
      presentation_name: "Entreprise Exemple",
      customer_name: "Entreprise Exemple",
    },
  );
  profileA.customer.displayName = "ENTREPRISE  EXEMPLE";
  profileA.customer.billingAddress.line1 = "RUE DE  ROME 1";
  profileA.updatedAt = "2026-08-21T10:00:00Z";
  await orders.importOrders([profileA], {
    id: 1,
    requestId: "test-profile-format-reimport",
  });
  assert.equal(
    (
      await database.getPool().query(
        `SELECT count(*) FROM order_source_revisions
             JOIN orders ON orders.id = order_source_revisions.order_id
             WHERE orders.external_order_id = $1`,
        [profileA.externalOrderId],
      )
    ).rows[0].count,
    "0",
  );

  const conflictingProfileA = structuredClone(fixture[0]);
  conflictingProfileA.externalOrderId = "shop-order-conflicting-profile-a";
  conflictingProfileA.externalCustomerId = "shop-customer-conflicting-profile-a";
  conflictingProfileA.customer.taxIdentifiers[0].value = "RSSMRA80A01H501L";
  conflictingProfileA.createdAt = "2026-08-22T08:00:00Z";
  conflictingProfileA.updatedAt = "2026-08-22T09:00:00Z";
  const conflictingProfileB = structuredClone(conflictingProfileA);
  conflictingProfileB.externalOrderId = "shop-order-conflicting-profile-b";
  conflictingProfileB.externalCustomerId = "shop-customer-conflicting-profile-b";
  conflictingProfileB.customer.billingAddress.line1 = "Via Milano 2";
  await orders.importOrders([conflictingProfileA, conflictingProfileB], {
    id: 1,
    requestId: "test-conflicting-profile-grouping",
  });
  const conflictingProfileCase = (
    await database.getPool().query(
      `SELECT billing_cases.id, billing_cases.status,
                  bool_and(orders.trigger_status = 'GROUPED') AS orders_grouped
             FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
             WHERE orders.external_order_id IN ($1, $2)
             GROUP BY billing_cases.id, billing_cases.status`,
      [conflictingProfileA.externalOrderId, conflictingProfileB.externalOrderId],
    )
  ).rows[0];
  assert.deepEqual(conflictingProfileCase, {
    id: conflictingProfileCase.id,
    status: "NEEDS_REVIEW",
    orders_grouped: true,
  });
  await orders.updateBillingCaseTransmission(
    String(conflictingProfileCase.id),
    "Anagrafica da verificare",
    await caseRevision(String(conflictingProfileCase.id)),
    { id: 1, requestId: "test-archive-conflicting-profile" },
  );
  assert.equal(
    await orders.updateBillingCaseTransmission(
      String(conflictingProfileCase.id),
      null,
      await caseRevision(String(conflictingProfileCase.id)),
      {
        id: 1,
        requestId: "test-reactivate-conflicting-profile",
      },
    ),
    "NEEDS_REVIEW",
  );

  const reviewedA = structuredClone(fixture[0]);
  reviewedA.externalOrderId = "shop-order-reviewed-a";
  reviewedA.externalCustomerId = "shop-customer-reviewed-a";
  reviewedA.createdAt = "2026-08-19T08:00:00Z";
  reviewedA.updatedAt = "2026-08-19T09:00:00Z";
  reviewedA.customer.taxIdentifiers[0].value = "RSSMRA80A01H501O";
  const reviewedB = structuredClone(reviewedA);
  reviewedB.externalOrderId = "shop-order-reviewed-b";
  reviewedB.externalCustomerId = "shop-customer-reviewed-b";
  await orders.importOrders([reviewedA, reviewedB], {
    id: 1,
    requestId: "test-reviewed-grouping",
  });
  reviewedA.lines[0].description = "Descrizione da verificare";
  reviewedA.updatedAt = "2026-08-19T10:00:00Z";
  await orders.importOrders([reviewedA], {
    id: 1,
    requestId: "test-reviewed-conflict",
  });
  reviewedB.lines[0].description = "Secondo ordine da verificare";
  reviewedB.updatedAt = "2026-08-19T10:15:00Z";
  await orders.importOrders([reviewedB], {
    id: 1,
    requestId: "test-reviewed-second-conflict",
  });
  reviewedB.cancelledAt = "2026-08-19T10:30:00Z";
  reviewedB.updatedAt = "2026-08-19T10:30:00Z";
  await orders.importOrders([reviewedB], {
    id: 1,
    requestId: "test-reviewed-cancellation",
  });
  const archivedCancelledCaseId = (
    await database.getPool().query(
      `SELECT entity_id FROM audit_events
           WHERE request_id = 'test-reviewed-cancellation'
             AND action = 'BILLING_CASE_DO_NOT_TRANSMIT'`,
    )
  ).rows[0].entity_id;
  assert.equal(
    (await orders.getBillingCase(String(archivedCancelledCaseId)))!.reactivation_blocker,
    "INCOMPATIBLE_ORDERS",
  );
  const recoveredReviewed = (
    await database.getPool().query(
      `SELECT orders.billing_case_id, billing_cases.status,
                  orders.normalized_snapshot_json ->> 'deferredReviewRequired'
                    AS deferred_review
             FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
             WHERE orders.external_order_id = $1`,
      [reviewedA.externalOrderId],
    )
  ).rows[0];
  assert.equal(recoveredReviewed.status, "NEEDS_REVIEW");
  assert.equal(recoveredReviewed.deferred_review, "true");
  await orders.updateBillingCaseTransmission(
    String(recoveredReviewed.billing_case_id),
    "Conflitto sorgente da verificare",
    await caseRevision(String(recoveredReviewed.billing_case_id)),
    { id: 1, requestId: "test-archive-recovered-review" },
  );
  assert.equal(
    await orders.updateBillingCaseTransmission(
      String(recoveredReviewed.billing_case_id),
      null,
      await caseRevision(String(recoveredReviewed.billing_case_id)),
      {
        id: 1,
        requestId: "test-reactivate-recovered-review",
      },
    ),
    "NEEDS_REVIEW",
  );
  reviewedB.cancelledAt = null;
  reviewedB.customer.taxIdentifiers[0].value = "RSSMRA80A01H501N";
  reviewedB.updatedAt = "2026-08-19T11:00:00Z";
  await orders.importOrders([reviewedB], {
    id: 1,
    requestId: "test-cancellation-revoked",
  });
  const reidentifiedOrder = (
    await database.getPool().query(
      `SELECT orders.billing_case_id, orders.trigger_status, orders.customer_id,
                  billing_cases.customer_id AS case_customer_id, billing_cases.status
             FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
             WHERE orders.external_order_id = $1`,
      [reviewedB.externalOrderId],
    )
  ).rows[0];
  assert.notEqual(reidentifiedOrder.billing_case_id, recoveredReviewed.billing_case_id);
  assert.equal(reidentifiedOrder.trigger_status, "GROUPED");
  assert.equal(reidentifiedOrder.customer_id, reidentifiedOrder.case_customer_id);
  assert.equal(reidentifiedOrder.status, "NEEDS_REVIEW");
  assert.ok(
    (await orders.getBillingCase(String(reidentifiedOrder.billing_case_id)))!.revisions.length > 0,
  );
  await orders.updateBillingCaseTransmission(
    String(reidentifiedOrder.billing_case_id),
    "Preparazione sostitutiva archiviata per il test",
    await caseRevision(String(reidentifiedOrder.billing_case_id)),
    { id: 1, requestId: "test-archive-replacement-case" },
  );
  await assert.rejects(
    orders.updateBillingCaseTransmission(
      String(archivedCancelledCaseId),
      null,
      await caseRevision(String(archivedCancelledCaseId)),
      {
        id: 1,
        requestId: "test-empty-case-reactivation",
      },
    ),
    (error: unknown) => error instanceof AppError && error.code === "BILLING_CASE_EMPTY",
  );
  assert.equal(
    (await orders.getBillingCase(String(archivedCancelledCaseId)))!.reactivation_blocker,
    "EMPTY",
  );
  await orders.updateBillingCaseTransmission(
    String(reidentifiedOrder.billing_case_id),
    null,
    await caseRevision(String(reidentifiedOrder.billing_case_id)),
    {
      id: 1,
      requestId: "test-reactivate-replacement-case",
    },
  );

  const precisePayment = structuredClone(fixture[0]);
  precisePayment.externalOrderId = "shop-order-precise-payment";
  precisePayment.externalCustomerId = "shop-customer-precise-payment";
  precisePayment.customer.taxIdentifiers[0].value = "RSSMRA80A01H501V";
  precisePayment.createdAt = "2026-08-25T08:00:00Z";
  precisePayment.updatedAt = "2026-08-25T09:00:00Z";
  precisePayment.payments[0].paidAt = "2026-08-25T08:30:00.000001Z";
  await orders.importOrders([precisePayment], {
    id: 1,
    requestId: "test-precise-payment-import",
  });
  precisePayment.payments[0].paidAt = "2026-08-25T08:30:00.000002Z";
  precisePayment.updatedAt = "2026-08-25T10:00:00Z";
  await orders.importOrders([precisePayment], {
    id: 1,
    requestId: "test-precise-payment-update",
  });
  assert.equal(
    (
      await database.getPool().query(
        `SELECT count(*) FROM order_source_revisions
             JOIN orders ON orders.id = order_source_revisions.order_id
             WHERE orders.external_order_id = $1`,
        [precisePayment.externalOrderId],
      )
    ).rows[0].count,
    "1",
  );

  const preciseCancellation = structuredClone(fixture[0]);
  preciseCancellation.externalOrderId = "shop-order-precise-cancellation";
  preciseCancellation.externalCustomerId = "shop-customer-precise-cancellation";
  preciseCancellation.customer.taxIdentifiers[0].value = "RSSMRA80A01H501Q";
  preciseCancellation.createdAt = "2026-08-26T08:00:00Z";
  preciseCancellation.updatedAt = "2026-08-26T09:00:00Z";
  await orders.importOrders([preciseCancellation], {
    id: 1,
    requestId: "test-precise-cancellation-import",
  });
  preciseCancellation.cancelledAt = "2026-08-26T09:30:00.000001Z";
  preciseCancellation.updatedAt = "2026-08-26T09:30:00Z";
  await orders.importOrders([preciseCancellation], {
    id: 1,
    requestId: "test-precise-cancellation-first",
  });
  preciseCancellation.cancelledAt = "2026-08-26T09:30:00.000002Z";
  preciseCancellation.updatedAt = "2026-08-26T10:00:00Z";
  await orders.importOrders([preciseCancellation], {
    id: 1,
    requestId: "test-precise-cancellation-second",
  });
  assert.equal(
    (
      await database.getPool().query(
        `SELECT count(*) FROM order_source_revisions
             JOIN orders ON orders.id = order_source_revisions.order_id
             WHERE orders.external_order_id = $1`,
        [preciseCancellation.externalOrderId],
      )
    ).rows[0].count,
    "2",
  );

  const healthySibling = structuredClone(fixture[0]);
  healthySibling.externalOrderId = "shop-order-healthy-sibling";
  healthySibling.externalCustomerId = "shop-customer-sibling-review";
  healthySibling.customer.taxIdentifiers[0].value = "RSSMRA80A01H501R";
  healthySibling.createdAt = "2026-08-27T08:00:00Z";
  healthySibling.updatedAt = "2026-08-27T09:00:00Z";
  const problematicSibling = structuredClone(healthySibling);
  problematicSibling.externalOrderId = "shop-order-problematic-sibling";
  problematicSibling.payments[0].status = "PENDING";
  await orders.importOrders([healthySibling, problematicSibling], {
    id: 1,
    requestId: "test-sibling-review-import",
  });
  problematicSibling.cancelledAt = "2026-08-27T10:00:00Z";
  problematicSibling.updatedAt = "2026-08-27T10:00:00Z";
  await orders.importOrders([problematicSibling], {
    id: 1,
    requestId: "test-sibling-review-cancellation",
  });
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT billing_cases.status,
                    orders.normalized_snapshot_json ->> 'deferredReviewRequired'
                      AS deferred_review
             FROM orders
             JOIN billing_cases ON billing_cases.id = orders.billing_case_id
             WHERE orders.external_order_id = $1`,
        [healthySibling.externalOrderId],
      )
    ).rows[0],
    { status: "READY", deferred_review: "false" },
  );

  const triggerConcurrentA = structuredClone(fixture[0]);
  triggerConcurrentA.externalOrderId = "shop-order-trigger-concurrent-a";
  triggerConcurrentA.externalCustomerId = "shop-customer-trigger-concurrent";
  triggerConcurrentA.customer.taxIdentifiers[0].value = "RSSMRA80A01H501M";
  triggerConcurrentA.createdAt = "2026-08-20T08:00:00Z";
  triggerConcurrentA.updatedAt = "2026-08-20T09:00:00Z";
  const triggerConcurrentB = structuredClone(triggerConcurrentA);
  triggerConcurrentB.externalOrderId = "shop-order-trigger-concurrent-b";
  await orders.importOrders([triggerConcurrentA, triggerConcurrentB], {
    id: 1,
    requestId: "test-trigger-concurrent-import",
  });
  const triggerConcurrentBId = (
    await database
      .getPool()
      .query("SELECT id FROM orders WHERE external_order_id = $1", [
        triggerConcurrentB.externalOrderId,
      ])
  ).rows[0].id;
  await Promise.all([
    orders.setDraftTrigger("PAID", 2, {
      id: 1,
      requestId: "test-trigger-concurrent-change",
    }),
    orders.forcePrepareOrder(triggerConcurrentBId, {
      id: 1,
      requestId: "test-trigger-concurrent-force",
    }),
  ]);
  assert.equal(
    (
      await database.getPool().query(
        `SELECT count(DISTINCT billing_case_id) FROM orders
             WHERE external_order_id IN ($1, $2)`,
        [triggerConcurrentA.externalOrderId, triggerConcurrentB.externalOrderId],
      )
    ).rows[0].count,
    "1",
  );

  const upgradedHistorical = structuredClone(fixture[0]);
  upgradedHistorical.externalOrderId = "shop-order-upgraded-historical";
  upgradedHistorical.externalCustomerId = "shop-customer-upgraded-historical";
  upgradedHistorical.customer.taxIdentifiers[0].value = "RSSMRA80A01H501E";
  upgradedHistorical.createdAt = "2026-08-18T08:00:00Z";
  upgradedHistorical.updatedAt = "2026-08-18T09:00:00Z";
  upgradedHistorical.historical = false;
  await orders.importOrders([upgradedHistorical], {
    id: 1,
    requestId: "test-before-history-upgrade",
  });
  const upgradedBefore = (
    await database.getPool().query(
      `SELECT orders.id, orders.billing_case_id, billing_cases.status
         FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
         WHERE orders.external_order_id = $1`,
      [upgradedHistorical.externalOrderId],
    )
  ).rows[0];
  assert.equal(upgradedBefore.status, "READY");
  upgradedHistorical.historical = true;
  upgradedHistorical.updatedAt = "2026-08-18T10:00:00Z";
  upgradedHistorical.refunds = [
    {
      externalRefundId: "upgraded-historical-total-refund",
      status: "COMPLETED",
      amount: upgradedHistorical.total,
      completedAt: "2026-08-18T10:00:00Z",
      raw: {},
    },
  ];
  await orders.importOrders([upgradedHistorical], {
    id: 1,
    requestId: "test-history-upgrade",
  });
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT billing_case_id, trigger_status,
                  normalized_snapshot_json ->> 'historical' AS historical
           FROM orders WHERE id = $1`,
        [upgradedBefore.id],
      )
    ).rows[0],
    { billing_case_id: null, trigger_status: "LEGACY_BILLING_REVIEW", historical: "true" },
  );
  assert.equal(
    (
      await database
        .getPool()
        .query("SELECT status FROM billing_cases WHERE id = $1", [upgradedBefore.billing_case_id])
    ).rows[0].status,
    "DO_NOT_TRANSMIT",
  );
  await assert.rejects(
    orders.forcePrepareOrder(upgradedBefore.id, {
      id: 1,
      requestId: "test-force-upgraded-historical",
    }),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_NOT_PREPARABLE",
  );
  const historical = structuredClone(fixture[0]);
  historical.externalOrderId = "shop-order-historical";
  historical.externalCustomerId = "shop-customer-historical";
  historical.customer.taxIdentifiers[0].value = "RSSMRA80A01H501C";
  historical.historical = true;
  historical.createdAt = "2026-08-19T08:00:00Z";
  historical.updatedAt = "2026-08-19T09:00:00Z";
  const reviewCountBeforeHistorical = Number((await orders.dashboardSummary()).review_cases);
  await orders.importOrders([historical], {
    id: 1,
    requestId: "test-historical-import",
  });
  const historicalId = (
    await database
      .getPool()
      .query("SELECT id FROM orders WHERE external_order_id = $1", [historical.externalOrderId])
  ).rows[0].id;
  assert.equal(
    Number((await orders.dashboardSummary()).review_cases),
    reviewCountBeforeHistorical + 1,
  );
  const historicalActivity = (await orders.listOpenActivities()).rows.find(
    (activity) => activity.kind === "ORDER" && activity.id === String(historicalId),
  );
  assert.equal(historicalActivity?.customer_tax_id, "RSSMRA80A01H501C");
  await orders.setDraftTrigger("PAID", 3, {
    id: 1,
    requestId: "test-historical-trigger-change",
  });
  assert.deepEqual(
    (
      await database
        .getPool()
        .query("SELECT trigger_status, billing_case_id FROM orders WHERE id = $1", [historicalId])
    ).rows[0],
    { trigger_status: "LEGACY_BILLING_REVIEW", billing_case_id: null },
  );
  await assert.rejects(
    orders.forcePrepareOrder(historicalId, { id: 1, requestId: "test-force-historical" }),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_NOT_PREPARABLE",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      historicalId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Tentativo diretto dell’account operatore",
      },
      { id: 2, canApprove: false, requestId: "test-reconcile-historical-forbidden" },
    ),
    (error: unknown) =>
      error instanceof AppError && error.code === "ORDER_HISTORY_RECONCILIATION_FORBIDDEN",
  );
  assert.equal((await orders.getOrder(historicalId))!.historical_reconciliation_outcome, null);
  const reconciledHistorical = await orders.reconcileHistoricalOrder(
    historicalId,
    {
      outcome: "NOT_INVOICED",
      reference: "Ricerca Aruba per ordine, data, cliente e totale: nessun documento",
    },
    { id: 1, canApprove: true, requestId: "test-reconcile-historical-clear" },
  );
  assert.ok(reconciledHistorical?.caseId);
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT trigger_status, historical_reconciliation_outcome,
                  historical_reconciled_at IS NOT NULL AS reconciled
           FROM orders WHERE id = $1`,
        [historicalId],
      )
    ).rows[0],
    {
      trigger_status: "GROUPED",
      historical_reconciliation_outcome: "NOT_INVOICED",
      reconciled: true,
    },
  );
  historical.updatedAt = "2026-08-19T09:30:00Z";
  historical.historical = false;
  await orders.importOrders([historical], {
    id: 1,
    requestId: "test-reimport-historical-clear",
  });
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT trigger_status,
                  normalized_snapshot_json ->> 'historical' AS historical,
                  historical_reconciliation_outcome
           FROM orders WHERE id = $1`,
        [historicalId],
      )
    ).rows[0],
    {
      trigger_status: "GROUPED",
      historical: "true",
      historical_reconciliation_outcome: "NOT_INVOICED",
    },
  );

  const alreadyInvoiced = structuredClone(historical);
  alreadyInvoiced.externalOrderId = "shop-order-historical-invoiced";
  alreadyInvoiced.customer.taxIdentifiers[0].value = "RSSMRA80A01H501U";
  alreadyInvoiced.historical = true;
  alreadyInvoiced.refunds = [
    {
      externalRefundId: "historical-invoiced-existing-refund",
      status: "COMPLETED",
      amount: "10.00",
      completedAt: "2026-08-20T09:45:00Z",
      raw: {},
    },
  ];
  await orders.importOrders([alreadyInvoiced], {
    id: 1,
    requestId: "test-import-historical-invoiced",
  });
  const alreadyInvoicedId = (
    await database
      .getPool()
      .query("SELECT id FROM orders WHERE external_order_id = $1", [
        alreadyInvoiced.externalOrderId,
      ])
  ).rows[0].id;
  await database.getPool().query(
    `INSERT INTO fiscal_profiles (version, status, profile_json)
       VALUES (1, 'MOCK', $1)`,
    [JSON.parse(await readFile("tests/fixtures/fatturapa/profile.mock.json", "utf8"))],
  );
  await database
    .getPool()
    .query(`UPDATE settings SET value_json = '"FULFILLED"' WHERE key = 'draft_trigger'`);
  const groupedPendingPayment = structuredClone(pendingPayment);
  groupedPendingPayment.externalOrderId = "shop-order-grouped-pending-payment";
  groupedPendingPayment.displayNumber = "#GROUPED-PENDING";
  groupedPendingPayment.payments = [structuredClone(pendingPayment.payments[0])];
  groupedPendingPayment.payments[0].externalPaymentId = "shop-payment-grouped-pending";
  groupedPendingPayment.sourceSnapshot = { immutableProviderPayload: "grouped-pending" };
  await orders.importOrders([groupedPendingPayment], {
    id: 1,
    requestId: "test-grouped-pending-payment",
  });
  assert.equal(
    (
      await database
        .getPool()
        .query("SELECT billing_case_id::text AS case_id FROM orders WHERE external_order_id = $1", [
          groupedPendingPayment.externalOrderId,
        ])
    ).rows[0].case_id,
    settledPaymentCase.case_id,
  );
  await database
    .getPool()
    .query(`UPDATE settings SET value_json = '"PAID"' WHERE key = 'draft_trigger'`);
  const settledInitialProjection = await invoiceDocuments.getInvoiceProjection(
    settledPaymentCase.case_id,
  );
  assert.ok(
    settledInitialProjection &&
      !settledInitialProjection.profileMissing &&
      "lines" in settledInitialProjection,
  );
  await invoiceDocuments.saveInvoiceDraft(
    settledPaymentCase.case_id,
    {
      caseRevision: settledInitialProjection.caseRevision,
      draftVersion: settledInitialProjection.draftVersion,
      lines: settledInitialProjection.lines,
      differenceReason: "",
      paymentStatus: "PENDING",
      paymentMethod: settledInitialProjection.paymentMethod,
      causale: "",
      notes: "",
    },
    { id: 1, canApprove: true, requestId: "test-pending-payment-old-draft" },
  );
  await database.getPool().query(
    `UPDATE orders
       SET normalized_snapshot_json = jsonb_set(
             jsonb_set(normalized_snapshot_json, '{reviewFingerprint}', '"legacy-pending"'),
             '{orderReviewRequired}', 'true')
       WHERE external_order_id = $1`,
    [pendingPayment.externalOrderId],
  );
  await database
    .getPool()
    .query("UPDATE billing_cases SET status = 'NEEDS_REVIEW' WHERE id = $1", [
      settledPaymentCase.case_id,
    ]);
  await orders.importOrders([pendingPayment], {
    id: 1,
    requestId: "test-pending-payment-replay",
  });
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT billing_cases.status, documents.payment_status,
                  (SELECT count(*) FROM order_source_revisions
                   WHERE order_id = orders.id)::int AS revision_count
           FROM orders
           JOIN billing_cases ON billing_cases.id = orders.billing_case_id
           JOIN documents ON documents.billing_case_id = billing_cases.id
           WHERE orders.external_order_id = $1`,
        [pendingPayment.externalOrderId],
      )
    ).rows[0],
    { status: "READY", payment_status: "PENDING", revision_count: 0 },
  );
  await database.getPool().query(
    `UPDATE orders SET billing_case_id = NULL, trigger_status = 'WAITING_FOR_TRIGGER'
       WHERE external_order_id = $1`,
    [groupedPendingPayment.externalOrderId],
  );
  await database.getPool().query(
    `UPDATE orders
       SET normalized_snapshot_json = jsonb_set(
             jsonb_set(normalized_snapshot_json, '{reviewFingerprint}', '"legacy-pending-single"'),
             '{orderReviewRequired}', 'true')
       WHERE external_order_id = $1`,
    [pendingPayment.externalOrderId],
  );
  await database
    .getPool()
    .query("UPDATE billing_cases SET status = 'NEEDS_REVIEW' WHERE id = $1", [
      settledPaymentCase.case_id,
    ]);
  await database
    .getPool()
    .query("UPDATE documents SET payment_status = 'PENDING' WHERE billing_case_id = $1", [
      settledPaymentCase.case_id,
    ]);
  await orders.importOrders([pendingPayment], {
    id: 1,
    requestId: "test-pending-payment-single-replay",
  });
  assert.equal(
    (await invoiceDocuments.getInvoiceProjection(settledPaymentCase.case_id))!.paymentStatus,
    "PAID",
  );

  return { historical, alreadyInvoiced, alreadyInvoicedId };
}

export type PaymentsCoreState = Awaited<ReturnType<typeof runPaymentsCoreScenario>>;
