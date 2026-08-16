import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../src/errors.ts";
import { parseArubaManualPagesJson } from "./aruba-manual-input.ts";

test("il JSON manuale Aruba non valido conserva il codice applicativo", () => {
  assert.throws(
    () => parseArubaManualPagesJson("{non-json"),
    (error: unknown) =>
      error instanceof AppError && error.code === "ARUBA_INVENTORY_INVALID" && error.status === 422,
  );
});

test("il JSON manuale Aruba valido viene decodificato", () => {
  assert.deepEqual(parseArubaManualPagesJson('[{"stream":"invoices:2026"}]'), [
    { stream: "invoices:2026" },
  ]);
});
