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
  await database.getPool().query(
    `UPDATE orders
     SET normalized_snapshot_json = normalized_snapshot_json - 'sourceIdentityIds'
     WHERE external_order_id = $1`,
    [fulfillment.externalOrderId],
  );
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

  const ebayFulfillment = structuredClone(fulfillment);
  ebayFulfillment.provider = "EBAY";
  ebayFulfillment.externalOrderId = "ebay-order-fulfillment-only";
  ebayFulfillment.externalAccountId = "ebay-account";
  ebayFulfillment.externalCustomerId = "ebay-customer-fulfillment-only";
  ebayFulfillment.displayNumber = "E-FULFILLMENT-ONLY";
  ebayFulfillment.createdAt = "2026-09-07T08:00:00Z";
  ebayFulfillment.updatedAt = "2026-09-07T08:25:12Z";
  ebayFulfillment.sourceSnapshot = { orderFulfillmentStatus: "NOT_STARTED" };
  await orders.importOrders([ebayFulfillment], {
    id: 1,
    requestId: "ebay-fulfillment-before",
  });
  const ebayBefore = (
    await database
      .getPool()
      .query(`SELECT normalized_snapshot_json FROM orders WHERE external_order_id = $1`, [
        ebayFulfillment.externalOrderId,
      ])
  ).rows[0].normalized_snapshot_json;
  const ebayFulfilled = structuredClone(ebayFulfillment);
  ebayFulfilled.updatedAt = "2026-09-07T09:25:12Z";
  ebayFulfilled.fulfillmentStatus = "FULFILLED";
  ebayFulfilled.sourceSnapshot = { orderFulfillmentStatus: "FULFILLED" };
  await orders.importOrders([ebayFulfilled], {
    id: 1,
    requestId: "ebay-fulfillment-after",
  });
  const ebayOrder = (
    await database.getPool().query(
      `SELECT id, billing_case_id, normalized_snapshot_json
       FROM orders WHERE external_order_id = $1`,
      [ebayFulfillment.externalOrderId],
    )
  ).rows[0];
  await database.getPool().query(
    `UPDATE orders
     SET trigger_status = 'NEEDS_REVIEW',
         normalized_snapshot_json = jsonb_set(
           normalized_snapshot_json, '{sourceConflictRequired}', 'true'::jsonb)
     WHERE id = $1`,
    [ebayOrder.id],
  );
  await database
    .getPool()
    .query(`UPDATE billing_cases SET status = 'NEEDS_REVIEW' WHERE id = $1`, [
      ebayOrder.billing_case_id,
    ]);
  await database.getPool().query(
    `INSERT INTO order_source_revisions
       (order_id, billing_case_id, previous_normalized_snapshot_json,
        current_normalized_snapshot_json)
     VALUES ($1, $2, $3, $4)`,
    [
      ebayOrder.id,
      ebayOrder.billing_case_id,
      JSON.stringify(ebayBefore),
      JSON.stringify(ebayOrder.normalized_snapshot_json),
    ],
  );
  await orders.importOrders([ebayFulfilled], {
    id: 1,
    requestId: "ebay-fulfillment-replay",
  });
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT billing_cases.status, orders.trigger_status,
                orders.normalized_snapshot_json ->> 'sourceConflictRequired'
                  AS source_conflict_required,
                (SELECT count(*)::integer FROM audit_events
                 WHERE entity_type = 'ORDER' AND entity_id = orders.id::text
                   AND action = 'ORDER_SOURCE_REVIEWED'
                   AND metadata_json ->> 'automaticAlignment' = 'FULFILLMENT_ONLY') AS alignments
         FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
         WHERE orders.external_order_id = $1`,
        [ebayFulfillment.externalOrderId],
      )
    ).rows[0],
    {
      status: "READY",
      trigger_status: "GROUPED",
      source_conflict_required: "false",
      alignments: 2,
    },
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
