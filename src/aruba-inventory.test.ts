import assert from "node:assert/strict";
import test from "node:test";

import {
  arubaInventoryApprovalState,
  arubaInventoryBlocksAllApprovals,
} from "./aruba-inventory.ts";

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

test("la verifica distingue attesa, freschezza e problemi senza allentare il gate", () => {
  assert.equal(arubaInventoryApprovalState(health(5)), "READY");
  assert.equal(arubaInventoryApprovalState(health(9)), "REFRESH_REQUIRED");
  assert.equal(arubaInventoryApprovalState({ ...health(1), activeSession: true }), "CHECKING");
  assert.equal(arubaInventoryApprovalState({ ...health(1), uncertainRemoteStates: 1 }), "BLOCKED");
  assert.equal(
    arubaInventoryApprovalState({ ...health(null), blockingReason: "FAILURE" }),
    "BLOCKED",
  );
  assert.equal(arubaInventoryApprovalState({ ...health(1), blockingReason: "CONFLICT" }), "READY");
});
