import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalTaxIdentifiers,
  customerDisplayName,
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
  const duplicateCollections = orderInputSchema.safeParse({
    ...base,
    lines: [base.lines[0], base.lines[0]],
    payments: [
      {
        externalPaymentId: "payment-1",
        method: "CARD",
        status: "PAID",
        amount: "122.00",
      },
      {
        externalPaymentId: "payment-1",
        method: "CARD",
        status: "PAID",
        amount: "122.00",
      },
    ],
  });
  assert.equal(duplicateCollections.success, false);
  if (!duplicateCollections.success) {
    assert.deepEqual(
      [...new Set(duplicateCollections.error.issues.map((issue) => issue.path[0]))].sort(),
      ["lines", "payments"],
    );
  }
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
  assert.equal(
    orderInputSchema.safeParse({
      ...base,
      customer: {
        ...base.customer,
        billingAddress: { ...base.customer.billingAddress, countryCode: "12" },
      },
    }).success,
    false,
  );

  const euVatGermany = orderInputSchema.parse({
    ...base,
    customer: {
      ...base.customer,
      kind: "EU",
      billingAddress: { ...base.customer.billingAddress, countryCode: "DE" },
      taxIdentifiers: [
        { type: "PARTITA_IVA", value: "DE123456789", countryCode: "DE", sourceField: "fixture" },
      ],
    },
  });
  const euVatFrance = orderInputSchema.parse({
    ...euVatGermany,
    customer: {
      ...euVatGermany.customer,
      billingAddress: { ...euVatGermany.customer.billingAddress, countryCode: "FR" },
      taxIdentifiers: [
        { type: "PARTITA_IVA", value: "12345678901", countryCode: "FR", sourceField: "fixture" },
      ],
    },
  });
  assert.equal(customerIdentity(euVatGermany).matchKey, "tax:PARTITA_IVA:DE:123456789");
  const contradictoryEuVat = customerIdentity({
    ...euVatFrance,
    customer: {
      ...euVatFrance.customer,
      taxIdentifiers: [
        { type: "PARTITA_IVA", value: "IT12345678901", countryCode: "FR", sourceField: "fixture" },
      ],
    },
  });
  assert.equal(contradictoryEuVat.matchKey, "tax:PARTITA_IVA:FR:IT12345678901");
  assert.notEqual(contradictoryEuVat.matchKey, customerIdentity(euVatFrance).matchKey);
  assert.equal(
    canonicalTaxIdentifiers({
      ...euVatGermany,
      customer: {
        ...euVatGermany.customer,
        taxIdentifiers: [
          ...euVatGermany.customer.taxIdentifiers,
          { type: "PARTITA_IVA", value: "123456789", countryCode: "DE", sourceField: "tax-id" },
        ],
      },
    }).length,
    1,
  );
  const duplicateTaxIdentifiers = [
    { type: "PARTITA_IVA" as const, value: "DE123456789", countryCode: "DE", sourceField: "z" },
    { type: "PARTITA_IVA" as const, value: "123456789", countryCode: "DE", sourceField: "a" },
  ];
  assert.deepEqual(
    canonicalTaxIdentifiers({
      ...euVatGermany,
      customer: { ...euVatGermany.customer, taxIdentifiers: duplicateTaxIdentifiers },
    }),
    canonicalTaxIdentifiers({
      ...euVatGermany,
      customer: { ...euVatGermany.customer, taxIdentifiers: duplicateTaxIdentifiers.reverse() },
    }),
  );
  assert.equal(
    customerIdentity({
      ...euVatGermany,
      customer: {
        ...euVatGermany.customer,
        taxIdentifiers: [
          { type: "ALTRO", value: "DE-ALT-42", countryCode: "DE", sourceField: "fixture" },
          ...euVatGermany.customer.taxIdentifiers,
        ],
      },
    }).matchKey,
    "tax:PARTITA_IVA:DE:123456789",
  );
  assert.equal(
    customerIdentity({
      ...euVatGermany,
      customer: {
        ...euVatGermany.customer,
        taxIdentifiers: [
          { type: "PARTITA_IVA", value: "123456789", countryCode: "DE", sourceField: "fixture" },
        ],
      },
    }).matchKey,
    customerIdentity(euVatGermany).matchKey,
  );
  assert.equal(customerIdentity(euVatFrance).matchKey, "tax:PARTITA_IVA:FR:12345678901");
  assert.equal(
    customerIdentity({
      ...euVatFrance,
      customer: {
        ...euVatFrance.customer,
        billingAddress: { ...euVatFrance.customer.billingAddress, countryCode: undefined },
        taxIdentifiers: [{ type: "PARTITA_IVA", value: "12345678901", sourceField: "fixture" }],
      },
    }).confidence,
    "AMBIGUOUS",
  );
  assert.equal(
    customerIdentity({
      ...euVatFrance,
      customer: {
        ...euVatFrance.customer,
        taxIdentifiers: [
          {
            type: "CODICE_FISCALE",
            value: "ABCDEF12G34H567I",
            countryCode: "FR",
            sourceField: "fixture",
          },
        ],
      },
    }).matchKey,
    "tax:CODICE_FISCALE:FR:ABCDEF12G34H567I",
  );
  assert.equal(
    customerIdentity({
      ...euVatFrance,
      customer: {
        ...euVatFrance.customer,
        taxIdentifiers: [
          {
            type: "CODICE_FISCALE",
            value: "1234567890123",
            countryCode: "FR",
            sourceField: "fixture",
          },
        ],
      },
    }).matchKey,
    "tax:CODICE_FISCALE:FR:1234567890123",
  );
  assert.equal(
    customerIdentity({
      ...base,
      customer: {
        ...base.customer,
        billingAddress: { ...base.customer.billingAddress, countryCode: "FR" },
      },
    }).matchKey,
    "tax:CODICE_FISCALE::RSSMRA80A01H501U",
  );

  const multipleVat = {
    ...euVatFrance,
    customer: {
      ...euVatFrance.customer,
      taxIdentifiers: [
        {
          type: "PARTITA_IVA" as const,
          value: "99999999999",
          countryCode: "FR",
          sourceField: "fixture-b",
        },
        {
          type: "PARTITA_IVA" as const,
          value: "12345678901",
          countryCode: "FR",
          sourceField: "fixture-a",
        },
      ],
    },
  };
  assert.equal(
    customerIdentity(multipleVat).matchKey,
    customerIdentity({
      ...multipleVat,
      customer: {
        ...multipleVat.customer,
        taxIdentifiers: [...multipleVat.customer.taxIdentifiers].reverse(),
      },
    }).matchKey,
  );

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
  assert.equal(customerIdentity(businessWithOnlyTaxCode).reviewRequired, false);
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
        billingAddress: { ...businessWithVat.customer.billingAddress, countryCode: "FR" },
        taxIdentifiers: [{ type: "PARTITA_IVA", value: "IT12345678901", sourceField: "fixture" }],
      },
    }).matchKey,
    "tax:PARTITA_IVA::12345678901",
  );
  assert.equal(
    customerIdentity({
      ...businessWithVat,
      customer: {
        ...businessWithVat.customer,
        billingAddress: { ...businessWithVat.customer.billingAddress, countryCode: undefined },
        taxIdentifiers: [
          ...businessWithVat.customer.taxIdentifiers,
          ...businessWithOnlyTaxCode.customer.taxIdentifiers,
        ],
      },
    }).matchKey,
    "tax:CODICE_FISCALE::RSSMRA80A01H501U",
  );
  assert.equal(
    customerIdentity({
      ...businessWithVat,
      customer: {
        ...businessWithVat.customer,
        billingAddress: { ...businessWithVat.customer.billingAddress, countryCode: undefined },
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
  assert.equal(
    customerIdentity({
      ...businessWithVat,
      customer: {
        ...businessWithVat.customer,
        billingAddress: { ...businessWithVat.customer.billingAddress, countryCode: undefined },
        taxIdentifiers: [
          {
            type: "PARTITA_IVA" as const,
            value: "IT12345678901",
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
  assert.equal(customerIdentity(unknown).matchKey, customerIdentity(base).matchKey);
  assert.equal(
    customerIdentity({
      ...unknown,
      customer: {
        ...unknown.customer,
        billingAddress: { ...unknown.customer.billingAddress, countryCode: undefined },
        taxIdentifiers: [
          { type: "PARTITA_IVA" as const, value: "12345678901", sourceField: "fixture" },
        ],
      },
    }).matchKey,
    "tax:PARTITA_IVA::12345678901",
  );

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
  const profileWithSeparator = {
    ...foreignProfileWithoutDisplayName,
    customer: {
      ...foreignProfileWithoutDisplayName.customer,
      companyName: "A|B",
      billingAddress: { ...foreignProfileWithoutDisplayName.customer.billingAddress, line1: "C" },
    },
  };
  assert.notEqual(
    customerIdentity(profileWithSeparator).matchKey,
    customerIdentity({
      ...profileWithSeparator,
      customer: {
        ...profileWithSeparator.customer,
        companyName: "A",
        billingAddress: { ...profileWithSeparator.customer.billingAddress, line1: "B|C" },
      },
    }).matchKey,
  );
  assert.notEqual(
    customerIdentity(profileWithSeparator).matchKey,
    customerIdentity({
      ...profileWithSeparator,
      customer: { ...profileWithSeparator.customer, kind: "UNKNOWN" },
    }).matchKey,
  );
  assert.equal(
    customerDisplayName({
      ...foreignProfileWithoutDisplayName.customer,
      companyName: "",
      firstName: "Jean",
      lastName: "Dupont",
    }),
    "Jean Dupont",
  );
  const emptyOptionalTexts = orderInputSchema.parse({
    ...foreignProfileWithoutDisplayName,
    externalCustomerId: "",
    customer: {
      ...foreignProfileWithoutDisplayName.customer,
      displayName: "",
      email: "",
      phone: "",
      companyName: "",
      billingAddress: {
        ...foreignProfileWithoutDisplayName.customer.billingAddress,
        line1: "",
        postalCode: "",
        city: "",
        province: "",
        countryCode: "",
      },
    },
  });
  assert.equal(emptyOptionalTexts.customer.phone, undefined);
  assert.equal(emptyOptionalTexts.externalCustomerId, undefined);
  assert.equal(emptyOptionalTexts.customer.displayName, undefined);
  assert.equal(emptyOptionalTexts.customer.email, undefined);
  assert.equal(emptyOptionalTexts.customer.companyName, undefined);
  assert.equal(emptyOptionalTexts.customer.billingAddress.province, undefined);
  assert.equal(emptyOptionalTexts.customer.billingAddress.countryCode, undefined);
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
  const fallbackWithSeparator = {
    ...base,
    externalAccountId: "account:order",
    externalOrderId: "id",
    customer: { ...base.customer, billingAddress: {}, taxIdentifiers: [] },
  };
  assert.notEqual(
    customerIdentity(fallbackWithSeparator).matchKey,
    customerIdentity({
      ...fallbackWithSeparator,
      externalAccountId: "account",
      externalOrderId: "order:id",
    }).matchKey,
  );
});
