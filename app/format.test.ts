import assert from "node:assert/strict";
import test from "node:test";

import { dateTime } from "./format.ts";

test("formatta i timestamp nel fuso Europe/Rome", () => {
  assert.match(dateTime("2026-03-29T00:30:00Z"), /01:30/);
});
