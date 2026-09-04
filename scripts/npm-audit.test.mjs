import assert from "node:assert/strict";
import test from "node:test";
import { isCompletedAudit, retryDelaysMs } from "./npm-audit.mjs";

test("l'audit completo non viene confuso con un errore transitorio del provider", () => {
  assert.equal(
    isCompletedAudit(JSON.stringify({ metadata: { vulnerabilities: { high: 1 } } })),
    true,
  );
  assert.equal(isCompletedAudit(JSON.stringify({ error: "Service Unavailable" })), false);
  assert.equal(isCompletedAudit("risposta non JSON"), false);
});

test("i retry del provider restano limitati entro il timeout CI", () => {
  assert.deepEqual(retryDelaysMs, [0, 30_000, 90_000, 180_000]);
});
