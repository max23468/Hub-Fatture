import assert from "node:assert/strict";
import test from "node:test";

import {
  inferredInvoicePaymentMethod,
  paymentsReconciled,
} from "./order-payment-reconciliation.ts";

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

test("propone MP05 per il bonifico Shopify confermato manualmente", () => {
  assert.equal(
    inferredInvoicePaymentMethod([
      {
        provider: "SHOPIFY",
        payments: [
          { method: "Bonifico Bancario", status: "PENDING", amount: 2664 },
          { method: "manual", status: "PAID", amount: 2664 },
        ],
      },
    ]),
    "MP05",
  );
  assert.equal(
    inferredInvoicePaymentMethod([
      {
        provider: "SHOPIFY",
        payments: [{ method: "Bonifico bancario", status: "PAID", amount: 4596 }],
      },
    ]),
    "MP05",
  );
});

test("non deduce il bonifico da conferme manuali ambigue o preparazioni miste", () => {
  const bankTransfer = {
    provider: "SHOPIFY" as const,
    payments: [
      { method: "Bonifico Bancario", status: "PENDING", amount: 2664 },
      { method: "manual", status: "PAID", amount: 2664 },
    ],
  };
  assert.equal(
    inferredInvoicePaymentMethod([
      {
        provider: "SHOPIFY",
        payments: [{ method: "manual", status: "PAID", amount: 2664 }],
      },
    ]),
    null,
  );
  assert.equal(
    inferredInvoicePaymentMethod([
      {
        provider: "SHOPIFY",
        payments: [
          { method: "Bonifico Bancario", status: "PENDING", amount: 2664 },
          { method: "manual", status: "PAID", amount: 2500 },
        ],
      },
    ]),
    null,
  );
  assert.equal(
    inferredInvoicePaymentMethod([
      bankTransfer,
      {
        provider: "SHOPIFY",
        payments: [{ method: "shopify_payments", status: "PAID", amount: 5000 }],
      },
    ]),
    null,
  );
  assert.equal(
    inferredInvoicePaymentMethod([
      {
        ...bankTransfer,
        payments: [
          ...bankTransfer.payments,
          { method: "shopify_payments", status: "PENDING", amount: 2664 },
        ],
      },
    ]),
    null,
  );
  assert.equal(
    inferredInvoicePaymentMethod([
      bankTransfer,
      {
        provider: "EBAY",
        payments: [{ method: "Bonifico bancario", status: "PAID", amount: 5000 }],
      },
    ]),
    null,
  );
});
