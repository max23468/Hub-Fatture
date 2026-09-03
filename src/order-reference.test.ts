import assert from "node:assert/strict";
import test from "node:test";

import { orderReferenceLabel, salesChannelLabel } from "./order-reference.ts";

test("il riferimento ordine mostra prima il numero e poi il canale", () => {
  assert.equal(orderReferenceLabel("SHOPIFY", "#4064"), "#4064 Shopify");
  assert.equal(orderReferenceLabel("EBAY", "12-34567-89012"), "12-34567-89012 eBay");
  assert.equal(salesChannelLabel("UNKNOWN"), "Canale");
});
