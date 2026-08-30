import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runMigrations } from "./migrations.server.ts";
import { temporaryDatabase } from "./database-fixture.ts";

test("un rimborso pre-emissione oltre il netto Shopify Payments blocca l’approvazione", async () => {
  const databaseFixture = await temporaryDatabase("shopify_fee_refund_review");
  try {
    await runMigrations({ connectionString: databaseFixture.connectionString });
    process.env.APP_ENV = "test";
    process.env.APP_BASE_URL = "http://localhost:8080";
    process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
    process.env.DATABASE_URL = databaseFixture.connectionString;
    const orders = await import("./order-import.server.ts");
    const database = await import("./client.server.ts");
    const order = JSON.parse(
      await readFile("tests/fixtures/orders/normalized.mock.json", "utf8"),
    )[0];
    Object.assign(order, {
      externalOrderId: "shop-order-fee-refund-review",
      externalCustomerId: "shop-customer-fee-refund-review",
      displayNumber: "#FEE-REFUND-REVIEW",
      createdAt: "2026-08-20T08:00:00Z",
      updatedAt: "2026-08-20T09:00:00Z",
      refunds: [
        {
          externalRefundId: "shop-refund-fee-review",
          status: "COMPLETED",
          amount: "120.00",
          completedAt: "2026-08-20T09:00:00Z",
          raw: {},
        },
      ],
    });
    Object.assign(order.payments[0], {
      externalPaymentId: "shop-payment-fee-refund-review",
      method: "shopify_payments",
      shopifyPaymentsFeeAmount: "5.00",
      paidAt: "2026-08-20T09:00:00Z",
    });
    order.customer.taxIdentifiers[0].value = "RSSMRA80A01H501Z";

    await orders.importOrders([order], { id: 1, requestId: "test-fee-refund-review" });

    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT billing_cases.status,
                  (orders.normalized_snapshot_json ->> 'orderReviewRequired')::boolean
                    AS order_review_required,
                  orders.billable_amount,
                  document_orders.amount AS draft_amount
           FROM orders
           JOIN billing_cases ON billing_cases.id = orders.billing_case_id
           LEFT JOIN document_orders ON document_orders.order_id = orders.id
             AND document_orders.document_kind = 'INVOICE'
           WHERE orders.external_order_id = $1`,
          [order.externalOrderId],
        )
      ).rows[0],
      {
        status: "NEEDS_REVIEW",
        order_review_required: true,
        billable_amount: 11_700,
        draft_amount: null,
      },
    );
    await database.closePool();
  } finally {
    await import("./client.server.ts").then(({ closePool }) => closePool());
    await databaseFixture.drop();
  }
});
