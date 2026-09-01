import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCustomerIdentityException,
  automaticCustomerIdentityException,
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

test("la proposta discordante conserva automaticamente il nome dichiarato", () => {
  assert.deepEqual(
    proposeItalianPrivateNameException("Giovanni Carlo Bianchi", "RSSMRA80A01H501U"),
    { firstName: "Giovanni Carlo", lastName: "Bianchi", basis: "SOURCE_ORDER" },
  );
});

test("la deroga automatica non altera lo snapshot cliente originario", () => {
  const input = {
    provider: "EBAY",
    externalCustomerId: "cliente-sintetico-automatico",
    customer: {
      kind: "PRIVATE_IT",
      displayName: "Giovanni Carlo Bianchi",
      taxIdentifiers: [{ type: "CODICE_FISCALE", countryCode: "IT", value: "RSSMRA80A01H501U" }],
    },
  } as OrderInput;
  const automatic = automaticCustomerIdentityException(input);
  assert.equal(automatic.proposal?.basis, "SOURCE_ORDER");
  assert.equal(input.customer.firstName, undefined);
  assert.equal(input.customer.lastName, undefined);
  assert.equal(automatic.input.customer.firstName, "Giovanni Carlo");
  assert.equal(automatic.input.customer.lastName, "Bianchi");
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
