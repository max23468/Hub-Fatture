import assert from "node:assert/strict";
import test from "node:test";

import { arubaInventoryBlocksAllApprovals } from "./aruba-inventory.ts";

function health(ageMinutes: number | null) {
  return {
    blockingReason: null,
    ageMinutes,
    activeSession: false,
    uncertainRemoteStates: 0,
  } as const;
}

test("l'inventario Aruba oltre cinque minuti blocca ogni approvazione", () => {
  assert.equal(arubaInventoryBlocksAllApprovals(health(5)), false);
  assert.equal(arubaInventoryBlocksAllApprovals(health(5.01)), true);
  assert.equal(arubaInventoryBlocksAllApprovals(health(null)), true);
});
