import assert from "node:assert/strict";

import { loadEbayProvisionalIdentityIds } from "../order-source-identity.server.ts";
import { AppError } from "../../errors.ts";
import type { OrdersTestContext } from "./orders-test-support.test.ts";

export async function run(context: OrdersTestContext) {
  const { orders, database, fixture } = context;
  const provisional = structuredClone(fixture[1]);
  provisional.externalOrderId = "ebay-active-temporary";
  provisional.displayNumber = "ebay-active-temporary";
  provisional.createdAt = "2026-09-03T08:00:00Z";
  provisional.updatedAt = "2026-09-03T08:01:00Z";
  provisional.paymentStatus = "PENDING";
  provisional.fulfillmentStatus = "UNFULFILLED";
  provisional.sourceReviewRequired = true;
  provisional.sourceSnapshot = {
    sourceApi: "EBAY_TRADING",
    call: "GetOrders",
    payload: { OrderID: provisional.externalOrderId },
  };
  provisional.lines[0].externalLineId = "ebay-stable-line-transition";
  provisional.sourceIdentityIds = [provisional.lines[0].externalLineId];
  provisional.payments = [];
  provisional.refunds = [];
  assert.deepEqual(
    await orders.importOrders([provisional], {
      id: 1,
      requestId: "test-ebay-active-provisional",
    }),
    { imported: 1, updated: 0, ignored: 0 },
  );
  const before = await database
    .getPool()
    .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
      provisional.externalOrderId,
    ]);
  assert.deepEqual(
    [...(await loadEbayProvisionalIdentityIds(provisional.externalAccountId))],
    provisional.sourceIdentityIds,
  );

  const canonical = structuredClone(fixture[1]);
  canonical.externalOrderId = "ebay-canonical-final";
  canonical.displayNumber = "E-FINAL";
  canonical.createdAt = provisional.createdAt;
  canonical.updatedAt = "2026-09-03T08:05:00Z";
  canonical.lines[0].externalLineId = "ebay-rest-line-transition";
  canonical.sourceIdentityIds = [provisional.lines[0].externalLineId];
  canonical.payments[0].externalPaymentId = "ebay-payment-final";
  assert.deepEqual(
    await orders.importOrders([canonical], {
      id: 1,
      requestId: "test-ebay-canonical-transition",
    }),
    { imported: 0, updated: 1, ignored: 0 },
  );
  const after = await database.getPool().query<{
    id: string;
    external_order_id: string;
    payment_status: string;
    source_api: string | null;
  }>(
    `SELECT id, external_order_id, payment_status, raw_snapshot_json ->> 'sourceApi' AS source_api
     FROM orders WHERE id = $1`,
    [before.rows[0]!.id],
  );
  assert.deepEqual(after.rows[0], {
    id: before.rows[0]!.id,
    external_order_id: canonical.externalOrderId,
    payment_status: "PAID",
    source_api: null,
  });
  assert.equal(
    (
      await database.getPool().query(
        `SELECT count(*) FROM orders
         WHERE external_order_id IN ('ebay-active-temporary', 'ebay-canonical-final')`,
      )
    ).rows[0].count,
    "1",
  );
  assert.deepEqual([...(await loadEbayProvisionalIdentityIds(provisional.externalAccountId))], []);
  assert.equal(
    (
      await database.getPool().query(
        `SELECT count(*) FROM order_source_identities
         WHERE external_account_id = $1 AND external_id = $2 AND order_id = $3`,
        [canonical.externalAccountId, canonical.sourceIdentityIds[0], before.rows[0]!.id],
      )
    ).rows[0].count,
    "1",
  );

  const cancellable = structuredClone(provisional);
  cancellable.externalOrderId = "ebay-active-then-cancelled";
  cancellable.displayNumber = cancellable.externalOrderId;
  cancellable.lines[0].externalLineId = "ebay-cancelled-stable-line";
  cancellable.sourceIdentityIds = [cancellable.lines[0].externalLineId];
  await orders.importOrders([cancellable], {
    id: 1,
    requestId: "test-ebay-cancellable-provisional",
  });
  const pendingBeforeCancellation = Number((await orders.dashboardSummary()).pending_payments);
  const cancelled = structuredClone(cancellable);
  cancelled.updatedAt = "2026-09-03T10:00:00Z";
  cancelled.cancelledAt = cancelled.updatedAt;
  cancelled.sourceReviewRequired = false;
  cancelled.sourceSnapshot = {
    sourceApi: "EBAY_TRADING",
    call: "GetOrders",
    payload: { OrderID: cancelled.externalOrderId, OrderStatus: "Cancelled" },
  };
  assert.deepEqual(
    await orders.importOrders([cancelled], {
      id: 1,
      requestId: "test-ebay-provisional-cancelled",
    }),
    { imported: 0, updated: 1, ignored: 0 },
  );
  const cancelledRow = await database.getPool().query<{
    cancelled_at: string | null;
    trigger_status: string;
  }>(
    `SELECT cancelled_at::text, trigger_status
     FROM orders WHERE external_order_id = $1`,
    [cancelled.externalOrderId],
  );
  assert.ok(cancelledRow.rows[0]!.cancelled_at);
  assert.equal(cancelledRow.rows[0]!.trigger_status, "CANCELLED_NO_DOCUMENT");
  assert.equal(
    Number((await orders.dashboardSummary()).pending_payments),
    pendingBeforeCancellation - 1,
  );

  const collisionA = structuredClone(provisional);
  collisionA.externalOrderId = "ebay-collision-a";
  collisionA.updatedAt = "2026-09-03T09:00:00Z";
  collisionA.lines[0].externalLineId = "ebay-collision-line-a";
  collisionA.sourceIdentityIds = [collisionA.lines[0].externalLineId];
  const collisionB = structuredClone(provisional);
  collisionB.externalOrderId = "ebay-collision-b";
  collisionB.updatedAt = "2026-09-03T09:00:00Z";
  collisionB.lines[0].externalLineId = "ebay-collision-line-b";
  collisionB.sourceIdentityIds = [collisionB.lines[0].externalLineId];
  await orders.importOrders([collisionA, collisionB], {
    id: 1,
    requestId: "test-ebay-collision-seed",
  });
  const combinedCanonical = structuredClone(canonical);
  combinedCanonical.externalOrderId = "ebay-collision-final";
  combinedCanonical.updatedAt = "2026-09-03T09:05:00Z";
  combinedCanonical.lines = [
    { ...collisionA.lines[0], externalLineId: "ebay-collision-rest-a" },
    { ...collisionB.lines[0], externalLineId: "ebay-collision-rest-b" },
  ];
  combinedCanonical.sourceIdentityIds = [
    collisionA.sourceIdentityIds[0],
    collisionB.sourceIdentityIds[0],
  ];
  combinedCanonical.total = "150.00";
  combinedCanonical.payments[0].amount = "150.00";
  assert.deepEqual(
    await orders.importOrders([combinedCanonical], {
      id: 1,
      requestId: "test-ebay-collision-consolidation",
    }),
    { imported: 0, updated: 1, ignored: 0 },
  );
  const consolidated = await database.getPool().query<{
    id: string;
    external_order_id: string;
    identity_count: string;
  }>(
    `SELECT orders.id, orders.external_order_id, count(identities.external_id)::text AS identity_count
     FROM orders
     JOIN order_source_identities AS identities ON identities.order_id = orders.id
     WHERE orders.external_order_id IN ('ebay-collision-a', 'ebay-collision-b', 'ebay-collision-final')
     GROUP BY orders.id, orders.external_order_id`,
  );
  assert.deepEqual(consolidated.rows, [
    {
      id: consolidated.rows[0]!.id,
      external_order_id: combinedCanonical.externalOrderId,
      identity_count: "2",
    },
  ]);

  const unsafeProvisional = structuredClone(provisional);
  unsafeProvisional.externalOrderId = "ebay-partial-overlap";
  unsafeProvisional.lines = [
    { ...unsafeProvisional.lines[0], externalLineId: "ebay-overlap-a" },
    { ...unsafeProvisional.lines[0], externalLineId: "ebay-overlap-b" },
  ];
  unsafeProvisional.sourceIdentityIds = ["ebay-overlap-a", "ebay-overlap-b"];
  unsafeProvisional.total = "100.00";
  await orders.importOrders([unsafeProvisional], {
    id: 1,
    requestId: "test-ebay-partial-overlap-seed",
  });
  const incompleteCanonical = structuredClone(canonical);
  incompleteCanonical.externalOrderId = "ebay-partial-overlap-final";
  incompleteCanonical.sourceIdentityIds = ["ebay-overlap-a"];
  await assert.rejects(
    orders.importOrders([incompleteCanonical], {
      id: 1,
      requestId: "test-ebay-partial-overlap-fail-closed",
    }),
    (error: unknown) => error instanceof AppError && error.code === "CONFLICT_REVISION",
  );

  const combinedPartA = structuredClone(provisional);
  combinedPartA.externalOrderId = "158009594378-10084521158303";
  combinedPartA.displayNumber = combinedPartA.externalOrderId;
  combinedPartA.createdAt = "2026-09-03T18:30:00Z";
  combinedPartA.updatedAt = "2026-09-03T18:32:33Z";
  combinedPartA.total = "50.50";
  combinedPartA.shippingAmount = "8.50";
  combinedPartA.lines[0].externalLineId = combinedPartA.externalOrderId;
  combinedPartA.lines[0].grossAmount = "42.00";
  combinedPartA.sourceIdentityIds = [combinedPartA.externalOrderId];
  const combinedPartB = structuredClone(combinedPartA);
  combinedPartB.externalOrderId = "158009592316-10084667666812";
  combinedPartB.displayNumber = combinedPartB.externalOrderId;
  combinedPartB.lines[0].externalLineId = combinedPartB.externalOrderId;
  combinedPartB.sourceIdentityIds = [combinedPartB.externalOrderId];
  assert.deepEqual(
    await orders.importOrders([combinedPartA, combinedPartB], {
      id: 1,
      requestId: "test-ebay-real-combined-provisionals",
    }),
    { imported: 2, updated: 0, ignored: 0 },
  );

  const paidCombined = structuredClone(canonical);
  paidCombined.externalOrderId = "26-15090-88205";
  paidCombined.displayNumber = paidCombined.externalOrderId;
  paidCombined.createdAt = combinedPartA.createdAt;
  paidCombined.updatedAt = "2026-09-07T18:28:39Z";
  paidCombined.total = "92.85";
  paidCombined.shippingAmount = "8.85";
  paidCombined.lines = [
    {
      ...combinedPartA.lines[0],
      externalLineId: "10083398275426",
      description: "Divisionale San Marino 2006",
    },
    {
      ...combinedPartB.lines[0],
      externalLineId: "10083398275526",
      description: "Divisionale San Marino 2007",
    },
  ];
  paidCombined.sourceIdentityIds = ["158009594378-10083398275426", "158009592316-10083398275526"];
  paidCombined.payments[0].externalPaymentId = "ebay-payment-combined-real";
  paidCombined.payments[0].amount = paidCombined.total;
  paidCombined.payments[0].paidAt = paidCombined.updatedAt;
  assert.deepEqual(
    await orders.importOrders([paidCombined], {
      id: 1,
      requestId: "test-ebay-real-combined-canonical",
    }),
    { imported: 1, updated: 0, ignored: 0 },
  );
  const combinedOrder = (
    await database
      .getPool()
      .query<{ id: string; billing_case_id: string }>(
        `SELECT id, billing_case_id FROM orders WHERE external_order_id = $1`,
        [paidCombined.externalOrderId],
      )
  ).rows[0]!;
  const storage = (
    await database.getPool().query<{ id: string }>(
      `INSERT INTO storage_objects (kind, relative_path, sha256, size_bytes, content_type)
       VALUES ('INVOICE_XML', 'test/ebay-combined-order.xml', $1, 1, 'application/xml')
       RETURNING id`,
      ["8".repeat(64)],
    )
  ).rows[0]!;
  await database
    .getPool()
    .query("UPDATE billing_cases SET status = 'APPROVED' WHERE id = $1", [
      combinedOrder.billing_case_id,
    ]);
  const documentId = (
    await database.getPool().query<{ id: string }>(
      `INSERT INTO documents
         (billing_case_id, kind, status, document_type, series, document_date,
          fiscal_profile_version, currency, total_amount, source_total_amount,
          difference_amount, projection_sha256, payment_status, payment_method,
          recipient_snapshot_json)
       VALUES ($1, 'INVOICE', 'DRAFT', 'TD01', 'FPR', '2026-09-04', 1,
         'EUR', 9285, 9285, 0, $2, 'PAID', 'MP08', '{}')
       RETURNING id`,
      [combinedOrder.billing_case_id, "7".repeat(64)],
    )
  ).rows[0]!.id;
  await database.getPool().query(
    `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
     VALUES ($1, 'INVOICE', $2, 9285)`,
    [documentId, combinedOrder.id],
  );
  await database.getPool().query(
    `UPDATE documents
     SET status = 'APPROVED', fiscal_year = 2026, fiscal_number = 900001,
         approved_at = now(), xml_sha256 = $2, immutable_snapshot_json = '{}',
         fiscal_profile_snapshot_json = '{}', storage_object_id = $3
     WHERE id = $1`,
    [documentId, "8".repeat(64), storage.id],
  );
  const pendingBeforeAbsorption = Number((await orders.dashboardSummary()).pending_payments);

  const replayedCombined = structuredClone(paidCombined);
  replayedCombined.sourceIdentityIds = [
    combinedPartA.sourceIdentityIds[0],
    combinedPartB.sourceIdentityIds[0],
  ];
  assert.deepEqual(
    await orders.importOrders([replayedCombined], {
      id: 1,
      requestId: "test-ebay-real-combined-replay",
    }),
    { imported: 0, updated: 1, ignored: 0 },
  );
  const surviving = await database.getPool().query<{
    id: string;
    external_order_id: string;
    document_id: string;
  }>(
    `SELECT orders.id, orders.external_order_id, document_orders.document_id
     FROM orders
     JOIN document_orders ON document_orders.order_id = orders.id
     WHERE orders.external_order_id IN ($1, $2, $3)`,
    [combinedPartA.externalOrderId, combinedPartB.externalOrderId, paidCombined.externalOrderId],
  );
  assert.deepEqual(surviving.rows, [
    {
      id: combinedOrder.id,
      external_order_id: paidCombined.externalOrderId,
      document_id: documentId,
    },
  ]);
  assert.equal(
    Number((await orders.dashboardSummary()).pending_payments),
    pendingBeforeAbsorption - 2,
  );
}
