import assert from "node:assert/strict";
import test from "node:test";

import { fiscalNumberLabel } from "./fiscal-number.ts";

test("formatta il numero fiscale senza dipendenze del generatore XML", () => {
  assert.equal(fiscalNumberLabel("FPR", 2026, 12), "FPR 0012/26");
});
