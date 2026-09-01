import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type pg from "pg";

import { orderInputSchema, type OrderInput } from "../orders.ts";
import { recoverCustomerTaxIdentifier } from "./order-customer-tax-recovery.server.ts";

const fixture = JSON.parse(
  await readFile("tests/fixtures/orders/normalized.mock.json", "utf8"),
) as unknown[];

function input(): OrderInput {
  const value = orderInputSchema.parse(structuredClone(fixture[0]));
  value.externalCustomerId = "gid://shopify/Customer/6827312709906";
  value.customer.taxIdentifiers = [];
  return value;
}

function priorRow(value = "RSSMRA80A01H501U", email?: string) {
  const current = input();
  const profile = {
    kind: current.customer.kind,
    displayName: "mario rossi",
    firstName: "mario",
    lastName: "rossi",
    companyName: "",
    email: email ?? current.customer.email,
    certifiedEmail: "",
    recipientCode: "",
    phone: current.customer.phone ?? "",
    billingAddress: {
      line1: current.customer.billingAddress.line1,
      line2: "dato fiscale nel vecchio ordine",
      postalCode: current.customer.billingAddress.postalCode,
      city: current.customer.billingAddress.city,
      province: current.customer.billingAddress.province,
      countryCode: current.customer.billingAddress.countryCode,
    },
    shippingAddress: {},
    taxIdentifiers: [],
  };
  return {
    order_id: "4027",
    type: "CODICE_FISCALE",
    normalized_value: value,
    country_code: null,
    source_field: "billingAddress.address2",
    normalized_snapshot_json: { customerSnapshot: { canonicalProfile: profile } },
  };
}

function client(rows: unknown[]) {
  return { query: async () => ({ rows }) } as unknown as pg.PoolClient;
}

test("recupera un solo codice fiscale dallo stesso cliente sorgente", async () => {
  const current = input();
  const profile = priorRow();
  const canonical = (await import("../orders.ts")).canonicalCustomerProfile(current);
  profile.normalized_snapshot_json.customerSnapshot.canonicalProfile = {
    ...canonical,
    billingAddress: { ...canonical.billingAddress, line2: "codice nel vecchio ordine" },
  } as never;
  const result = await recoverCustomerTaxIdentifier(client([profile]), current);
  assert.equal(result.recovered, true);
  assert.deepEqual(result.input.customer.taxIdentifiers, [
    {
      type: "CODICE_FISCALE",
      value: "RSSMRA80A01H501U",
      countryCode: "IT",
      sourceField: "priorOrder:4027:billingAddress.address2",
    },
  ]);
});

test("non recupera valori discordanti o profili diversi", async () => {
  const current = input();
  const canonical = (await import("../orders.ts")).canonicalCustomerProfile(current);
  const matching = (value: string) => ({
    ...priorRow(value),
    normalized_snapshot_json: {
      customerSnapshot: {
        canonicalProfile: {
          ...canonical,
          billingAddress: { ...canonical.billingAddress, line2: "irrilevante" },
        },
      },
    },
  });
  assert.equal(
    (
      await recoverCustomerTaxIdentifier(
        client([matching("RSSMRA80A01H501U"), matching("VRDLGI80A01H501U")]),
        current,
      )
    ).recovered,
    false,
  );
  const different = matching("RSSMRA80A01H501U");
  different.normalized_snapshot_json.customerSnapshot.canonicalProfile.email =
    "altra@example.invalid";
  assert.equal((await recoverCustomerTaxIdentifier(client([different]), current)).recovered, false);
});
