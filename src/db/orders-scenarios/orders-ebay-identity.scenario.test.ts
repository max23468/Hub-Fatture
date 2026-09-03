import assert from "node:assert/strict";

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
  const ambiguousCanonical = structuredClone(canonical);
  ambiguousCanonical.externalOrderId = "ebay-collision-final";
  ambiguousCanonical.updatedAt = "2026-09-03T09:05:00Z";
  ambiguousCanonical.lines = [
    { ...collisionA.lines[0], externalLineId: "ebay-collision-rest-a" },
    { ...collisionB.lines[0], externalLineId: "ebay-collision-rest-b" },
  ];
  ambiguousCanonical.sourceIdentityIds = [
    collisionA.sourceIdentityIds[0],
    collisionB.sourceIdentityIds[0],
  ];
  ambiguousCanonical.total = "150.00";
  ambiguousCanonical.payments[0].amount = "150.00";
  await assert.rejects(
    orders.importOrders([ambiguousCanonical], {
      id: 1,
      requestId: "test-ebay-collision-fail-closed",
    }),
    (error: unknown) => error instanceof AppError && error.code === "CONFLICT_REVISION",
  );
}
