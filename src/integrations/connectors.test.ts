import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AppError } from "../errors.ts";
import { decimalToCents, orderReviewRequired } from "../orders.ts";
import {
  EBAY_SCOPE,
  ebayAccountReference,
  ebayFulfillmentHeaders,
  ebayListingMarketplaceId,
  ebayNextUrl,
  mapEbayOrder,
  parseEbaySyncContinuation,
} from "./ebay.server.ts";
import {
  SHOPIFY_API_SUPPORTED_UNTIL,
  SHOPIFY_API_VERSION,
  mapShopifyOrder,
  parseShopifySyncContinuation,
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
    shopifyUpdatedAtQuery("2026-08-09T12:34:56.000Z", "2026-08-10T12:34:56.000Z"),
    "updated_at:>='2026-08-09T12:34:56.000Z' updated_at:<='2026-08-10T12:34:56.000Z'",
  );
  assert.deepEqual(
    parseShopifySyncContinuation(
      '{"kind":"SHOPIFY_ORDERS_PAGE","end":"2026-08-10T12:34:56.000Z","after":"cursor"}',
    ),
    { kind: "SHOPIFY_ORDERS_PAGE", end: "2026-08-10T12:34:56.000Z", after: "cursor" },
  );
  assert.equal(parseShopifySyncContinuation("2026-08-10T12:34:56.000Z"), null);
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
  assert.equal(privateMapped.payments[0]?.shopifyPaymentsFeeAmount, "2.57");
  assert.equal(privateMapped.localizedFields[0]?.title, "Codice Fiscale (optional)");
  assert.equal(privateMapped.localizedFields[1]?.key, "TAX_EMAIL_IT");
  assert.deepEqual(privateMapped.sourceSnapshot, privateOrder);
  assert.equal(businessMapped.customer.taxIdentifiers[0]?.type, "PARTITA_IVA");
  assert.equal(
    businessMapped.customer.taxIdentifiers[0]?.sourceField,
    "customer.taxSettings.taxId",
  );
  assert.equal(businessMapped.paymentStatus, "PAID");
  assert.equal(businessMapped.payments[0]?.shopifyPaymentsFeeAmount, "0.00");
  assert.deepEqual(businessMapped.refunds[0], {
    externalRefundId: "gid://shopify/Refund/5002",
    status: "COMPLETED",
    amount: "50.00",
    completedAt: "2026-08-02T10:00:00Z",
    raw: (businessOrder as { refunds: unknown[] }).refunds[0],
  });
  assert.equal(
    orderReviewRequired(businessMapped, true, decimalToCents(businessMapped.total)),
    false,
  );
});

test("Shopify non interpreta il segnaposto privato come ragione sociale", async () => {
  const [payload] = await fixture("shopify-orders.json");
  const placeholder = structuredClone(payload) as {
    billingAddress: { company: string | null };
  };
  placeholder.billingAddress.company = "  PRIVATO  ";

  const mapped = mapShopifyOrder(placeholder, "shop.example.invalid");

  assert.equal(mapped.customer.kind, "PRIVATE_IT");
  assert.equal(mapped.customer.companyName, undefined);
  assert.equal(
    (mapped.sourceSnapshot.billingAddress as { company: string }).company,
    "  PRIVATO  ",
  );

  placeholder.billingAddress.company = "Privato Design SRL";
  const realCompany = mapShopifyOrder(placeholder, "shop.example.invalid");
  assert.equal(realCompany.customer.kind, "BUSINESS_IT");
  assert.equal(realCompany.customer.companyName, "Privato Design SRL");
});

test("Shopify usa Interno come ultimo fallback soltanto per un identificativo italiano valido", async () => {
  const [payload] = await fixture("shopify-orders.json");
  type ShopifyTaxPayload = Record<string, unknown> & {
    localizedFields: { nodes: unknown[] };
    customer: { taxSettings: { taxId: string | null } };
    billingAddress: { address2: string | null; countryCodeV2: string; company?: string | null };
    shippingAddress: {
      address1: string;
      address2: string | null;
      company?: string | null;
      zip: string;
      city: string;
      provinceCode: string;
      countryCodeV2: string;
    };
  };
  const fallback = structuredClone(payload) as ShopifyTaxPayload;
  fallback.localizedFields.nodes = [];
  fallback.customer.taxSettings.taxId = null;
  fallback.billingAddress.address2 = "C.F. RSSMRA80A01H501U";
  const fiscalCodeFallback = mapShopifyOrder(fallback, "shop.example.invalid");
  assert.deepEqual(fiscalCodeFallback.customer.taxIdentifiers, [
    {
      type: "CODICE_FISCALE",
      value: "RSSMRA80A01H501U",
      countryCode: "IT",
      sourceField: "billingAddress.address2",
    },
  ]);
  assert.equal(fiscalCodeFallback.customer.billingAddress.line2, undefined);

  fallback.billingAddress.address2 = "Scala A · P. IVA IT12345678903";
  const vatFallback = mapShopifyOrder(fallback, "shop.example.invalid");
  assert.equal(vatFallback.customer.taxIdentifiers[0]?.type, "PARTITA_IVA");
  assert.equal(vatFallback.customer.billingAddress.line2, "Scala A");
  fallback.billingAddress.address2 = "Riferimento interno 12345678901";
  const invalidVatFallback = mapShopifyOrder(fallback, "shop.example.invalid");
  assert.equal(invalidVatFallback.customer.taxIdentifiers.length, 0);
  assert.equal(invalidVatFallback.customer.billingAddress.line2, "Riferimento interno 12345678901");
  fallback.billingAddress.address2 = "C.F. VRDLGI80A01H501Z";
  const invalidFiscalCodeFallback = mapShopifyOrder(fallback, "shop.example.invalid");
  assert.equal(invalidFiscalCodeFallback.customer.taxIdentifiers.length, 0);
  assert.equal(invalidFiscalCodeFallback.customer.billingAddress.line2, "C.F. VRDLGI80A01H501Z");
  fallback.billingAddress.address2 = "Scala A, interno 12";
  assert.equal(mapShopifyOrder(fallback, "shop.example.invalid").customer.taxIdentifiers.length, 0);
  fallback.billingAddress.address2 = "RSSMRA80A01H501U · 12345678901";
  assert.equal(mapShopifyOrder(fallback, "shop.example.invalid").customer.taxIdentifiers.length, 0);
  fallback.billingAddress.address2 = "RSSMRA80A01H501U";
  fallback.billingAddress.countryCodeV2 = "ES";
  assert.equal(mapShopifyOrder(fallback, "shop.example.invalid").customer.taxIdentifiers.length, 0);
  fallback.billingAddress.countryCodeV2 = "IT";
  fallback.billingAddress.address2 = "RSSMRA80A01H501U";
  fallback.customer.taxSettings.taxId = "IT10987654321";
  assert.equal(
    mapShopifyOrder(fallback, "shop.example.invalid").customer.taxIdentifiers[0]?.sourceField,
    "customer.taxSettings.taxId",
  );
  fallback.customer.taxSettings.taxId = null;
  fallback.localizedFields.nodes = [
    {
      key: "TAX_CREDENTIAL_IT",
      countryCode: "IT",
      purpose: "TAX",
      value: "VRDLGI80A01H501Z",
    },
  ];
  assert.equal(
    mapShopifyOrder(fallback, "shop.example.invalid").customer.taxIdentifiers[0]?.sourceField,
    "localizedFields:TAX_CREDENTIAL_IT:TAX",
  );

  fallback.localizedFields.nodes = [];
  fallback.billingAddress.address2 = null;
  fallback.shippingAddress.address2 = "RSSMRA80A01H501U";
  fallback.billingAddress = {
    ...fallback.billingAddress,
    address1: "Via Esempio",
    zip: "00100",
    city: "Roma",
    provinceCode: "RM",
  } as ShopifyTaxPayload["billingAddress"];
  fallback.shippingAddress = {
    ...fallback.shippingAddress,
    address1: "Via Esempio 112",
    zip: "00100",
    city: "Roma",
    provinceCode: "RM",
    countryCodeV2: "IT",
  };
  const shippingFallback = mapShopifyOrder(fallback, "shop.example.invalid");
  assert.deepEqual(shippingFallback.customer.taxIdentifiers, [
    {
      type: "CODICE_FISCALE",
      value: "RSSMRA80A01H501U",
      countryCode: "IT",
      sourceField: "shippingAddress.address2",
    },
  ]);
  assert.equal(shippingFallback.customer.billingAddress.line1, "Via Esempio 112");
  assert.equal(shippingFallback.customer.shippingAddress.line2, undefined);

  fallback.shippingAddress.city = "Milano";
  assert.equal(
    mapShopifyOrder(fallback, "shop.example.invalid").customer.billingAddress.line1,
    "Via Esempio",
  );
  assert.equal(mapShopifyOrder(fallback, "shop.example.invalid").customer.taxIdentifiers.length, 0);
  assert.equal(
    mapShopifyOrder(fallback, "shop.example.invalid").customer.shippingAddress.line2,
    "RSSMRA80A01H501U",
  );

  fallback.shippingAddress.city = "Roma";
  fallback.billingAddress.company = "Azienda Fatturazione SRL";
  fallback.shippingAddress.company = "Azienda Consegna SRL";
  const differentCompany = mapShopifyOrder(fallback, "shop.example.invalid");
  assert.equal(differentCompany.customer.billingAddress.line1, "Via Esempio");
  assert.equal(differentCompany.customer.taxIdentifiers.length, 0);
  assert.equal(differentCompany.customer.shippingAddress.line2, "RSSMRA80A01H501U");
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

  const duplicatedLineRefund = structuredClone(refundedOrder) as {
    lineItems: Array<{ refunds: unknown[] }>;
  };
  duplicatedLineRefund.lineItems[0].refunds = [{ refundStatus: "REFUNDED" }];
  assert.equal(mapEbayOrder(duplicatedLineRefund, "botCF").refunds.length, 2);

  const lineRefundFallback = structuredClone(refundedOrder) as {
    paymentSummary: { refunds: unknown[] };
    lineItems: Array<{ refunds: unknown[] }>;
  };
  lineRefundFallback.paymentSummary.refunds = [];
  lineRefundFallback.lineItems[0].refunds = [
    { refundId: "line-refund-fallback", refundStatus: "REFUNDED" },
  ];
  assert.equal(
    mapEbayOrder(lineRefundFallback, "botCF").refunds[0]?.externalRefundId,
    "line-refund-fallback",
  );

  const distinctLineRefund = structuredClone(refundedOrder) as {
    lineItems: Array<{ refunds: unknown[] }>;
  };
  distinctLineRefund.lineItems[0].refunds = [
    { refundId: "line-refund-distinct", refundStatus: "REFUNDED" },
  ];
  assert.deepEqual(
    mapEbayOrder(distinctLineRefund, "botCF").refunds.map(
      ({ externalRefundId }) => externalRefundId,
    ),
    ["refund-2", "refund-reference-3", "line-refund-distinct"],
  );
  const summary = {
    lineItems: [
      { listingMarketplaceId: "EBAY_IT", purchaseMarketplaceId: "EBAY_IE" },
      { listingMarketplaceId: "EBAY_IT", purchaseMarketplaceId: "EBAY_US" },
    ],
  };
  assert.equal(ebayListingMarketplaceId(summary), "EBAY_IT");
  assert.deepEqual(ebayFulfillmentHeaders("token-sintetico", "EBAY_IT"), {
    Authorization: "Bearer token-sintetico",
    Accept: "application/json",
    "X-EBAY-C-MARKETPLACE-ID": "EBAY_IT",
  });
  assert.throws(
    () => ebayListingMarketplaceId({ lineItems: [{ listingMarketplaceId: "valore\r\ninvalido" }] }),
    (error) => error instanceof AppError && error.code === "PROVIDER_RESPONSE_INVALID",
  );
  assert.throws(
    () =>
      ebayListingMarketplaceId({
        lineItems: [{ listingMarketplaceId: "EBAY_IT" }, { listingMarketplaceId: "EBAY_ES" }],
      }),
    (error) => error instanceof AppError && error.code === "PROVIDER_RESPONSE_INVALID",
  );
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
  assert.deepEqual(
    parseEbaySyncContinuation(
      '{"kind":"EBAY_ORDERS_PAGE","end":"2026-08-10T12:34:56.000Z","next":"/sell/fulfillment/v1/order?offset=1000"}',
    ),
    {
      kind: "EBAY_ORDERS_PAGE",
      end: "2026-08-10T12:34:56.000Z",
      next: "/sell/fulfillment/v1/order?offset=1000",
    },
  );
  assert.equal(parseEbaySyncContinuation("2026-08-10T12:34:56.000Z"), null);
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
  assert.equal(orderReviewRequired(pendingMapped, true, decimalToCents(pendingMapped.total)), true);

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

test("Shopify Payments importa solo la fee effettiva e fallisce chiuso sui dati incoerenti", async () => {
  const [payload] = await fixture("shopify-orders.json");
  type ShopifyFeePayload = Record<string, unknown> & {
    transactions: Array<{
      gateway: string;
      fees: Array<{ amount: { currencyCode: string } }>;
    }>;
  };
  const wrongCurrency = structuredClone(payload) as ShopifyFeePayload;
  wrongCurrency.transactions[0].fees[0].amount.currencyCode = "USD";
  assert.throws(
    () => mapShopifyOrder(wrongCurrency, "shop.example.invalid"),
    (error) => error instanceof AppError && error.code === "PROVIDER_RESPONSE_INVALID",
  );

  const missingFee = structuredClone(payload) as ShopifyFeePayload;
  missingFee.transactions[0].fees = [];
  assert.throws(
    () => mapShopifyOrder(missingFee, "shop.example.invalid"),
    (error) => error instanceof AppError && error.code === "PROVIDER_RESPONSE_INVALID",
  );

  const paypal = structuredClone(payload) as ShopifyFeePayload;
  paypal.transactions[0].gateway = "paypal";
  assert.equal(
    mapShopifyOrder(paypal, "shop.example.invalid").payments[0]?.shopifyPaymentsFeeAmount,
    "0.00",
  );
});
