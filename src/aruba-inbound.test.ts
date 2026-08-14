import assert from "node:assert/strict";
import test from "node:test";

import {
  groupOrderCandidates,
  inventoryPageSchema,
  remoteMatchesPreflightSearches,
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

test("le pagine inventario rispettano tipo e anno dichiarati dallo stream", () => {
  const page = {
    stream: "invoices:2026",
    scanOrdinal: 1,
    pageOrdinal: 1,
    cursor: null,
    terminal: true,
    fullScan: true,
    documents: [remote],
  };
  assert.equal(inventoryPageSchema.safeParse(page).success, true);
  assert.equal(
    inventoryPageSchema.safeParse({
      ...page,
      documents: [{ ...remote, documentType: "TD04" }],
    }).success,
    false,
  );
  assert.equal(
    inventoryPageSchema.safeParse({
      ...page,
      documents: [{ ...remote, fiscalYear: 2025 }],
    }).success,
    false,
  );
  assert.equal(
    inventoryPageSchema.safeParse({
      ...page,
      stream: "credit-notes:2026",
      documents: [{ ...remote, documentType: "TD04" }],
    }).success,
    true,
  );
  assert.equal(
    inventoryPageSchema.safeParse({
      ...page,
      stream: "specific:1",
      documents: [{ ...remote, documentType: "TD04", fiscalYear: 2025 }],
    }).success,
    true,
  );
});

test("gli stati remoti non regrediscono e i terminali incompatibili aprono conflitto", () => {
  assert.equal(remoteStatusTransition("SDI_PROCESSING", "SUBMITTED"), "IGNORE_STALE");
  assert.equal(remoteStatusTransition("SDI_PROCESSING", "DELIVERED"), "APPLY");
  assert.equal(remoteStatusTransition("DELIVERED", "SDI_PROCESSING"), "IGNORE_STALE");
  assert.equal(remoteStatusTransition("DELIVERED", "REJECTED"), "CONFLICT");
  assert.equal(remoteStatusTransition("DELIVERED", "UNKNOWN"), "CONFLICT");
  assert.equal(remoteStatusTransition("UNKNOWN", "SUBMITTED"), "APPLY");
  assert.equal(remoteStatusTransition("UNKNOWN", "DELIVERED"), "APPLY");
  assert.equal(remoteStatusTransition("UNKNOWN", "NOT_DELIVERED"), "APPLY");
  assert.equal(remoteStatusTransition("UNKNOWN", "REJECTED"), "APPLY");
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

test("un riferimento esplicito non ignora un destinatario dichiarato incompatibile", () => {
  const result = selectOrderMatch({ ...remote, orderReferences: ["1001"] }, [
    {
      id: "1",
      provider: "SHOPIFY",
      displayNumber: "1001",
      localOrderDate: "2026-08-12",
      billableAmount: 12_300,
      recipientName: "Altra Persona",
      recipientTaxIds: ["VRDLGI80A01H501U"],
      recipientAddress: "Via Altrove 9 Torino",
    },
  ]);
  assert.equal(result.status, "UNMATCHED");

  const wrongTaxId = selectOrderMatch({ ...remote, orderReferences: ["1001"] }, [
    {
      id: "1",
      provider: "SHOPIFY",
      displayNumber: "1001",
      localOrderDate: "2026-08-12",
      billableAmount: 12_300,
      recipientName: "Mario Rossi",
      recipientTaxIds: ["VRDLGI80A01H501U"],
      recipientAddress: "Via Roma 1 Milano",
    },
  ]);
  assert.equal(wrongTaxId.status, "UNMATCHED");
});

test("una TD01 anteriore all’ordine non viene collegata", () => {
  const result = selectOrderMatch(remote, [
    {
      id: "1",
      provider: "SHOPIFY",
      displayNumber: "1001",
      localOrderDate: "2026-08-13",
      billableAmount: 12_300,
      recipientName: "Mario Rossi",
      recipientTaxIds: ["RSSMRA80A01H501U"],
      recipientAddress: "Via Roma 1 Milano",
    },
  ]);
  assert.equal(result.status, "UNMATCHED");
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

test("una preparazione multi-ordine usa insieme riferimenti e totale del gruppo", () => {
  const grouped = groupOrderCandidates([
    {
      id: "1",
      billingCaseId: "10",
      provider: "SHOPIFY",
      displayNumber: "1001",
      localOrderDate: "2026-08-12",
      billableAmount: 8_000,
      recipientName: "Mario Rossi",
      recipientTaxIds: ["RSSMRA80A01H501U"],
      recipientAddress: "Via Roma 1 Milano",
    },
    {
      id: "2",
      billingCaseId: "10",
      provider: "SHOPIFY",
      displayNumber: "1002",
      localOrderDate: "2026-08-13",
      billableAmount: 4_300,
      recipientName: "Mario Rossi",
      recipientTaxIds: ["RSSMRA80A01H501U"],
      recipientAddress: "Via Roma 1 Milano",
    },
  ]);
  const groupedRemote = { ...remote, orderReferences: ["1002"] };
  const match = selectOrderMatch(groupedRemote, grouped);
  assert.equal(match.status, "MATCHED");
  assert.deepEqual(match.evaluations[0]!.orderIds, ["1", "2"]);
  assert.equal(
    remoteMatchesPreflightSearches(groupedRemote, [
      { documentType: "TD01", amount: 8_000, displayNumber: "1001" },
      { documentType: "TD01", amount: 4_300, displayNumber: "1002" },
    ]),
    true,
  );
});

test("un documento che riferisce un sottoinsieme della preparazione blocca il preflight", () => {
  assert.equal(
    remoteMatchesPreflightSearches(
      { ...remote, totalAmount: 8_000, orderReferences: ["1001", "1002"] },
      [
        { documentType: "TD01", amount: 5_000, displayNumber: "1001" },
        { documentType: "TD01", amount: 3_000, displayNumber: "1002" },
        { documentType: "TD01", amount: 4_300, displayNumber: "1003" },
      ],
    ),
    true,
  );
});

test("un documento scartato non blocca il preflight di una nuova revisione", () => {
  assert.equal(
    remoteMatchesPreflightSearches({ ...remote, status: "REJECTED", orderReferences: ["1001"] }, [
      { documentType: "TD01", amount: 12_300, displayNumber: "1001" },
    ]),
    false,
  );
});
