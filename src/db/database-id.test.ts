import assert from "node:assert/strict";
import test from "node:test";

import { isDatabaseId } from "./database-id.ts";

test("accetta soltanto identificativi bigint PostgreSQL positivi", () => {
  assert.equal(isDatabaseId("1"), true);
  assert.equal(isDatabaseId("9223372036854775807"), true);
  for (const value of ["", "0", "01", "-1", "1.0", "abc", "9223372036854775808"]) {
    assert.equal(isDatabaseId(value), false, value);
  }
});
