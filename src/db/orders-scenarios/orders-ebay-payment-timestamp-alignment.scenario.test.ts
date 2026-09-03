import assert from "node:assert/strict";

import type { OrdersTestContext } from "./orders-test-support.test.ts";

function setPaymentTimestamp(order: Record<string, any>, timestamp: string, sourceMarker?: string) {
  order.updatedAt = timestamp;
  order.payments[0].paidAt = timestamp;
  order.sourceSnapshot = {
    lastModifiedDate: timestamp,
    ...(sourceMarker ? { sourceMarker } : {}),
    paymentSummary: {
      payments: [
        {
          paymentReferenceId: order.payments[0].externalPaymentId,
          paymentMethod: order.payments[0].method,
          paymentStatus: "PAID",
          amount: { value: order.payments[0].amount, currency: "EUR" },
          paymentDate: timestamp,
        },
      ],
    },
  };
}

export async function runEbayPaymentTimestampAlignmentScenario(context: OrdersTestContext) {
  const { orders, database, fixture } = context;
  const before = structuredClone(fixture[0]);
  before.provider = "EBAY";
  before.externalOrderId = "ebay-order-payment-timestamp";
  before.externalCustomerId = "ebay-customer-payment-timestamp";
  before.createdAt = "2026-09-03T07:00:00Z";
  before.customer.taxIdentifiers[0].value = "RSSMRA80A01H509U";
  setPaymentTimestamp(before, "2026-09-03T08:07:14Z");
  await orders.importOrders([before], { id: 1, requestId: "test-ebay-payment-time-before" });

  const after = structuredClone(before);
  setPaymentTimestamp(after, "2026-09-03T08:07:15Z");
  await orders.importOrders([after], { id: 1, requestId: "test-ebay-payment-time-after" });

  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT billing_cases.status, orders.trigger_status,
                coalesce(
                  (orders.normalized_snapshot_json ->> 'sourceConflictRequired')::boolean,
                  false
                ) AS source_conflict_required,
                (SELECT count(*) FROM order_source_revisions
                 WHERE order_id = orders.id)::int AS revision_count,
                (SELECT count(*) FROM audit_events
                 WHERE entity_type = 'ORDER' AND entity_id = orders.id::text
                   AND action = 'ORDER_SOURCE_REVIEWED'
                   AND metadata_json ->> 'automaticAlignment' = 'PAYMENT_TIMESTAMP_ONLY')::int
                  AS automatic_alignment_count
         FROM orders
         JOIN billing_cases ON billing_cases.id = orders.billing_case_id
         WHERE orders.external_order_id = $1`,
        [before.externalOrderId],
      )
    ).rows[0],
    {
      status: "READY",
      trigger_status: "GROUPED",
      source_conflict_required: false,
      revision_count: 0,
      automatic_alignment_count: 1,
    },
  );

  const existing = structuredClone(fixture[0]);
  existing.provider = "EBAY";
  existing.externalOrderId = "ebay-order-existing-payment-timestamp";
  existing.externalCustomerId = "ebay-customer-existing-payment-timestamp";
  existing.createdAt = "2026-09-04T07:00:00Z";
  existing.customer.taxIdentifiers[0].value = "RSSMRA80A01H510U";
  setPaymentTimestamp(existing, "2026-09-04T08:07:14Z", "before");
  await orders.importOrders([existing], {
    id: 1,
    requestId: "test-ebay-existing-payment-time-before",
  });
  const conflicted = structuredClone(existing);
  setPaymentTimestamp(conflicted, "2026-09-04T08:07:15Z", "after");
  await orders.importOrders([conflicted], {
    id: 1,
    requestId: "test-ebay-existing-payment-time-conflict",
  });
  await database.getPool().query(
    `UPDATE order_source_revisions
     SET previous_normalized_snapshot_json = previous_normalized_snapshot_json #- '{sourceSnapshot,sourceMarker}',
         current_normalized_snapshot_json = current_normalized_snapshot_json #- '{sourceSnapshot,sourceMarker}'
     WHERE order_id = (
       SELECT id FROM orders WHERE external_order_id = $1
     )`,
    [existing.externalOrderId],
  );
  const replay = structuredClone(conflicted);
  delete replay.sourceSnapshot.sourceMarker;
  await orders.importOrders([replay], {
    id: 1,
    requestId: "test-ebay-existing-payment-time-replay",
  });

  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT billing_cases.status, orders.trigger_status,
                (orders.normalized_snapshot_json ->> 'sourceConflictRequired')::boolean
                  AS source_conflict_required,
                (SELECT count(*) FROM order_source_revisions
                 WHERE order_id = orders.id)::int AS revision_count,
                (SELECT count(*) FROM audit_events
                 WHERE entity_type = 'ORDER' AND entity_id = orders.id::text
                   AND action = 'ORDER_SOURCE_REVIEWED'
                   AND metadata_json ->> 'automaticAlignment' = 'PAYMENT_TIMESTAMP_ONLY')::int
                  AS automatic_alignment_count
         FROM orders
         JOIN billing_cases ON billing_cases.id = orders.billing_case_id
         WHERE orders.external_order_id = $1`,
        [existing.externalOrderId],
      )
    ).rows[0],
    {
      status: "READY",
      trigger_status: "GROUPED",
      source_conflict_required: false,
      revision_count: 1,
      automatic_alignment_count: 1,
    },
  );
}
