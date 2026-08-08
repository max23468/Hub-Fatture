import assert from "node:assert/strict";
import test from "node:test";

import {
  customerIdentity,
  decimalToCents,
  localOrderDate,
  orderInputSchema,
  triggerStatus,
} from "./orders.ts";

const base = orderInputSchema.parse({
  provider: "SHOPIFY",
  externalAccountId: "shop.example.invalid",
  externalOrderId: "order-1",
  externalCustomerId: "customer-1",
  displayNumber: "#1001",
  createdAt: "2026-03-29T22:30:00Z",
  updatedAt: "2026-03-29T22:30:00Z",
  currency: "EUR",
  total: "122.00",
  paymentStatus: "PAID",
  fulfillmentStatus: "UNFULFILLED",
  customer: {
    kind: "PRIVATE_IT",
    displayName: "Mario Rossi",
    firstName: "Mario",
    lastName: "Rossi",
    email: "mario@example.invalid",
    billingAddress: {
      line1: "Via Roma 1",
      postalCode: "20100",
      city: "Milano",
      countryCode: "IT",
    },
    taxIdentifiers: [
      { type: "CODICE_FISCALE", value: "RSSMRA80A01H501U", sourceField: "localizedFields" },
    ],
  },
  lines: [
    {
      externalLineId: "line-1",
      description: "Oggetto sintetico",
      quantity: 1,
      grossAmount: "122.00",
    },
  ],
  payments: [],
});

test("normalizza denaro, data, identità e trigger senza inferenze fiscali", () => {
  assert.equal(decimalToCents("12.30"), 1230);
  assert.equal(decimalToCents("-0.50"), -50);
  assert.equal(decimalToCents("1.2300"), 123);
  assert.throws(() => decimalToCents("1.231"));
  assert.throws(() => decimalToCents("21474836.48"));
  assert.equal(localOrderDate(base.createdAt), "2026-03-30");
  assert.deepEqual(customerIdentity(base), {
    matchKey: "tax:CODICE_FISCALE::RSSMRA80A01H501U",
    confidence: "TAX_ID",
    reviewRequired: false,
    primaryTaxId: { type: "CODICE_FISCALE", value: "RSSMRA80A01H501U", countryCode: undefined },
  });
  assert.equal(triggerStatus(base, "PAID"), "ELIGIBLE");
  assert.equal(triggerStatus(base, "FULFILLED"), "WAITING_FOR_TRIGGER");
  assert.equal(
    triggerStatus(
      { ...base, paymentStatus: "REFUNDED", fulfillmentStatus: "FULFILLED" },
      "FULFILLED",
    ),
    "REFUNDED_BEFORE_ISSUE",
  );
  assert.equal(
    triggerStatus({ ...base, cancelledAt: "2026-03-30T10:00:00Z" }, "PAID"),
    "CANCELLED_NO_DOCUMENT",
  );

  const invalidTaxId = {
    ...base,
    customer: {
      ...base.customer,
      taxIdentifiers: [
        { type: "CODICE_FISCALE" as const, value: "incompleto", sourceField: "fixture" },
      ],
    },
  };
  assert.equal(customerIdentity(invalidTaxId).confidence, "EXACT_PROFILE");
  assert.equal(customerIdentity(invalidTaxId).reviewRequired, true);

  const missingAddress = orderInputSchema.parse({
    ...base,
    customer: { ...base.customer, billingAddress: undefined },
  });
  assert.deepEqual(missingAddress.customer.billingAddress, {});
  assert.equal(customerIdentity(missingAddress).confidence, "TAX_ID");
  assert.equal(customerIdentity(missingAddress).reviewRequired, true);

  const missingName = orderInputSchema.parse({
    ...base,
    customer: { ...base.customer, displayName: undefined, firstName: undefined },
  });
  assert.equal(customerIdentity(missingName).reviewRequired, true);

  const canonicalCountry = orderInputSchema.parse({
    ...base,
    externalCustomerId: undefined,
    customer: {
      ...base.customer,
      kind: "EU",
      taxIdentifiers: [
        {
          type: "ALTRO",
          value: "DE123456789",
          countryCode: "de",
          sourceField: "fixture",
        },
      ],
    },
  });
  assert.equal(canonicalCountry.externalCustomerId, undefined);
  assert.equal(canonicalCountry.customer.taxIdentifiers[0]?.countryCode, "DE");

  const reordered = {
    ...base,
    customer: {
      ...base.customer,
      taxIdentifiers: [
        { type: "PARTITA_IVA" as const, value: "12345678901", sourceField: "fixture" },
        ...base.customer.taxIdentifiers,
      ],
    },
  };
  assert.match(customerIdentity(reordered).matchKey, /^tax:CODICE_FISCALE:/);

  const businessWithOnlyTaxCode = {
    ...base,
    customer: { ...base.customer, kind: "BUSINESS_IT" as const },
  };
  assert.equal(customerIdentity(businessWithOnlyTaxCode).reviewRequired, true);
  const businessWithVat = {
    ...businessWithOnlyTaxCode,
    customer: {
      ...businessWithOnlyTaxCode.customer,
      taxIdentifiers: [
        { type: "PARTITA_IVA" as const, value: "12345678901", sourceField: "fixture" },
      ],
    },
  };
  assert.equal(customerIdentity(businessWithVat).reviewRequired, false);
  assert.equal(customerIdentity(businessWithVat).matchKey, "tax:PARTITA_IVA::12345678901");
  assert.equal(
    customerIdentity({
      ...businessWithVat,
      customer: {
        ...businessWithVat.customer,
        taxIdentifiers: [
          {
            type: "PARTITA_IVA" as const,
            value: "12345678901",
            countryCode: "IT",
            sourceField: "fixture",
          },
        ],
      },
    }).matchKey,
    "tax:PARTITA_IVA::12345678901",
  );

  const unknown = {
    ...base,
    customer: { ...base.customer, kind: "UNKNOWN" as const },
  };
  assert.equal(customerIdentity(unknown).reviewRequired, true);

  const foreignTaxId = {
    ...base,
    customer: {
      ...base.customer,
      kind: "EU" as const,
      billingAddress: { ...base.customer.billingAddress, countryCode: "FR" },
      taxIdentifiers: [{ type: "ALTRO" as const, value: "12345", sourceField: "fixture" }],
    },
  };
  assert.equal(customerIdentity(foreignTaxId).matchKey, "tax:ALTRO:FR:12345");
  const foreignProfileWithoutDisplayName = {
    ...foreignTaxId,
    customer: {
      ...foreignTaxId.customer,
      displayName: undefined,
      taxIdentifiers: [],
      companyName: "Entreprise Exemple",
    },
  };
  assert.equal(customerIdentity(foreignProfileWithoutDisplayName).confidence, "EXACT_PROFILE");
  assert.equal(customerIdentity(foreignProfileWithoutDisplayName).reviewRequired, false);
  assert.equal(
    customerIdentity({
      ...foreignTaxId,
      customer: {
        ...foreignTaxId.customer,
        billingAddress: { ...foreignTaxId.customer.billingAddress, countryCode: undefined },
      },
    }).confidence,
    "AMBIGUOUS",
  );
});
