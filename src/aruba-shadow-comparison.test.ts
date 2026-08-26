import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "./errors.ts";
import {
  compareArubaShadowInventories,
  fallbackInventoryToShadowDocuments,
  type ArubaShadowDocument,
  type ArubaShadowSnapshot,
} from "./aruba-shadow-comparison.ts";

const base: ArubaShadowDocument = {
  remoteId: "REMOTE-1",
  documentType: "TD01",
  fiscalYear: 2026,
  series: "FPR",
  fiscalNumber: "1",
  documentDate: "2026-08-26",
  status: "DELIVERED",
};

function snapshot(
  documents: ArubaShadowDocument[],
  input: Partial<Omit<ArubaShadowSnapshot, "documents">> = {},
): ArubaShadowSnapshot {
  return {
    environment: "PRODUCTION",
    accountReference: "account-sintetico",
    populationKey: "outbound:2026-08-26T00:00:00Z/2026-08-27T00:00:00Z",
    remoteIdNamespace: "aruba-document-v2",
    ...input,
    documents,
  };
}

test("dichiara parità per una correlazione univoca tramite ID remoto", () => {
  assert.deepEqual(
    compareArubaShadowInventories({ api: snapshot([base]), fallback: snapshot([base]) }),
    {
      status: "PARITY",
      apiDocuments: 1,
      fallbackDocuments: 1,
      matchedDocuments: 1,
      matchedByRemoteId: 1,
      matchedByFiscalIdentity: 0,
      alignedStatuses: 1,
      divergentStatuses: 0,
      apiOnly: 0,
      fallbackOnly: 0,
      ambiguousApiDocuments: 0,
      ambiguousFallbackDocuments: 0,
      invariantConflicts: 0,
    },
  );
});

test("usa l’identità fiscale completa quando gli ID dei canali non condividono il namespace", () => {
  const result = compareArubaShadowInventories({
    api: snapshot([{ ...base, remoteId: null }], { remoteIdNamespace: null }),
    fallback: snapshot([{ ...base, remoteId: "FALLBACK-1", series: "f.p.r." }], {
      remoteIdNamespace: "aruba-browser-grid",
    }),
  });
  assert.equal(result.status, "PARITY");
  assert.equal(result.matchedByRemoteId, 0);
  assert.equal(result.matchedByFiscalIdentity, 1);
});

test("non fonde lo stesso ID remoto quando le invarianti fiscali divergono", () => {
  const result = compareArubaShadowInventories({
    api: snapshot([base]),
    fallback: snapshot([{ ...base, fiscalNumber: "2" }]),
  });
  assert.equal(result.status, "DIVERGED");
  assert.equal(result.matchedDocuments, 0);
  assert.equal(result.invariantConflicts, 1);
});

test("rende ambiguo un duplicato dell’identità fiscale invece di scegliere un candidato", () => {
  const result = compareArubaShadowInventories({
    api: snapshot([{ ...base, remoteId: null }], { remoteIdNamespace: null }),
    fallback: snapshot(
      [
        { ...base, remoteId: "FALLBACK-1" },
        { ...base, remoteId: "FALLBACK-2" },
      ],
      { remoteIdNamespace: "aruba-browser-grid" },
    ),
  });
  assert.equal(result.status, "AMBIGUOUS");
  assert.equal(result.matchedDocuments, 0);
  assert.equal(result.ambiguousApiDocuments, 1);
  assert.equal(result.ambiguousFallbackDocuments, 2);
});

test("separa la correlazione riuscita dalla divergenza di stato", () => {
  const result = compareArubaShadowInventories({
    api: snapshot([base]),
    fallback: snapshot([{ ...base, status: "NOT_DELIVERED" }]),
  });
  assert.equal(result.status, "DIVERGED");
  assert.equal(result.matchedDocuments, 1);
  assert.equal(result.divergentStatuses, 1);
  assert.equal(result.alignedStatuses, 0);
});

test("non espone identificativi nel riepilogo del confronto", () => {
  const result = compareArubaShadowInventories({
    api: snapshot([base]),
    fallback: snapshot([base]),
  });
  assert.equal(
    Object.entries(result).every(
      ([key, value]) =>
        (key === "status" && ["PARITY", "DIVERGED", "AMBIGUOUS"].includes(String(value))) ||
        (key !== "status" && typeof value === "number"),
    ),
    true,
  );
});

test("rifiuta documenti privi di una chiave di correlazione completa", () => {
  assert.throws(
    () =>
      compareArubaShadowInventories({
        api: snapshot([{ ...base, remoteId: null, series: null, fiscalNumber: null }]),
        fallback: snapshot([]),
      }),
    (error) => error instanceof AppError && error.code === "PROVIDER_RESPONSE_INVALID",
  );
});

test("rifiuta identità fiscali che diventerebbero vuote dopo la normalizzazione", () => {
  assert.throws(
    () =>
      compareArubaShadowInventories({
        api: snapshot([{ ...base, remoteId: null, series: "---", fiscalNumber: "///" }]),
        fallback: snapshot([]),
      }),
    (error) => error instanceof AppError && error.code === "PROVIDER_RESPONSE_INVALID",
  );
});

test("rifiuta snapshot riferiti a popolazioni diverse", () => {
  assert.throws(
    () =>
      compareArubaShadowInventories({
        api: snapshot([base]),
        fallback: snapshot([base], { populationKey: "outbound:altra-finestra" }),
      }),
    (error) => error instanceof AppError && error.code === "PROVIDER_RESPONSE_INVALID",
  );
});

test("non confronta ID omonimi dichiarati in namespace diversi", () => {
  const apiDocument = { ...base, series: null, fiscalNumber: null };
  const fallbackDocument = { ...apiDocument };
  const result = compareArubaShadowInventories({
    api: snapshot([apiDocument], { remoteIdNamespace: "aruba-api-group" }),
    fallback: snapshot([fallbackDocument], { remoteIdNamespace: "aruba-browser-grid" }),
  });
  assert.equal(result.status, "DIVERGED");
  assert.equal(result.matchedDocuments, 0);
  assert.equal(result.apiOnly, 1);
  assert.equal(result.fallbackOnly, 1);
});

test("l’adapter fallback elimina i campi fiscali non necessari al confronto", () => {
  assert.deepEqual(
    fallbackInventoryToShadowDocuments([
      {
        remoteId: "REMOTE-1",
        documentType: "TD01",
        fiscalYear: 2026,
        series: "FPR",
        fiscalNumber: "1",
        documentDate: "2026-08-26",
        recipientName: "Destinatario sintetico",
        recipientTaxId: null,
        recipientTaxIdentifiers: [],
        recipientCountryCode: "IT",
        recipientAddress: null,
        totalAmount: 10000,
        currency: "EUR",
        status: "DELIVERED",
        providerStatusLabel: "Consegnata",
        providerObservedAt: "2026-08-26T12:00:00.000Z",
        xmlSha256: null,
        orderReferences: [],
      },
    ]),
    [base],
  );
});
