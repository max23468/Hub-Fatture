import assert from "node:assert/strict";
import test from "node:test";

import {
  arubaIncrementalScanFrom,
  remoteStatusTransition,
  selectOrderMatch,
  type ArubaRemoteStatus,
  type RemoteInventoryDocument,
} from "./aruba-inbound.ts";

function permutations<T>(items: T[]): T[][] {
  if (items.length < 2) return [items];
  return items.flatMap((item, index) =>
    permutations(items.toSpliced(index, 1)).map((tail) => [item, ...tail]),
  );
}

function applyObservations(observations: ArubaRemoteStatus[]) {
  let current: ArubaRemoteStatus | null = null;
  const conflicts: ArubaRemoteStatus[] = [];
  for (const observed of observations) {
    const transition = remoteStatusTransition(current, observed);
    if (transition === "APPLY") current = observed;
    if (transition === "CONFLICT") conflicts.push(observed);
  }
  return { current, conflicts };
}

const remote: RemoteInventoryDocument = {
  remoteId: "state-model",
  documentType: "TD01",
  fiscalYear: 2026,
  series: "FPR",
  fiscalNumber: "42",
  documentDate: "2026-08-12",
  recipientName: "Mario Rossi",
  recipientTaxId: "RSSMRA80A01H501U",
  recipientTaxIdentifiers: [
    { type: "CODICE_FISCALE", countryCode: null, value: "RSSMRA80A01H501U" },
  ],
  recipientCountryCode: "IT",
  recipientAddress: "Via Roma 1 Milano",
  totalAmount: 12_300,
  currency: "EUR",
  status: "DELIVERED",
  providerStatusLabel: "Consegnata",
  providerObservedAt: "2026-08-13T10:00:00+02:00",
  xmlSha256: "a".repeat(64),
  orderReferences: ["1001"],
};

test("il modello Aruba converge allo stato terminale per ogni ordine degli eventi monotoni", () => {
  for (const observations of permutations<ArubaRemoteStatus>([
    "SUBMITTED",
    "SDI_PROCESSING",
    "DELIVERED",
  ])) {
    assert.deepEqual(applyObservations(observations), { current: "DELIVERED", conflicts: [] });
  }
  for (const observations of permutations<ArubaRemoteStatus>([
    "DELIVERED",
    "NOT_DELIVERED",
    "SUBMITTED",
  ])) {
    const result = applyObservations(observations);
    assert.ok(result.current === "DELIVERED" || result.current === "NOT_DELIVERED");
    assert.equal(result.conflicts.length, 1);
  }
});

test("matcher e finestra dello storico non dipendono dall’ordine dei candidati", () => {
  const candidates = [
    {
      id: "compatible",
      provider: "SHOPIFY" as const,
      displayNumber: "1001",
      localOrderDate: "2026-08-12",
      billableAmount: 12_300,
      recipientName: "Mario Rossi",
      recipientTaxIdentifiers: [
        { type: "CODICE_FISCALE" as const, countryCode: null, value: "RSSMRA80A01H501U" },
      ],
      recipientAddress: "Via Roma 1 Milano",
    },
    {
      id: "different-amount",
      provider: "EBAY" as const,
      displayNumber: "2002",
      localOrderDate: "2026-08-12",
      billableAmount: 10_000,
      recipientName: "Mario Rossi",
      recipientTaxIdentifiers: [],
      recipientAddress: "Via Roma 1 Milano",
    },
  ];
  for (const candidateOrder of permutations(candidates)) {
    const result = selectOrderMatch(remote, candidateOrder);
    assert.equal(result.status, "MATCHED");
    assert.deepEqual(
      result.evaluations
        .filter(({ compatible }) => compatible)
        .map(({ candidateId }) => candidateId),
      ["compatible"],
    );
  }

  const searches = [
    { documentType: "TD01" as const, orderDate: "2026-08-20" },
    { documentType: "TD04" as const, orderDate: "2026-07-01" },
    { documentType: "TD01" as const, orderDate: "2026-08-03" },
  ];
  for (const searchOrder of permutations(searches)) {
    assert.equal(
      arubaIncrementalScanFrom({
        documentType: "TD01",
        incrementalFrom: "2026-08-15",
        oldestReconciliationDate: "2026-06-01",
        searches: searchOrder,
      }),
      "2026-08-03",
    );
  }
});
