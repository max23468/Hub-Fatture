import assert from "node:assert/strict";
import test from "node:test";

import { paymentsReconciled } from "./order-payment-reconciliation.ts";

function shopifyPayment(amount: number, method = "Bonifico Bancario") {
  return paymentsReconciled({
    provider: "SHOPIFY",
    grossAmount: 10_000,
    payments: [{ method, status: "PAID" }],
    paymentAmounts: [amount],
  });
}

test("riconcilia soltanto l'arrotondamento positivo dei bonifici entro due centesimi", () => {
  assert.equal(shopifyPayment(10_000), true);
  assert.equal(shopifyPayment(10_001), true);
  assert.equal(shopifyPayment(10_002), true);
  assert.equal(shopifyPayment(10_003), false);
  assert.equal(shopifyPayment(9_998), false);
  assert.equal(shopifyPayment(10_002, "shopify_payments"), false);
});

test("mantiene autorevole lo stato del pagamento eBay", () => {
  assert.equal(
    paymentsReconciled({
      provider: "EBAY",
      grossAmount: 10_000,
      payments: [{ method: "eBay", status: "PAID" }],
      paymentAmounts: [8_500],
    }),
    true,
  );
});
