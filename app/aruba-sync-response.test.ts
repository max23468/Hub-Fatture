import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../src/errors.ts";
import { arubaSyncResponse } from "./aruba-sync-response.ts";

test("le API di sola lettura espongono errori stabili e non il vocabolario dei batch", async () => {
  const response = await arubaSyncResponse(async () => {
    throw new AppError("ARUBA_BATCH_INVALID", 422);
  });
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    code: "ARUBA_INVENTORY_INVALID",
    message: "L’inventario Aruba contiene dati non validi.",
  });
});
