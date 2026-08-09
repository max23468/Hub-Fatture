import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AppError } from "../errors.ts";
import { mapEbayOrder } from "./ebay.server.ts";
import {
  SHOPIFY_API_SUPPORTED_UNTIL,
  SHOPIFY_API_VERSION,
  mapShopifyOrder,
} from "./shopify.server.ts";

async function fixture(name: string) {
  return JSON.parse(
    await readFile(new URL(`../../tests/fixtures/connectors/${name}`, import.meta.url), "utf8"),
  ) as unknown[];
}

test("il contratto Shopify usa una versione fissa e mappa ordine, fallback fiscale e rimborso", async () => {
  const [privateOrder, businessOrder] = await fixture("shopify-orders.json");
  const privateMapped = mapShopifyOrder(privateOrder, "shop.example.invalid");
  const businessMapped = mapShopifyOrder(businessOrder, "shop.example.invalid");

  assert.equal(SHOPIFY_API_VERSION, "2026-07");
  assert.equal(SHOPIFY_API_SUPPORTED_UNTIL, "2027-07-16");
  assert.deepEqual(privateMapped.customer.taxIdentifiers[0], {
    type: "CODICE_FISCALE",
    value: "RSSMRA80A01H501U",
    countryCode: "IT",
    sourceField: "localizedFields:TAX_ID:FISCAL_ID",
  });
  assert.equal(businessMapped.customer.taxIdentifiers[0]?.type, "PARTITA_IVA");
  assert.equal(
    businessMapped.customer.taxIdentifiers[0]?.sourceField,
    "customer.taxSettings.taxId",
  );
  assert.equal(businessMapped.paymentStatus, "PAID");
  assert.deepEqual(businessMapped.refunds[0], {
    externalRefundId: "gid://shopify/Refund/5002",
    status: "COMPLETED",
    amount: "50.00",
    completedAt: "2026-08-02T10:00:00Z",
    raw: (businessOrder as { refunds: unknown[] }).refunds[0],
  });
});

test("il contratto eBay conserva il tipo dichiarato e blocca l'importo netto del rimborso", async () => {
  const [privateOrder, refundedOrder] = await fixture("ebay-orders.json");
  const privateMapped = mapEbayOrder(privateOrder, "botCF");
  const refundedMapped = mapEbayOrder(refundedOrder, "botCF");

  assert.equal(privateMapped.customer.taxIdentifiers[0]?.type, "CODICE_FISCALE");
  assert.equal(
    privateMapped.customer.taxIdentifiers[0]?.sourceField,
    "buyer.taxIdentifier.CODICE_FISCALE",
  );
  assert.equal(refundedMapped.customer.taxIdentifiers[0]?.type, "PARTITA_IVA");
  assert.equal(refundedMapped.refunds[0]?.status, "AMBIGUOUS");
  assert.equal(refundedMapped.refunds[0]?.amount, null);
});

test("uno schema provider inatteso non diventa un errore generico", async () => {
  const [payload] = await fixture("shopify-orders.json");
  const malformed = structuredClone(payload) as Record<string, unknown>;
  malformed.lineItems = { nodes: [] };
  assert.throws(
    () => mapShopifyOrder(malformed, "shop.example.invalid"),
    (error) => error instanceof AppError && error.code === "PROVIDER_RESPONSE_INVALID",
  );
});
