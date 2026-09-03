import assert from "node:assert/strict";
import { AppError } from "../../errors.ts";
import type { OrdersTestContext } from "./orders-test-support.test.ts";

export async function run(context: OrdersTestContext) {
  const { orders, database, caseRevision, fixture } = context;
  const approvedGroup = [structuredClone(fixture[0]), structuredClone(fixture[1])];
  approvedGroup[0].externalOrderId = "shop-order-approved-1";
  approvedGroup[1].externalOrderId = "ebay-order-approved-2";
  for (const approvedOrder of approvedGroup) {
    approvedOrder.createdAt = "2026-08-12T08:00:00Z";
    approvedOrder.updatedAt = "2026-08-12T09:00:00Z";
  }
  approvedGroup[1].paymentStatus = "PENDING";
  approvedGroup[1].payments[0].status = "PENDING";
  await orders.importOrders(approvedGroup, { id: 1, requestId: "test-approved-group" });
  const approvedCaseId = (
    await database
      .getPool()
      .query("SELECT billing_case_id FROM orders WHERE external_order_id = $1", [
        approvedGroup[0].externalOrderId,
      ])
  ).rows[0].billing_case_id;
  await database
    .getPool()
    .query("UPDATE billing_cases SET status = 'APPROVED' WHERE id = $1", [approvedCaseId]);
  approvedGroup[1].lines[0].description = "Descrizione aggiornata dopo l’emissione";
  approvedGroup[1].paymentStatus = "PAID";
  approvedGroup[1].payments[0].status = "PAID";
  approvedGroup[1].total = "130.00";
  approvedGroup[1].lines[0].grossAmount = "130.00";
  approvedGroup[1].payments[0].amount = "130.00";
  approvedGroup[1].customer.displayName = "Cliente modificato dopo l’emissione";
  approvedGroup[1].updatedAt = "2026-08-12T09:30:00Z";
  await orders.importOrders([approvedGroup[1]], {
    id: 1,
    requestId: "test-approved-non-refund-conflict",
  });
  assert.equal(
    (
      await database
        .getPool()
        .query("SELECT trigger_status FROM orders WHERE external_order_id = $1", [
          approvedGroup[1].externalOrderId,
        ])
    ).rows[0].trigger_status,
    "INVOICED",
  );
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT orders.gross_amount, orders.payment_status,
                    (SELECT gross_amount FROM order_lines WHERE order_id = orders.id) AS line_amount,
                    (SELECT amount FROM payments WHERE order_id = orders.id) AS payment_amount,
                    (SELECT status FROM payments WHERE order_id = orders.id) AS payment_row_status,
                    customers.display_name
             FROM orders JOIN customers ON customers.id = orders.customer_id
             WHERE orders.external_order_id = $1`,
        [approvedGroup[1].externalOrderId],
      )
    ).rows[0],
    {
      gross_amount: 7500,
      payment_status: "PAID",
      line_amount: 7500,
      payment_amount: 13000,
      payment_row_status: "PAID",
      display_name: "Mario Rossi",
    },
  );
  approvedGroup[1].updatedAt = "2026-08-12T09:45:00Z";
  await orders.importOrders([approvedGroup[1]], {
    id: 1,
    requestId: "test-approved-identical-reimport",
  });
  assert.equal(
    (
      await database.getPool().query(
        `SELECT count(*) FROM order_source_revisions
             JOIN orders ON orders.id = order_source_revisions.order_id
             WHERE orders.external_order_id = $1`,
        [approvedGroup[1].externalOrderId],
      )
    ).rows[0].count,
    "1",
  );
  approvedGroup[1].payments = [
    {
      ...approvedGroup[1].payments[0],
      externalPaymentId: "replacement-payment",
      method: "BANK_TRANSFER",
    },
  ];
  approvedGroup[1].updatedAt = "2026-08-12T09:50:00Z";
  await orders.importOrders([approvedGroup[1]], {
    id: 1,
    requestId: "test-approved-replaced-payment",
  });
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT payments.external_payment_id, payments.method, payments.amount
               FROM payments JOIN orders ON orders.id = payments.order_id
               WHERE orders.external_order_id = $1`,
        [approvedGroup[1].externalOrderId],
      )
    ).rows,
    [{ external_payment_id: "replacement-payment", method: "BANK_TRANSFER", amount: 13000 }],
  );
  approvedGroup[0].paymentStatus = "REFUNDED";
  approvedGroup[0].payments[0].status = "REFUNDED";
  approvedGroup[0].updatedAt = "2026-08-12T10:00:00Z";
  await orders.importOrders([approvedGroup[0]], {
    id: 1,
    requestId: "test-approved-source-conflict",
  });
  const preservedApprovedGroup = await database.getPool().query(
    `SELECT billing_cases.status, count(*)::int AS order_count
           FROM billing_cases JOIN orders ON orders.billing_case_id = billing_cases.id
           WHERE billing_cases.id = $1 GROUP BY billing_cases.status`,
    [approvedCaseId],
  );
  assert.equal(preservedApprovedGroup.rows[0].status, "APPROVED");
  assert.equal(preservedApprovedGroup.rows[0].order_count, 2);
  assert.equal(
    (
      await database
        .getPool()
        .query("SELECT trigger_status FROM orders WHERE external_order_id = $1", [
          approvedGroup[0].externalOrderId,
        ])
    ).rows[0].trigger_status,
    "INVOICED",
  );
  assert.equal(
    (
      await database
        .getPool()
        .query("SELECT count(*) FROM audit_events WHERE action = 'BILLING_CASE_DO_NOT_TRANSMIT'")
    ).rows[0].count,
    "0",
  );
  const sourceChanged = structuredClone(fixture[0]);
  sourceChanged.paymentStatus = "REFUNDED";
  sourceChanged.payments[0].status = "REFUNDED";
  sourceChanged.updatedAt = "2026-08-08T10:00:00Z";
  await orders.importOrders([sourceChanged], {
    id: 1,
    requestId: "test-source-conflict",
  });
  const conflictedCase = (
    await database.getPool().query(
      `SELECT billing_cases.id, orders.id AS order_id, billing_cases.status, customers.review_required
             FROM billing_cases
             JOIN customers ON customers.id = billing_cases.customer_id
             JOIN orders ON orders.billing_case_id = billing_cases.id
             WHERE orders.external_order_id = 'shop-order-1001'`,
    )
  ).rows[0];
  assert.equal(conflictedCase.status, "DO_NOT_TRANSMIT");
  assert.equal(conflictedCase.review_required, false);
  assert.equal((await orders.getBillingCase(conflictedCase.id))?.status, "DO_NOT_TRANSMIT");
  assert.equal(
    (await orders.listOrders({ status: "ACTIVE" })).rows.some(
      (order) => order.id === conflictedCase.order_id,
    ),
    false,
  );
  assert.equal(
    (await orders.listOrders({ status: "NO_DOCUMENT" })).rows.some(
      (order) => order.id === conflictedCase.order_id,
    ),
    true,
  );
  const regroupedOrder = (
    await database.getPool().query(
      `SELECT orders.billing_case_id, orders.trigger_status, billing_cases.status
             FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
             WHERE orders.external_order_id = 'ebay-order-2001'`,
    )
  ).rows[0];
  assert.notEqual(regroupedOrder.billing_case_id, conflictedCase.id);
  assert.equal(regroupedOrder.trigger_status, "GROUPED");
  assert.equal(regroupedOrder.status, "READY");
  assert.equal(
    (
      await database
        .getPool()
        .query("SELECT count(*) FROM audit_events WHERE action = 'ORDER_SOURCE_CONFLICT'")
    ).rows[0].count,
    "4",
  );
  assert.equal(
    (
      await database.getPool().query(
        `SELECT count(*) FROM order_source_revisions
             WHERE billing_case_id = $1
               AND previous_normalized_snapshot_json ->> 'paymentStatus' = 'PAID'
               AND current_normalized_snapshot_json ->> 'paymentStatus' = 'REFUNDED'`,
        [conflictedCase.id],
      )
    ).rows[0].count,
    "1",
  );
  assert.equal(
    (
      await database
        .getPool()
        .query(`SELECT do_not_transmit_reason FROM billing_cases WHERE id = $1`, [
          conflictedCase.id,
        ])
    ).rows[0].do_not_transmit_reason,
    "Ordine rimborsato prima dell’emissione",
  );
  assert.deepEqual(
    await orders.importOrders([fixture[0]], {
      id: 1,
      requestId: "test-stale-source-update",
    }),
    { imported: 0, updated: 0, ignored: 1 },
  );
  const preservedSource = (
    await database.getPool().query(
      `SELECT updated_at_source::text, payment_status, trigger_status
             FROM orders WHERE external_order_id = 'shop-order-1001'`,
    )
  ).rows[0];
  assert.equal(preservedSource.payment_status, "REFUNDED");
  assert.equal(preservedSource.trigger_status, "REFUNDED_BEFORE_ISSUE");
  assert.match(preservedSource.updated_at_source, /^2026-08-08 10:00:00/);
  await database.getPool().query(
    `UPDATE orders SET updated_at_source = '2026-08-08T10:00:00.123457Z'
         WHERE external_order_id = 'shop-order-1001'`,
  );
  const staleMicrosecond = structuredClone(sourceChanged);
  staleMicrosecond.paymentStatus = "PAID";
  staleMicrosecond.payments[0].status = "PAID";
  staleMicrosecond.updatedAt = "2026-08-08T10:00:00.123456Z";
  assert.deepEqual(
    await orders.importOrders([staleMicrosecond], {
      id: 1,
      requestId: "test-stale-source-microsecond",
    }),
    { imported: 0, updated: 0, ignored: 1 },
  );
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT updated_at_source::text, payment_status
             FROM orders WHERE external_order_id = 'shop-order-1001'`,
      )
    ).rows[0],
    { updated_at_source: "2026-08-08 10:00:00.123457+00", payment_status: "REFUNDED" },
  );
  const reactivatedPending = structuredClone(sourceChanged);
  reactivatedPending.paymentStatus = "PENDING";
  reactivatedPending.fulfillmentStatus = "UNFULFILLED";
  reactivatedPending.payments[0].status = "PENDING";
  reactivatedPending.payments[0].paidAt = null;
  reactivatedPending.updatedAt = "2026-08-08T11:00:00Z";
  await orders.importOrders([reactivatedPending], {
    id: 1,
    requestId: "test-reactivated-pending",
  });
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT billing_case_id, trigger_status,
                    normalized_snapshot_json ->> 'deferredReviewRequired' AS deferred_review
               FROM orders WHERE external_order_id = $1`,
        [reactivatedPending.externalOrderId],
      )
    ).rows[0],
    { billing_case_id: null, trigger_status: "WAITING_FOR_TRIGGER", deferred_review: "true" },
  );
  reactivatedPending.paymentStatus = "PAID";
  reactivatedPending.fulfillmentStatus = "FULFILLED";
  reactivatedPending.payments[0].status = "PAID";
  reactivatedPending.payments[0].paidAt = "2026-08-08T12:00:00Z";
  reactivatedPending.updatedAt = "2026-08-08T12:00:00Z";
  await orders.importOrders([reactivatedPending], {
    id: 1,
    requestId: "test-reactivated-paid",
  });
  assert.equal(
    (
      await database.getPool().query(
        `SELECT billing_cases.status
               FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
               WHERE orders.external_order_id = $1`,
        [reactivatedPending.externalOrderId],
      )
    ).rows[0].status,
    "NEEDS_REVIEW",
  );
  const invalidAmount = structuredClone(fixture[1]);
  invalidAmount.externalOrderId = "ebay-invalid-amount";
  invalidAmount.lines[0].grossAmount = "12.345";
  await assert.rejects(
    orders.importOrders([invalidAmount], { id: 1, requestId: "test-invalid-amount" }),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_INVALID_INPUT",
  );
  const excessiveDiscount = structuredClone(fixture[1]);
  excessiveDiscount.externalOrderId = "ebay-invalid-discount";
  excessiveDiscount.lines[0].discountAmount = "75.01";
  await assert.rejects(
    orders.importOrders([excessiveDiscount], {
      id: 1,
      requestId: "test-invalid-discount",
    }),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_INVALID_INPUT",
  );
  const excessiveQuantity = structuredClone(fixture[1]);
  excessiveQuantity.externalOrderId = "ebay-invalid-quantity";
  excessiveQuantity.lines[0].quantity = 2_147_483_648;
  await assert.rejects(
    orders.importOrders([excessiveQuantity], {
      id: 1,
      requestId: "test-invalid-quantity",
    }),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_INVALID_INPUT",
  );
  const nullByteText = structuredClone(fixture[1]);
  nullByteText.externalOrderId = "ebay-invalid-null-byte";
  nullByteText.lines[0].description = "Test\0non persistibile";
  await assert.rejects(
    orders.importOrders([nullByteText], { id: 1, requestId: "test-invalid-null-byte" }),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_INVALID_INPUT",
  );
  const invalidTimestamp = structuredClone(fixture[1]);
  invalidTimestamp.externalOrderId = "ebay-invalid-timestamp";
  invalidTimestamp.createdAt = "0000-01-01T00:00:00Z";
  await assert.rejects(
    orders.importOrders([invalidTimestamp], { id: 1, requestId: "test-invalid-timestamp" }),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_INVALID_INPUT",
  );
  await assert.rejects(
    orders.updateBillingCaseTransmission("1", "Test\0non persistibile", await caseRevision("1"), {
      id: 1,
      requestId: "test-invalid-reason-null-byte",
    }),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_INVALID_INPUT",
  );
  const cancelled = structuredClone(fixture[2]);
  cancelled.externalOrderId = "shop-order-cancelled";
  cancelled.cancelledAt = "2026-08-08T11:00:00Z";
  const pendingBeforeCancelled = (await orders.dashboardSummary()).pending_payments;
  await orders.importOrders([cancelled], { id: 1, requestId: "test-cancelled" });
  assert.equal((await orders.dashboardSummary()).pending_payments, pendingBeforeCancelled);
  const cancelledId = (
    await database
      .getPool()
      .query("SELECT id FROM orders WHERE external_order_id = 'shop-order-cancelled'")
  ).rows[0].id;
  await assert.rejects(
    orders.forcePrepareOrder(cancelledId, { id: 1, requestId: "test-force-cancelled" }),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_NOT_PREPARABLE",
  );
  const refunded = structuredClone(fixture[2]);
  refunded.externalOrderId = "shop-order-refunded";
  refunded.paymentStatus = "REFUNDED";
  refunded.payments = [];
  await orders.importOrders([refunded], { id: 1, requestId: "test-refunded" });
  const refundedId = (
    await database
      .getPool()
      .query("SELECT id FROM orders WHERE external_order_id = 'shop-order-refunded'")
  ).rows[0].id;
  await assert.rejects(
    orders.forcePrepareOrder(refundedId, { id: 1, requestId: "test-force-refunded" }),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_NOT_PREPARABLE",
  );
  refunded.createdAt = "2026-08-09T08:00:00Z";
  refunded.updatedAt = "2026-08-09T09:00:00Z";
  await orders.importOrders([refunded], { id: 1, requestId: "test-corrected-created-at" });
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT created_at_source = $2::timestamptz AS created_at_matches,
                    local_order_date::text
               FROM orders WHERE external_order_id = $1`,
        [refunded.externalOrderId, refunded.createdAt],
      )
    ).rows[0],
    { created_at_matches: true, local_order_date: "2026-08-09" },
  );
}
