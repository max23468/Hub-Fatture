import assert from "node:assert/strict";
import test from "node:test";

import {
  parseProductionFiscalNumber,
  parseProductionOrderReferences,
} from "./aruba-read-helper.ts";

test("normalizza il progressivo Aruba e verifica il suffisso annuale", () => {
  assert.deepEqual(parseProductionFiscalNumber("FPR 0001/26", 2026), {
    series: "FPR",
    fiscalNumber: "1",
  });
  assert.deepEqual(parseProductionFiscalNumber("FPR 0042/2026", 2026), {
    series: "FPR",
    fiscalNumber: "42",
  });
  assert.throws(() => parseProductionFiscalNumber("FPR 0001/25", 2026), /DOM_UNRECOGNIZED/);
  assert.throws(() => parseProductionFiscalNumber("FPR 0001", 2026), /DOM_UNRECOGNIZED/);
});

test("ammette riferimenti ordine assenti ma rifiuta contenuti non riconoscibili", () => {
  assert.deepEqual(parseProductionOrderReferences(""), []);
  assert.deepEqual(parseProductionOrderReferences("   \n"), []);
  assert.deepEqual(parseProductionOrderReferences("Ordine: #1001; #1002"), ["#1001", "#1002"]);
  assert.throws(() => parseProductionOrderReferences("Riferimenti"), /DOM_UNRECOGNIZED/);
});
