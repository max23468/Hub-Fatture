import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCustomerIdentityException,
  customerIdentityExceptionProposal,
} from "./customer-identity-exception.ts";
import { proposeItalianPrivateNameException } from "./italian-fiscal-code.ts";
import type { OrderInput } from "./orders.ts";

test("la proposta usa l'unica porzione controverificata dal CF e ignora il prefisso", () => {
  assert.deepEqual(
    proposeItalianPrivateNameException("Etichetta 4 Rossi Mario", "RSSMRA80A01H501U"),
    { firstName: "Mario", lastName: "Rossi", basis: "FISCAL_CODE" },
  );
});

test("la proposta discordante resta una deroga esplicita nome-cognome", () => {
  assert.deepEqual(
    proposeItalianPrivateNameException("Giovanni Carlo Bianchi", "RSSMRA80A01H501U"),
    { firstName: "Giovanni Carlo", lastName: "Bianchi", basis: "SOURCE_ORDER" },
  );
});

test("la deroga vale soltanto per l'impronta esatta della sorgente", () => {
  const input = {
    provider: "EBAY",
    externalCustomerId: "cliente-sintetico",
    customer: {
      kind: "PRIVATE_IT",
      displayName: "Giovanni Bianchi",
      taxIdentifiers: [{ type: "CODICE_FISCALE", countryCode: "IT", value: "RSSMRA80A01H501U" }],
    },
  } as OrderInput;
  const proposal = customerIdentityExceptionProposal(input)!;
  assert.deepEqual(
    applyCustomerIdentityException(input, proposal).customer,
    expectNames(input.customer, "Giovanni", "Bianchi"),
  );
  assert.equal(
    applyCustomerIdentityException(
      { ...input, customer: { ...input.customer, displayName: "Nome cambiato" } },
      proposal,
    ).customer.firstName,
    undefined,
  );
});

function expectNames<T extends Record<string, unknown>>(
  value: T,
  firstName: string,
  lastName: string,
) {
  return { ...value, firstName, lastName };
}
