import assert from "node:assert/strict";
import test from "node:test";

import { ARUBA_API_POLICY } from "./aruba-api-policy.ts";

test("il bucket upload resta entro il Tier Aruba minimo di 60 richieste l’ora", () => {
  assert.ok(ARUBA_API_POLICY.sendIntervalMs >= 60_000);
});
