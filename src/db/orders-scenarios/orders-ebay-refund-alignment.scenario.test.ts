import assert from "node:assert/strict";

import type { OrdersTestContext } from "./orders-test-support.test.ts";

export async function runEbayRefundAlignmentScenario(context: OrdersTestContext) {
  const { orders, database, fixture } = context;
  const refundMapperConflict = structuredClone(fixture[0]);
  refundMapperConflict.provider = "EBAY";
  refundMapperConflict.externalOrderId = "ebay-order-existing-refund-mapper-conflict";
  refundMapperConflict.externalCustomerId = "ebay-customer-existing-refund-mapper-conflict";
  refundMapperConflict.createdAt = "2026-08-27T08:00:00Z";
  refundMapperConflict.updatedAt = "2026-08-27T09:00:00Z";
  refundMapperConflict.customer.taxIdentifiers[0].value = "RSSMRA80A01H505U";
  refundMapperConflict.sourceSnapshot = { immutableRefundPayload: "before" };
  refundMapperConflict.refunds = [
    {
      externalRefundId: "ebay-refund-mapper",
      status: "AMBIGUOUS",
      amount: null,
      completedAt: "2026-08-27T08:30:00Z",
      raw: { amount: { value: "7.98", currency: "EUR" } },
    },
  ];
  await orders.importOrders([refundMapperConflict], {
    id: 1,
    requestId: "test-ebay-refund-mapper-before",
  });
  const completedRefund = structuredClone(refundMapperConflict);
  completedRefund.sourceSnapshot = { immutableRefundPayload: "after" };
  completedRefund.refunds[0].status = "COMPLETED";
  completedRefund.refunds[0].amount = "9.00";
  await orders.importOrders([completedRefund], {
    id: 1,
    requestId: "test-ebay-refund-mapper-conflict",
  });
  const refundMapperCaseId = (
    await database
      .getPool()
      .query("SELECT billing_case_id::text AS id FROM orders WHERE external_order_id = $1", [
        refundMapperConflict.externalOrderId,
      ])
  ).rows[0].id;
  await database.getPool().query(
    `UPDATE order_source_revisions
       SET previous_normalized_snapshot_json = jsonb_set(
             previous_normalized_snapshot_json,
             '{sourceSnapshot}',
             '{"immutableRefundPayload":"same"}'::jsonb),
           current_normalized_snapshot_json = jsonb_set(
             current_normalized_snapshot_json,
             '{sourceSnapshot}',
             '{"immutableRefundPayload":"same"}'::jsonb)
     WHERE billing_case_id = $1`,
    [refundMapperCaseId],
  );
  await database.getPool().query(
    `UPDATE orders
       SET normalized_snapshot_json = jsonb_set(
             normalized_snapshot_json,
             '{sourceSnapshot}',
             '{"immutableRefundPayload":"same"}'::jsonb)
     WHERE billing_case_id = $1`,
    [refundMapperCaseId],
  );
  completedRefund.sourceSnapshot = { immutableRefundPayload: "same" };
  await orders.importOrders([completedRefund], {
    id: 1,
    requestId: "test-ebay-refund-mapper-replay",
  });
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT billing_cases.status, orders.trigger_status,
                (orders.normalized_snapshot_json ->> 'sourceConflictRequired')::boolean
                  AS source_conflict_required,
                (SELECT count(*) FROM audit_events
                 WHERE entity_type = 'ORDER' AND entity_id = orders.id::text
                   AND action = 'ORDER_SOURCE_REVIEWED'
                   AND metadata_json ->> 'automaticAlignment' = 'REFUND_MAPPER')::int
                  AS automatic_alignment_count
         FROM orders
         JOIN billing_cases ON billing_cases.id = orders.billing_case_id
         WHERE orders.external_order_id = $1`,
        [refundMapperConflict.externalOrderId],
      )
    ).rows[0],
    {
      status: "READY",
      trigger_status: "GROUPED",
      source_conflict_required: false,
      automatic_alignment_count: 1,
    },
  );
}
