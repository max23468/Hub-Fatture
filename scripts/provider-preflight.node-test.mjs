import assert from "node:assert/strict";
import test from "node:test";

import { verifyTarget } from "./provider-preflight.mjs";

test("accetta soltanto il target osservato atteso", () => {
  const expected = { provider: "mock", account: "account-1", target: "sandbox" };

  assert.deepEqual(verifyTarget(expected, expected), { status: "ready", ...expected });
  assert.throws(
    () => verifyTarget(expected, { ...expected, target: "production" }),
    /target non coincide/,
  );
});
