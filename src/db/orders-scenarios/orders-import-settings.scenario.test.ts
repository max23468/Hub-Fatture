import assert from "node:assert/strict";
import { AppError } from "../../errors.ts";
import { withClient } from "../database-fixture.ts";
import {
  legacyReviewFingerprint,
  waitForBlockedQuery,
  type OrdersTestContext,
} from "./orders-test-support.test.ts";

export async function run(context: OrdersTestContext) {
  const { orders, database, fixture, connectionString } = context;
  await database.getPool().query(
    `INSERT INTO connections
          (provider, environment, account_reference, encrypted_credentials, status, last_synced_at)
       VALUES
          ('SHOPIFY', 'DEVELOPMENT', 'revoked-shop.invalid', 'synthetic', 'REVOKED', now()),
          ('EBAY', 'SANDBOX', 'connected-ebay', 'synthetic', 'CONNECTED', now())`,
  );
  const connectionSummary = await orders.dashboardSummary();
  assert.equal(connectionSummary.shopify_connection_status, "REVOKED");
  assert.ok(connectionSummary.last_shopify_sync);
  assert.equal(connectionSummary.ebay_connection_status, "CONNECTED");
  await assert.rejects(
    orders.importOrders([fixture[0], fixture[0]], {
      id: 1,
      requestId: "test-duplicate-order-in-batch",
    }),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_INVALID_INPUT",
  );
  assert.deepEqual(await orders.importOrders(fixture, { id: 1, requestId: "test-order-import" }), {
    imported: 3,
    updated: 0,
    ignored: 0,
  });
  assert.deepEqual(
    await orders.importOrders(fixture, { id: 1, requestId: "test-order-reimport" }),
    { imported: 0, updated: 3, ignored: 0 },
  );
  const feeOrder = structuredClone(fixture[0]);
  feeOrder.externalOrderId = "shop-order-shopify-payments-fee";
  feeOrder.displayNumber = "#S-FEE";
  feeOrder.createdAt = "2026-08-09T08:15:00Z";
  feeOrder.updatedAt = "2026-08-09T09:00:00Z";
  feeOrder.customer.taxIdentifiers[0].value = "VRDLGI80A01H501Z";
  feeOrder.payments[0].externalPaymentId = "shop-payment-fee";
  feeOrder.payments[0].method = "shopify_payments";
  feeOrder.payments[0].shopifyPaymentsFeeAmount = "2.57";
  await orders.importOrders([feeOrder], { id: 1, requestId: "test-shopify-payment-fee" });
  const feeState = async () =>
    (
      await database.getPool().query(
        `SELECT orders.gross_amount, orders.shopify_payments_fee_amount,
                  orders.deducted_shopify_payments_fee_amount, orders.billable_amount,
                  payments.shopify_payments_fee_amount AS payment_fee
           FROM orders JOIN payments ON payments.order_id = orders.id
           WHERE orders.external_order_id = $1`,
        [feeOrder.externalOrderId],
      )
    ).rows[0];
  assert.deepEqual(await feeState(), {
    gross_amount: 12_200,
    shopify_payments_fee_amount: 257,
    deducted_shopify_payments_fee_amount: 257,
    billable_amount: 11_943,
    payment_fee: 257,
  });
  const feeSetting = await orders.getShopifyPaymentFeeMode();
  assert.equal(feeSetting.value, "DEDUCT");
  await orders.setShopifyPaymentFeeMode("INCLUDE", feeSetting.version, {
    id: 1,
    requestId: "test-include-shopify-payment-fee",
  });
  assert.deepEqual(await feeState(), {
    gross_amount: 12_200,
    shopify_payments_fee_amount: 257,
    deducted_shopify_payments_fee_amount: 0,
    billable_amount: 12_200,
    payment_fee: 257,
  });
  const includedSetting = await orders.getShopifyPaymentFeeMode();
  await orders.setShopifyPaymentFeeMode("DEDUCT", includedSetting.version, {
    id: 1,
    requestId: "test-deduct-shopify-payment-fee",
  });
  assert.equal((await feeState()).billable_amount, 11_943);
  await database.getPool().query(
    `UPDATE orders
       SET normalized_snapshot_json = jsonb_set(normalized_snapshot_json, '{historical}', 'true'),
           historical_reconciliation_outcome = 'NOT_INVOICED',
           historical_reconciliation_reference = 'Riconciliazione storica chiusa nel test',
           historical_reconciled_at = now()
       WHERE external_order_id = $1`,
    [feeOrder.externalOrderId],
  );
  const closedHistorySetting = await orders.getShopifyPaymentFeeMode();
  await orders.setShopifyPaymentFeeMode("INCLUDE", closedHistorySetting.version, {
    id: 1,
    requestId: "test-closed-history-shopify-payment-fee",
  });
  assert.equal((await feeState()).billable_amount, 11_943);
  const restoredFeeSetting = await orders.getShopifyPaymentFeeMode();
  await orders.setShopifyPaymentFeeMode("DEDUCT", restoredFeeSetting.version, {
    id: 1,
    requestId: "test-restore-shopify-payment-fee-mode",
  });
  const feeCaseId = (
    await database
      .getPool()
      .query<{ billing_case_id: string | null }>(
        "SELECT billing_case_id::text FROM orders WHERE external_order_id = $1",
        [feeOrder.externalOrderId],
      )
  ).rows[0]!.billing_case_id;
  await database
    .getPool()
    .query("DELETE FROM orders WHERE external_order_id = $1", [feeOrder.externalOrderId]);
  if (feeCaseId) {
    await database.getPool().query("DELETE FROM billing_cases WHERE id = $1", [feeCaseId]);
  }
  await database
    .getPool()
    .query(`DELETE FROM audit_events WHERE request_id = ANY($1::text[])`, [
      [
        "test-shopify-payment-fee",
        "test-include-shopify-payment-fee",
        "test-deduct-shopify-payment-fee",
        "test-closed-history-shopify-payment-fee",
        "test-restore-shopify-payment-fee-mode",
      ],
    ]);
  const preFeeMigrationOrders = [
    {
      ...structuredClone(fixture[0]),
      externalOrderId: "shop-order-pre-fee-paypal",
      externalCustomerId: "shop-customer-pre-fee-paypal",
      displayNumber: "#PRE-FEE-PAYPAL",
      createdAt: "2026-09-10T08:00:00Z",
      updatedAt: "2026-09-10T09:00:00Z",
      customer: {
        ...structuredClone(fixture[0].customer),
        taxIdentifiers: [
          {
            ...structuredClone(fixture[0].customer.taxIdentifiers[0]),
            value: "RSSMRA80A01H501X",
          },
        ],
      },
      payments: [
        {
          ...structuredClone(fixture[0].payments[0]),
          externalPaymentId: "shop-payment-pre-fee-paypal",
          method: "paypal",
          paidAt: "2026-09-10T09:00:00Z",
        },
      ],
    },
    {
      ...structuredClone(fixture[1]),
      externalOrderId: "ebay-order-pre-fee",
      externalCustomerId: "ebay-customer-pre-fee",
      displayNumber: "E-PRE-FEE",
      createdAt: "2026-09-11T08:00:00Z",
      updatedAt: "2026-09-11T09:00:00Z",
      customer: {
        ...structuredClone(fixture[1].customer),
        taxIdentifiers: [
          {
            ...structuredClone(fixture[1].customer.taxIdentifiers[0]),
            value: "RSSMRA80A01H501Y",
          },
        ],
      },
      payments: [
        {
          ...structuredClone(fixture[1].payments[0]),
          externalPaymentId: "ebay-payment-pre-fee",
          paidAt: "2026-09-11T09:00:00Z",
        },
      ],
    },
  ];
  for (const candidate of preFeeMigrationOrders) {
    await orders.importOrders([candidate], {
      id: 1,
      requestId: `test-${candidate.externalOrderId}-initial`,
    });
    const storedOrder = (
      await database
        .getPool()
        .query<{ id: string; billing_case_id: string }>(
          `SELECT id, billing_case_id FROM orders WHERE external_order_id = $1`,
          [candidate.externalOrderId],
        )
    ).rows[0]!;
    await database.getPool().query(
      `UPDATE orders
         SET normalized_snapshot_json = jsonb_set(
           normalized_snapshot_json #- '{payments,0,shopifyPaymentsFeeAmount}',
           '{reviewFingerprint}', to_jsonb($2::text)
         )
         WHERE id = $1`,
      [storedOrder.id, legacyReviewFingerprint(candidate)],
    );
    candidate.updatedAt = candidate.updatedAt.replace("09:00:00Z", "10:00:00Z");
    await orders.importOrders([candidate], {
      id: 1,
      requestId: `test-${candidate.externalOrderId}-unchanged`,
    });
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT billing_cases.status,
                    count(order_source_revisions.id)::int AS revision_count
             FROM orders
             JOIN billing_cases ON billing_cases.id = orders.billing_case_id
             LEFT JOIN order_source_revisions ON order_source_revisions.order_id = orders.id
             WHERE orders.id = $1
             GROUP BY billing_cases.status`,
          [storedOrder.id],
        )
      ).rows[0],
      { status: "READY", revision_count: 0 },
    );
  }
  const preFeeRows = await database.getPool().query<{
    id: string;
    billing_case_id: string;
    customer_id: string;
  }>(
    `SELECT id, billing_case_id, customer_id FROM orders
       WHERE external_order_id = ANY($1::text[])`,
    [preFeeMigrationOrders.map((candidate) => candidate.externalOrderId)],
  );
  await database
    .getPool()
    .query("DELETE FROM orders WHERE id = ANY($1::bigint[])", [
      preFeeRows.rows.map((row) => row.id),
    ]);
  await database
    .getPool()
    .query("DELETE FROM billing_cases WHERE id = ANY($1::bigint[])", [
      preFeeRows.rows.map((row) => row.billing_case_id),
    ]);
  await database
    .getPool()
    .query("DELETE FROM customer_source_records WHERE external_customer_id = ANY($1::text[])", [
      preFeeMigrationOrders.map((candidate) => candidate.externalCustomerId),
    ]);
  await database
    .getPool()
    .query("DELETE FROM customers WHERE id = ANY($1::bigint[])", [
      preFeeRows.rows.map((row) => row.customer_id),
    ]);
  await database.getPool().query(
    `DELETE FROM audit_events
       WHERE request_id = ANY($1::text[])`,
    [
      preFeeMigrationOrders.flatMap((candidate) => [
        `test-${candidate.externalOrderId}-initial`,
        `test-${candidate.externalOrderId}-unchanged`,
      ]),
    ],
  );
  await database.getPool().query(
    `INSERT INTO payments
          (order_id, external_payment_id, method, status, amount, paid_at,
           recorded_manually, raw_json)
         SELECT id, 'manual-payment', 'Contanti', 'PAID', 100, now(), true, '{}'::jsonb
         FROM orders WHERE external_order_id = $1`,
    [fixture[0].externalOrderId],
  );
  await orders.importOrders([fixture[0]], {
    id: 1,
    requestId: "test-manual-payment-preserved",
  });
  assert.equal(
    (
      await database.getPool().query(
        `SELECT count(*) FROM payments
             JOIN orders ON orders.id = payments.order_id
             WHERE orders.external_order_id = $1 AND payments.recorded_manually = true`,
        [fixture[0].externalOrderId],
      )
    ).rows[0].count,
    "1",
  );
  const snapshotOrder = (
    await database
      .getPool()
      .query("SELECT id, billing_case_id FROM orders WHERE external_order_id = $1", [
        fixture[0].externalOrderId,
      ])
  ).rows[0];
  let orderDetailPromise: ReturnType<typeof orders.getOrder> | undefined;
  await withClient(connectionString, async (orderBlocker) => {
    await orderBlocker.query("BEGIN");
    await orderBlocker.query("LOCK TABLE order_lines IN ACCESS EXCLUSIVE MODE");
    orderDetailPromise = orders.getOrder(String(snapshotOrder.id));
    await waitForBlockedQuery(orderBlocker);
    await orderBlocker.query("UPDATE orders SET gross_amount = 12345 WHERE id = $1", [
      snapshotOrder.id,
    ]);
    await orderBlocker.query("UPDATE order_lines SET gross_amount = 12345 WHERE order_id = $1", [
      snapshotOrder.id,
    ]);
    await orderBlocker.query("COMMIT");
  });
  const snapshotOrderDetail = await orderDetailPromise;
  assert.equal(
    snapshotOrderDetail!.gross_amount,
    snapshotOrderDetail!.lines.reduce(
      (total: number, line: { gross_amount: number }) => total + line.gross_amount,
      0,
    ),
  );
  await database
    .getPool()
    .query("UPDATE orders SET gross_amount = 12200 WHERE id = $1", [snapshotOrder.id]);
  await database
    .getPool()
    .query("UPDATE order_lines SET gross_amount = 12200 WHERE order_id = $1", [snapshotOrder.id]);

  let caseDetailPromise: ReturnType<typeof orders.getBillingCase> | undefined;
  await withClient(connectionString, async (auditBlocker) => {
    await auditBlocker.query("BEGIN");
    await auditBlocker.query("LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE");
    caseDetailPromise = orders.getBillingCase(String(snapshotOrder.billing_case_id));
    await waitForBlockedQuery(auditBlocker);
    await auditBlocker.query("UPDATE billing_cases SET status = 'NEEDS_REVIEW' WHERE id = $1", [
      snapshotOrder.billing_case_id,
    ]);
    await auditBlocker.query(
      `INSERT INTO audit_events
            (actor_type, action, event_class, entity_type, entity_id, request_id)
           VALUES ('SYSTEM', 'BILLING_CASE_REACTIVATED', 'CRITICAL',
                   'BILLING_CASE', $1, 'test-snapshot-marker')`,
      [snapshotOrder.billing_case_id],
    );
    await auditBlocker.query("COMMIT");
  });
  const snapshotCaseDetail = await caseDetailPromise;
  assert.equal(snapshotCaseDetail!.status, "NEEDS_REVIEW");
  assert.ok(
    snapshotCaseDetail!.audit.some(
      (event: { request_id: string }) => event.request_id === "test-snapshot-marker",
    ),
  );
  await database
    .getPool()
    .query("UPDATE billing_cases SET status = 'READY' WHERE id = $1", [
      snapshotOrder.billing_case_id,
    ]);
  await database
    .getPool()
    .query("DELETE FROM audit_events WHERE request_id = 'test-snapshot-marker'");

  await withClient(connectionString, async (client) => {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('setting:draft_trigger'))");
    let completed = false;
    const blockedImport = orders
      .importOrders([fixture[0]], { id: 1, requestId: "test-trigger-lock" })
      .finally(() => {
        completed = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(completed, false);
    await client.query("COMMIT");
    assert.deepEqual(await blockedImport, { imported: 0, updated: 1, ignored: 0 });
  });
  assert.equal(await orders.getOrder("non-numerico"), null);
  assert.equal(await orders.getBillingCase("0"), null);
  assert.deepEqual((await orders.listOrders({ query: "test\0non valido" })).rows, []);
  assert.deepEqual((await orders.listOrders({ localDate: "0000-01-01" })).rows, []);
  const outOfRangeId = "9223372036854775808";
  assert.deepEqual(
    await Promise.all([
      orders.getOrder(outOfRangeId),
      orders.getBillingCase(outOfRangeId),
      orders.forcePrepareOrder(outOfRangeId, { id: 1, requestId: "test-invalid-order-id" }),
      orders.updateBillingCaseTransmission(outOfRangeId, null, 0, {
        id: 1,
        requestId: "test-invalid-case-id",
      }),
    ]),
    [null, null, null, null],
  );
  assert.equal(typeof (await orders.getOrder("1"))?.local_order_date, "string");
  assert.equal((await database.getPool().query("SELECT count(*) FROM orders")).rows[0].count, "3");
  assert.equal(
    (await database.getPool().query("SELECT count(*) FROM billing_cases")).rows[0].count,
    "1",
  );
  assert.equal(
    (
      await database
        .getPool()
        .query(
          "SELECT count(DISTINCT billing_case_id) FROM orders WHERE external_order_id IN ('shop-order-1001', 'ebay-order-2001')",
        )
    ).rows[0].count,
    "1",
  );
  assert.equal((await orders.listOrders({ paymentStatus: "PENDING" })).rows.length, 1);
  assert.equal((await orders.listOrders({ query: "shop-order-1001" })).rows.length, 1);
  const ordersByTotalAsc = await orders.listOrders({
    sort: { key: "totale", direction: "asc" },
  });
  const ordersByTotalDesc = await orders.listOrders({
    sort: { key: "totale", direction: "desc" },
  });
  assert.deepEqual(
    ordersByTotalDesc.rows.map(({ gross_amount }) => gross_amount),
    ordersByTotalAsc.rows.map(({ gross_amount }) => gross_amount).reverse(),
  );
  const waitingOrderId = (
    await database
      .getPool()
      .query("SELECT id FROM orders WHERE external_order_id = 'shop-order-1002'")
  ).rows[0].id;
  const forcedCaseId = await orders.forcePrepareOrder(waitingOrderId, {
    id: 1,
    requestId: "test-force-prepare",
  });
  assert.equal(
    await orders.forcePrepareOrder(waitingOrderId, {
      id: 1,
      requestId: "test-force-prepare-idempotent",
    }),
    forcedCaseId,
  );
  const casesByDateAsc = await orders.listBillingCases({
    sort: { key: "data", direction: "asc" },
  });
  const casesByDateDesc = await orders.listBillingCases({
    sort: { key: "data", direction: "desc" },
  });
  assert.deepEqual(
    casesByDateDesc.rows.map(({ id }) => id),
    casesByDateAsc.rows.map(({ id }) => id).reverse(),
  );
  assert.deepEqual(
    await orders.setDraftTrigger("FULFILLED", 1, {
      id: 1,
      requestId: "test-trigger-change",
    }),
    { value: "FULFILLED", version: 2 },
  );
  await assert.rejects(
    orders.setDraftTrigger("PAID", Number.POSITIVE_INFINITY, {
      id: 1,
      requestId: "test-trigger-invalid-version",
    }),
    /I dati dell’ordine non sono validi/,
  );
  await assert.rejects(
    orders.setDraftTrigger("PAID", 2_147_483_648, {
      id: 1,
      requestId: "test-trigger-version-overflow",
    }),
    /I dati dell’ordine non sono validi/,
  );
  assert.equal(
    (await database.getPool().query("SELECT count(*) FROM billing_cases")).rows[0].count,
    "2",
  );
  assert.equal(
    (
      await database
        .getPool()
        .query("SELECT bool_and(public_number ~ '^[0-9]{6}$') AS valid FROM billing_cases")
    ).rows[0].valid,
    true,
  );
  assert.equal(
    (
      await database
        .getPool()
        .query("SELECT count(*) FROM billing_cases WHERE status = 'NEEDS_REVIEW'")
    ).rows[0].count,
    "1",
  );
  await assert.rejects(
    orders.setDraftTrigger("PAID", 1, { id: 1, requestId: "test-stale-trigger" }),
    /I dati sono cambiati/,
  );
  const unsupported = structuredClone(fixture);
  unsupported[0].externalOrderId = "shop-order-usd";
  unsupported[0].currency = "USD";
  const validBeforeInvalid = structuredClone(fixture[0]);
  validBeforeInvalid.externalOrderId = "shop-order-rolled-back";
  await assert.rejects(
    orders.importOrders([validBeforeInvalid, unsupported[0]], {
      id: 1,
      requestId: "test-usd",
    }),
    /soltanto ordini in euro/,
  );
  assert.equal((await database.getPool().query("SELECT count(*) FROM orders")).rows[0].count, "3");
  assert.equal(
    (
      await database
        .getPool()
        .query("SELECT count(*) FROM orders WHERE external_order_id = 'shop-order-rolled-back'")
    ).rows[0].count,
    "0",
  );
  assert.equal(
    (
      await database
        .getPool()
        .query(
          "SELECT count(*) FROM audit_events WHERE action IN ('ORDER_IMPORTED', 'ORDER_GROUPED', 'DRAFT_TRIGGER_CHANGED')",
        )
    ).rows[0].count,
    "6",
  );
  assert.equal(
    (
      await database
        .getPool()
        .query("SELECT count(*) FROM audit_events WHERE action = 'ORDER_GROUPING_FORCED'")
    ).rows[0].count,
    "1",
  );
}
