import assert from "node:assert/strict";
import test from "node:test";

import {
  isEbayCustomerEmailOnlyMismatch,
  isEbayEmailAndMapperOnlyChange,
  isEbayEmailOnlyChange,
  isShopifyFulfillmentOnlyChange,
} from "./order-source-alignment.ts";

function snapshot(email: string, total = 1_000) {
  return {
    provider: "EBAY",
    totalAmount: total,
    customer: { displayName: "Mario Rossi", email },
    customerSnapshot: {
      displayName: "Mario Rossi",
      email,
      canonicalProfile: {
        displayName: "mario rossi",
        email,
        taxIdentifiers: [{ type: "CODICE_FISCALE", value: "RSSMRA80A01H501U" }],
      },
    },
    sourceSnapshot: {
      fulfillmentStartInstructions: [{ shippingStep: { shipTo: { email } } }],
    },
    reviewFingerprint: email,
  };
}

test("riconosce come sicura soltanto una variazione dell'e-mail eBay", () => {
  assert.equal(
    isEbayEmailOnlyChange(snapshot("prima@example.invalid"), {
      ...snapshot("dopo@example.invalid"),
      optionalProviderField: undefined,
    }),
    true,
  );
  assert.equal(
    isEbayEmailOnlyChange(
      snapshot("prima@example.invalid"),
      snapshot("dopo@example.invalid", 1_001),
    ),
    false,
  );
  assert.equal(
    isEbayEmailOnlyChange(
      { ...snapshot("prima@example.invalid"), provider: "SHOPIFY" },
      { ...snapshot("dopo@example.invalid"), provider: "SHOPIFY" },
    ),
    false,
  );
});

test("riconosce un replay eBay che cambia solo e-mail e interpretazione del mapper", () => {
  const previous = {
    ...snapshot("prima@example.invalid"),
    customerReviewRequired: false,
    customerIdentity: "EXACT_PROFILE",
    sourceSnapshot: { buyer: { version: "prima" } },
  };
  const current = {
    ...snapshot("dopo@example.invalid"),
    customerReviewRequired: true,
    customerIdentity: "TAX_ID",
    sourceSnapshot: { buyer: { version: "dopo" } },
  };

  assert.equal(isEbayEmailOnlyChange(previous, current), false);
  assert.equal(isEbayEmailAndMapperOnlyChange(previous, current), true);
  assert.equal(isEbayEmailAndMapperOnlyChange(previous, { ...current, totalAmount: 1_001 }), false);
});

test("riconosce una preparazione eBay rimasta indietro soltanto sull’e-mail", () => {
  const previous = snapshot("prima@example.invalid").customerSnapshot;
  const current = snapshot("dopo@example.invalid").customerSnapshot;
  assert.equal(isEbayCustomerEmailOnlyMismatch(previous, current), true);
  assert.equal(
    isEbayCustomerEmailOnlyMismatch(
      {
        ...previous,
        email: undefined,
        canonicalProfile: { ...previous.canonicalProfile, email: null },
      },
      {
        ...previous,
        email: undefined,
        canonicalProfile: { ...previous.canonicalProfile, email: undefined },
      },
    ),
    true,
  );
  assert.equal(
    isEbayCustomerEmailOnlyMismatch(previous, {
      ...current,
      displayName: "Mario Bianchi",
    }),
    false,
  );
});

test("l'avanzamento dell'evasione Shopify non è un conflitto fiscale", () => {
  const previous = {
    provider: "SHOPIFY",
    fulfillmentStatus: "UNFULFILLED",
    paymentStatus: "PAID",
    totalAmount: 10_00,
    customerSnapshot: { displayName: "Mario Rossi", email: undefined },
    updatedAt: "2026-08-17T14:57:48Z",
    sourceSnapshot: { displayFulfillmentStatus: "UNFULFILLED" },
    reviewFingerprint: "prima",
    sourceConflictRequired: false,
  };
  const current = {
    ...previous,
    fulfillmentStatus: "FULFILLED",
    updatedAt: "2026-09-01T13:28:25Z",
    customerSnapshot: { displayName: "Mario Rossi" },
    sourceSnapshot: { displayFulfillmentStatus: "FULFILLED", transactions: [{ enriched: true }] },
    reviewFingerprint: "dopo",
  };
  assert.equal(isShopifyFulfillmentOnlyChange(previous, current), true);
  assert.equal(isShopifyFulfillmentOnlyChange(previous, { ...current, totalAmount: 10_01 }), false);
  assert.equal(isShopifyFulfillmentOnlyChange(current, previous), false);
  assert.equal(
    isShopifyFulfillmentOnlyChange(
      { ...previous, provider: "EBAY" },
      { ...current, provider: "EBAY" },
    ),
    false,
  );
});
