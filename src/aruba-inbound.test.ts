import assert from "node:assert/strict";
import test from "node:test";

import {
  remoteStatusTransition,
  selectOrderMatch,
  type RemoteInventoryDocument,
} from "./aruba-inbound.ts";

const remote: RemoteInventoryDocument = {
  remoteId: "remote-1",
  documentType: "TD01",
  fiscalYear: 2026,
  series: "A",
  fiscalNumber: "12",
  documentDate: "2026-08-12",
  recipientName: "Mario Rossi",
  recipientTaxId: "RSSMRA80A01H501U",
  recipientCountryCode: "IT",
  recipientAddress: "Via Roma 1 Milano",
  totalAmount: 12_300,
  currency: "EUR",
  status: "DELIVERED",
  providerObservedAt: "2026-08-12T12:00:00+02:00",
  xmlSha256: null,
  orderReferences: [],
};

test("gli stati remoti non regrediscono e i terminali incompatibili aprono conflitto", () => {
  assert.equal(remoteStatusTransition("SDI_PROCESSING", "SUBMITTED"), "IGNORE_STALE");
  assert.equal(remoteStatusTransition("SDI_PROCESSING", "DELIVERED"), "APPLY");
  assert.equal(remoteStatusTransition("DELIVERED", "SDI_PROCESSING"), "IGNORE_STALE");
  assert.equal(remoteStatusTransition("DELIVERED", "REJECTED"), "CONFLICT");
  assert.equal(remoteStatusTransition("DELIVERED", "UNKNOWN"), "CONFLICT");
});

test("il totale da solo non produce mai un collegamento", () => {
  const result = selectOrderMatch(remote, [
    {
      id: "1",
      provider: "SHOPIFY",
      displayNumber: "1001",
      localOrderDate: "2026-08-12",
      billableAmount: 12_300,
      recipientName: "Altra Persona",
      recipientTaxIds: [],
      recipientAddress: "Altrove",
    },
  ]);
  assert.equal(result.status, "UNMATCHED");
});

test("un candidato univoco richiede data, importo e identità coerenti", () => {
  const result = selectOrderMatch(remote, [
    {
      id: "1",
      provider: "SHOPIFY",
      displayNumber: "1001",
      localOrderDate: "2026-08-12",
      billableAmount: 12_300,
      recipientName: "Mario Rossi",
      recipientTaxIds: ["RSSMRA80A01H501U"],
      recipientAddress: "Via Roma 1 Milano",
    },
  ]);
  assert.equal(result.status, "MATCHED");
});

test("due candidati compatibili restano ambigui", () => {
  const candidate = {
    provider: "EBAY" as const,
    displayNumber: "A",
    localOrderDate: "2026-08-12",
    billableAmount: 12_300,
    recipientName: "Mario Rossi",
    recipientTaxIds: ["RSSMRA80A01H501U"],
    recipientAddress: "Via Roma 1 Milano",
  };
  assert.equal(
    selectOrderMatch(remote, [
      { ...candidate, id: "1" },
      { ...candidate, id: "2" },
    ]).status,
    "AMBIGUOUS",
  );
});
