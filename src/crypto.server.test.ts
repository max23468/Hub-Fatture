import assert from "node:assert/strict";
import test from "node:test";

import { hashPassword, verifyPassword } from "./crypto.server.ts";

test("le password non sono conservate in chiaro", async () => {
  const passwordHash = await hashPassword("password-sintetica-lunga");
  assert.equal(passwordHash.includes("password-sintetica-lunga"), false);
  assert.equal(await verifyPassword("password-sintetica-lunga", passwordHash), true);
  assert.equal(await verifyPassword("password-errata", passwordHash), false);
});
