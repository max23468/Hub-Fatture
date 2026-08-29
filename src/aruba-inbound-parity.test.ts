import assert from "node:assert/strict";
import test from "node:test";

import {
  compareArubaInboundParity,
  type ArubaInboundParityDocument,
} from "./aruba-inbound-parity.ts";

const base: ArubaInboundParityDocument = {
  documentType: "TD01",
  fiscalYear: 2026,
  series: null,
  fiscalNumber: null,
  documentDate: "2026-08-26",
  totalAmount: 10_000,
  remoteStatus: "DELIVERED",
  fileHashes: ["a".repeat(64)],
};

test("la parità inbound correla soltanto prove forti e confronta tutti i file", () => {
  assert.deepEqual(compareArubaInboundParity({ api: [base], browser: [base] }), {
    status: "MATCHED",
    apiDocuments: 1,
    browserDocuments: 1,
    matchedDocuments: 1,
    missingInApi: 0,
    missingInBrowser: 0,
    statusMismatches: 0,
    fileMismatches: 0,
  });
  const missingPdf = compareArubaInboundParity({
    api: [{ ...base, fileHashes: [...base.fileHashes, "b".repeat(64)] }],
    browser: [base],
  });
  assert.equal(missingPdf.status, "DIVERGENT");
  assert.equal(missingPdf.fileMismatches, 1);
});

test("l'assenza di file nel baseline browser non contraddice l'evidenza ufficiale API", () => {
  const identified = { ...base, series: "FPR", fiscalNumber: "101/26" };
  const result = compareArubaInboundParity({
    api: [identified],
    browser: [{ ...identified, fileHashes: [] }],
  });

  assert.equal(result.status, "MATCHED");
  assert.equal(result.matchedDocuments, 1);
  assert.equal(result.fileMismatches, 0);
});

test("data e totale senza identità o hash comune non dimostrano parità", () => {
  const result = compareArubaInboundParity({
    api: [{ ...base, fileHashes: [] }],
    browser: [{ ...base, fileHashes: [] }],
  });
  assert.equal(result.status, "DIVERGENT");
  assert.equal(result.matchedDocuments, 0);
  assert.equal(result.missingInApi, 1);
  assert.equal(result.missingInBrowser, 1);
});

test("un hash condiviso da più documenti resta ambiguo", () => {
  const result = compareArubaInboundParity({
    api: [base],
    browser: [base, { ...base }],
  });
  assert.equal(result.status, "DIVERGENT");
  assert.equal(result.matchedDocuments, 0);
  assert.equal(result.missingInApi, 2);
  assert.equal(result.missingInBrowser, 1);
});
