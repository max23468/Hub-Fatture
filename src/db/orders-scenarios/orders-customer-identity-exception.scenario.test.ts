import assert from "node:assert/strict";

import type { OrdersTestContext } from "./orders-test-support.test.ts";

export async function run(context: OrdersTestContext) {
  const { orders, database, fixture, identityExceptions } = context;
  const acceptedException = structuredClone(fixture[0]);
  acceptedException.provider = "EBAY";
  acceptedException.externalOrderId = "ebay-order-accepted-identity-exception";
  acceptedException.externalCustomerId = "ebay-customer-accepted-identity-exception";
  acceptedException.createdAt = "2026-08-24T10:00:00Z";
  acceptedException.updatedAt = "2026-08-24T11:00:00Z";
  acceptedException.sourceSnapshot = { immutableEbayPayload: "identity-exception" };
  acceptedException.customer.displayName = "Giovanni Bianchi";
  acceptedException.customer.taxIdentifiers[0].countryCode = "IT";
  delete acceptedException.customer.firstName;
  delete acceptedException.customer.lastName;

  await orders.importOrders([acceptedException], {
    id: 1,
    requestId: "test-ebay-identity-exception-before",
  });
  const exceptionCustomerId = (
    await database.getPool().query<{ id: string }>(
      `SELECT customers.id::text
       FROM customers
       JOIN orders ON orders.customer_id = customers.id
       WHERE orders.external_order_id = $1`,
      [acceptedException.externalOrderId],
    )
  ).rows[0]!.id;
  const exceptionProposal =
    await identityExceptions.getCustomerIdentityExceptionProposal(exceptionCustomerId);
  assert.ok(exceptionProposal);
  assert.match(exceptionProposal.sourceIdentitySha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    { ...exceptionProposal, sourceIdentitySha256: "sha256" },
    {
      provider: "EBAY",
      externalCustomerId: acceptedException.externalCustomerId,
      sourceIdentitySha256: "sha256",
      firstName: "Giovanni",
      lastName: "Bianchi",
      basis: "SOURCE_ORDER",
    },
  );

  const exceptionActorId = (
    await database.getPool().query<{ id: number }>(
      `INSERT INTO users (username, password_hash, can_approve)
       VALUES ('Massimo', 'synthetic-password-hash', true)
       ON CONFLICT (username) DO UPDATE SET can_approve = true
       RETURNING id`,
    )
  ).rows[0]!.id;
  const exceptionReplay = await identityExceptions.acceptCustomerIdentityException(
    exceptionCustomerId,
    {
      id: exceptionActorId,
      canApprove: true,
      requestId: "test-ebay-identity-exception-accept",
    },
  );
  assert.equal(exceptionReplay.length, 1);
  await orders.importOrders(exceptionReplay, {
    id: 1,
    requestId: "test-ebay-identity-exception-replay",
  });

  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT customers.first_name, customers.last_name, customers.review_required,
                billing_cases.status,
                orders.raw_snapshot_json #>> '{customer,firstName}' AS raw_first_name,
                orders.raw_snapshot_json #>> '{customer,lastName}' AS raw_last_name,
                (SELECT count(*)::integer FROM customer_identity_exceptions
                 WHERE external_customer_id = $1) AS exception_count,
                (SELECT count(*)::integer FROM audit_events
                 WHERE entity_type = 'CUSTOMER' AND entity_id = customers.id::text
                   AND action = 'CUSTOMER_IDENTITY_EXCEPTION_ACCEPTED') AS audit_count
         FROM orders
         JOIN customers ON customers.id = orders.customer_id
         JOIN billing_cases ON billing_cases.id = orders.billing_case_id
         WHERE orders.external_order_id = $2`,
        [acceptedException.externalCustomerId, acceptedException.externalOrderId],
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
}
