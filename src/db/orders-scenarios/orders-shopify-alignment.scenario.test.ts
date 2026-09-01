import assert from "node:assert/strict";

import type { OrdersTestContext } from "./orders-test-support.test.ts";

export async function run(context: OrdersTestContext) {
  const { orders, database, fixture } = context;
  const fulfillment = structuredClone(fixture[0]);
  fulfillment.externalOrderId = "shop-order-fulfillment-only";
  fulfillment.externalCustomerId = "shop-customer-fulfillment-only";
  fulfillment.displayNumber = "#FULFILLMENT-ONLY";
  fulfillment.createdAt = "2026-08-17T12:00:00Z";
  fulfillment.updatedAt = "2026-08-17T14:57:48Z";
  fulfillment.fulfillmentStatus = "UNFULFILLED";
  fulfillment.sourceSnapshot = { displayFulfillmentStatus: "UNFULFILLED" };
  await orders.importOrders([fulfillment], { id: 1, requestId: "shopify-fulfillment-before" });
  const fulfilled = structuredClone(fulfillment);
  fulfilled.updatedAt = "2026-09-01T13:28:25Z";
  fulfilled.fulfillmentStatus = "FULFILLED";
  fulfilled.sourceSnapshot = {
    displayFulfillmentStatus: "FULFILLED",
    transactions: [{ presentmentMoney: { amount: fulfilled.total, currencyCode: "EUR" } }],
  };
  await orders.importOrders([fulfilled], { id: 1, requestId: "shopify-fulfillment-after" });
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT billing_cases.status, orders.trigger_status,
                (SELECT count(*)::integer FROM order_source_revisions
                 WHERE order_id = orders.id) AS revision_count,
                (SELECT count(*)::integer FROM audit_events
                 WHERE entity_type = 'ORDER' AND entity_id = orders.id::text
                   AND action = 'ORDER_SOURCE_REVIEWED'
                   AND metadata_json ->> 'automaticAlignment' = 'FULFILLMENT_ONLY') AS alignments
         FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
         WHERE orders.external_order_id = $1`,
        [fulfillment.externalOrderId],
      )
    ).rows[0],
    { status: "READY", trigger_status: "GROUPED", revision_count: 0, alignments: 1 },
  );

  const prior = structuredClone(fixture[0]);
  prior.externalOrderId = "shop-order-prior-tax";
  prior.externalCustomerId = "gid://shopify/Customer/shared-tax";
  prior.displayNumber = "#4027-SYNTHETIC";
  prior.createdAt = "2026-08-17T12:00:00Z";
  prior.updatedAt = "2026-08-17T13:00:00Z";
  prior.customer.billingAddress.line2 = "RSSMRA80A01H501U";
  prior.customer.taxIdentifiers = [
    {
      type: "CODICE_FISCALE",
      value: "RSSMRA80A01H501U",
      countryCode: "IT",
      sourceField: "billingAddress.address2",
    },
  ];
  await orders.importOrders([prior], { id: 1, requestId: "shopify-prior-tax" });
  const missing = structuredClone(prior);
  missing.externalOrderId = "shop-order-missing-tax";
  missing.displayNumber = "#3957-SYNTHETIC";
  missing.createdAt = "2026-07-07T20:41:14Z";
  missing.updatedAt = "2026-07-07T20:41:14Z";
  missing.customer.billingAddress.line2 = "0";
  missing.customer.taxIdentifiers = [];
  await orders.importOrders([missing], { id: 1, requestId: "shopify-missing-tax" });
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT normalized_snapshot_json ->> 'customerReviewRequired' AS review_required,
                tax.type, tax.normalized_value,
                tax.source_field LIKE 'priorOrder:%:billingAddress.address2' AS recovered
         FROM orders JOIN order_tax_identifiers tax ON tax.order_id = orders.id
         WHERE orders.external_order_id = $1`,
        [missing.externalOrderId],
      )
    ).rows[0],
    {
      review_required: "false",
      type: "CODICE_FISCALE",
      normalized_value: "RSSMRA80A01H501U",
      recovered: true,
    },
  );
}
