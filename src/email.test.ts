import assert from "node:assert/strict";
import test from "node:test";

import { customerEmailTriggerStatus } from "./db/email.server.ts";

test("la copia cliente parte solo da un esito SdI autorevole", () => {
  assert.equal(customerEmailTriggerStatus("DELIVERED"), true);
  assert.equal(customerEmailTriggerStatus("NOT_DELIVERED"), true);
  assert.equal(customerEmailTriggerStatus("REJECTED"), false);
  assert.equal(customerEmailTriggerStatus("SDI_PROCESSING"), false);
  assert.equal(customerEmailTriggerStatus("UNKNOWN"), false);
  assert.equal(customerEmailTriggerStatus("VALIDATED"), false);
});
