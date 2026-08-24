import assert from "node:assert/strict";
import test from "node:test";

import { claimArubaBridgeStart } from "./aruba-bridge-state.ts";

test("il ponte Aruba avvia una sola copia del lettore per finestra", () => {
  const state = { current: false };

  assert.equal(claimArubaBridgeStart(state), true);
  assert.equal(claimArubaBridgeStart(state), false);

  state.current = false;
  assert.equal(claimArubaBridgeStart(state), true);
});
