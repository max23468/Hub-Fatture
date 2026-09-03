import assert from "node:assert/strict";

import type { OrdersTestContext } from "./orders-test-support.test.ts";

export async function runEbayCareOfAlignmentScenario(context: OrdersTestContext) {
  const { orders, database, fixture } = context;
  const before = structuredClone(fixture[0]);
  before.provider = "EBAY";
  before.externalOrderId = "ebay-order-care-of-address";
  before.externalCustomerId = "ebay-customer-care-of-address";
  before.createdAt = "2026-08-30T10:00:00Z";
  before.updatedAt = "2026-08-30T11:00:00Z";
  before.customer.email = "care-of@example.invalid";
  before.customer.displayName = "Mario Rossi c/o Anna Bianchi";
  delete before.customer.firstName;
  delete before.customer.lastName;
  before.customer.billingAddress = { ...before.customer.billingAddress, line2: undefined };
  before.customer.shippingAddress = { ...before.customer.shippingAddress, line2: undefined };
  before.sourceSnapshot = {
    fulfillmentStartInstructions: [
      {
        shippingStep: {
          shipTo: {
            fullName: "Mario Rossi c/o Anna Bianchi",
            contactAddress: {},
          },
        },
      },
    ],
  };
  await orders.importOrders([before], { id: 1, requestId: "test-ebay-care-of-before" });

  const after = structuredClone(before);
  after.customer.displayName = "Mario Rossi";
  after.customer.billingAddress.line2 = "c/o Anna Bianchi";
  after.customer.shippingAddress.line2 = "c/o Anna Bianchi";
  await orders.importOrders([after], { id: 1, requestId: "test-ebay-care-of-after" });

  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT billing_cases.status,
                billing_cases.customer_snapshot_json ->> 'displayName' AS display_name,
                billing_cases.customer_snapshot_json #>> '{billingAddress,line2}' AS line_2,
                orders.trigger_status,
                billing_cases.customer_corrected_at IS NOT NULL AS manually_corrected,
                (SELECT count(*) FROM orders AS case_order
                 WHERE case_order.billing_case_id = billing_cases.id)::int AS order_count,
                (SELECT count(*) FROM order_source_revisions
                 WHERE order_id = orders.id)::int AS revision_count,
                (SELECT count(*) FROM audit_events
                 WHERE entity_type = 'BILLING_CASE' AND entity_id = billing_cases.id::text
                   AND action = 'CUSTOMER_CORRECTED'
                   AND metadata_json ->> 'automaticAlignment' = 'CARE_OF_ADDRESS')::int
                  AS automatic_alignment_count
         FROM orders
         JOIN billing_cases ON billing_cases.id = orders.billing_case_id
         WHERE orders.external_order_id = $1`,
        [before.externalOrderId],
      )
    ).rows[0],
    {
      status: "NEEDS_REVIEW",
      display_name: "Mario Rossi",
      line_2: "c/o Anna Bianchi",
      trigger_status: "GROUPED",
      manually_corrected: false,
      order_count: 1,
      revision_count: 0,
      automatic_alignment_count: 1,
    },
  );
}
