import assert from "node:assert/strict";

import type { OrdersTestContext } from "./orders-test-support.test.ts";

export async function run(context: OrdersTestContext) {
  const { orders, database, fixture } = context;
  const automaticException = structuredClone(fixture[0]);
  automaticException.provider = "EBAY";
  automaticException.externalOrderId = "ebay-order-automatic-identity-exception";
  automaticException.externalCustomerId = "ebay-customer-automatic-identity-exception";
  automaticException.createdAt = "2026-08-24T10:00:00Z";
  automaticException.updatedAt = "2026-08-24T11:00:00Z";
  automaticException.sourceSnapshot = { immutableEbayPayload: "identity-exception" };
  automaticException.customer.displayName = "Giovanni Bianchi";
  automaticException.customer.taxIdentifiers[0].countryCode = "IT";
  delete automaticException.customer.firstName;
  delete automaticException.customer.lastName;

  await orders.importOrders([automaticException], {
    type: "SYSTEM",
    requestId: "test-ebay-automatic-identity-exception",
  });
  await orders.importOrders([automaticException], {
    type: "SYSTEM",
    requestId: "test-ebay-automatic-identity-exception-idempotent",
  });

  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT customers.first_name, customers.last_name, customers.review_required,
                billing_cases.status,
                orders.raw_snapshot_json #>> '{customer,firstName}' AS raw_first_name,
                orders.raw_snapshot_json #>> '{customer,lastName}' AS raw_last_name,
                (SELECT count(*)::integer FROM customer_identity_exceptions
                 WHERE external_customer_id = $1 AND decision_mode = 'AUTOMATIC'
                   AND accepted_by IS NULL) AS exception_count,
                (SELECT count(*)::integer FROM audit_events
                 WHERE entity_type = 'CUSTOMER' AND entity_id = customers.id::text
                   AND action = 'CUSTOMER_IDENTITY_EXCEPTION_APPLIED') AS audit_count
         FROM orders
         JOIN customers ON customers.id = orders.customer_id
         JOIN billing_cases ON billing_cases.id = orders.billing_case_id
         WHERE orders.external_order_id = $2`,
        [automaticException.externalCustomerId, automaticException.externalOrderId],
      )
    ).rows[0],
    {
      first_name: "Giovanni",
      last_name: "Bianchi",
      review_required: false,
      status: "READY",
      raw_first_name: null,
      raw_last_name: null,
      exception_count: 1,
      audit_count: 1,
    },
  );

  const incomplete = structuredClone(automaticException);
  incomplete.externalOrderId = "ebay-order-incomplete-identity-exception";
  incomplete.externalCustomerId = "ebay-customer-incomplete-identity-exception";
  incomplete.updatedAt = "2026-08-24T12:00:00Z";
  delete incomplete.customer.billingAddress.city;
  await orders.importOrders([incomplete], {
    type: "SYSTEM",
    requestId: "test-ebay-incomplete-identity-exception",
  });
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT customers.review_required, billing_cases.status,
                (SELECT count(*)::integer FROM customer_identity_exceptions
                 WHERE external_customer_id = $1) AS exception_count
         FROM orders
         JOIN customers ON customers.id = orders.customer_id
         JOIN billing_cases ON billing_cases.id = orders.billing_case_id
         WHERE orders.external_order_id = $2`,
        [incomplete.externalCustomerId, incomplete.externalOrderId],
      )
    ).rows[0],
    { review_required: true, status: "NEEDS_REVIEW", exception_count: 0 },
  );
}
