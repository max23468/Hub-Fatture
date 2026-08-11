import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AppError } from "../errors.ts";
import { orderReviewRequired } from "../orders.ts";
import { EBAY_SCOPE, ebayAccountReference, ebayNextUrl, mapEbayOrder } from "./ebay.server.ts";
import {
  SHOPIFY_API_SUPPORTED_UNTIL,
  SHOPIFY_API_VERSION,
  mapShopifyOrder,
  shopifyAccountReference,
  shopifyGraphqlError,
  shopifyUpdatedAtQuery,
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
  assert.equal(
    shopifyAccountReference("Shop.Example.Invalid", "shop.example.invalid"),
    "Shop.Example.Invalid",
  );
  assert.throws(
    () => shopifyAccountReference("altro-shop.example.invalid", "shop.example.invalid"),
    (error) => error instanceof AppError && error.code === "AUTH_PROVIDER_ACCOUNT_MISMATCH",
  );
  assert.equal(
    shopifyUpdatedAtQuery("2026-08-09T12:34:56.000Z"),
    "updated_at:>='2026-08-09T12:34:56.000Z'",
  );
  assert.deepEqual(privateMapped.customer.taxIdentifiers[0], {
    type: "CODICE_FISCALE",
    value: "RSSMRA80A01H501U",
    countryCode: "IT",
    sourceField: "localizedFields:TAX_CREDENTIAL_IT:TAX",
  });
  assert.equal(privateMapped.customer.taxIdentifiers.length, 1);
  assert.equal(privateMapped.customer.email, "ordine@example.invalid");
  assert.equal(privateMapped.customer.certifiedEmail, "cliente@example.invalid");
  assert.equal(privateMapped.customer.shippingAddress.line1, "Via Consegna 2");
  assert.equal(privateMapped.localizedFields[0]?.title, "Codice Fiscale (optional)");
  assert.equal(privateMapped.localizedFields[1]?.key, "TAX_EMAIL_IT");
  assert.deepEqual(privateMapped.sourceSnapshot, privateOrder);
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
  assert.equal(orderReviewRequired(businessMapped, true), false);
});

test("il contratto eBay conserva il tipo dichiarato e blocca l'importo netto del rimborso", async () => {
  const [privateOrder, refundedOrder] = await fixture("ebay-orders.json");
  const privateMapped = mapEbayOrder(privateOrder, "botCF");
  const refundedMapped = mapEbayOrder(refundedOrder, "botCF");

  assert.equal(privateMapped.customer.taxIdentifiers[0]?.type, "CODICE_FISCALE");
  assert.equal(privateMapped.customer.shippingAddress.line1, "Via eBay 1");
  assert.deepEqual(privateMapped.sourceSnapshot, privateOrder);
  assert.equal(
    privateMapped.customer.taxIdentifiers[0]?.sourceField,
    "buyer.taxIdentifier.CODICE_FISCALE",
  );
  assert.equal(refundedMapped.customer.taxIdentifiers[0]?.type, "PARTITA_IVA");
  assert.equal(refundedMapped.refunds[0]?.externalRefundId, "refund-2");
  assert.equal(refundedMapped.refunds[1]?.externalRefundId, "refund-reference-3");
  assert.equal(refundedMapped.refunds[0]?.status, "AMBIGUOUS");
  assert.equal(refundedMapped.refunds[0]?.amount, null);
  assert.match(EBAY_SCOPE, /commerce\.identity\.readonly/);
  assert.equal(ebayAccountReference({ username: "BotCF" }, "botcf"), "BotCF");
  assert.throws(
    () => ebayAccountReference({ username: "altro-venditore" }, "botCF"),
    (error) => error instanceof AppError && error.code === "AUTH_PROVIDER_ACCOUNT_MISMATCH",
  );
  assert.equal(
    ebayNextUrl("sandbox", "/sell/fulfillment/v1/order?offset=50"),
    "https://api.sandbox.ebay.com/sell/fulfillment/v1/order?offset=50",
  );
  assert.throws(
    () => ebayNextUrl("sandbox", "https://attacker.example.invalid/steal"),
    (error) => error instanceof AppError && error.code === "PROVIDER_RESPONSE_INVALID",
  );
});

test("eBay distingue l'annullamento concluso dalla richiesta in corso", async () => {
  const [payload] = await fixture("ebay-orders.json");
  const inProgress = structuredClone(payload) as Record<string, unknown>;
  inProgress.cancelStatus = { cancelState: "IN_PROGRESS" };
  const pendingMapped = mapEbayOrder(inProgress, "botCF");
  assert.equal(pendingMapped.cancelledAt, null);
  assert.equal(orderReviewRequired(pendingMapped, true), true);

  inProgress.cancelStatus = { cancelState: "CANCELED" };
  assert.equal(mapEbayOrder(inProgress, "botCF").cancelledAt, pendingMapped.updatedAt);
});

test("gli errori GraphQL Shopify conservano la semantica di retry e autenticazione", () => {
  assert.equal(
    shopifyGraphqlError([{ extensions: { code: "THROTTLED" } }])?.code,
    "PROVIDER_RATE_LIMITED",
  );
  assert.equal(
    shopifyGraphqlError([{ extensions: { code: "ACCESS_DENIED" } }])?.code,
    "AUTH_PROVIDER_EXPIRED",
  );
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
