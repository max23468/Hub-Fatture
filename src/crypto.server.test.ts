import assert from "node:assert/strict";
import test from "node:test";

import {
  decryptCredential,
  encryptCredential,
  hashPassword,
  verifyPassword,
} from "./crypto.server.ts";

test("le password non sono conservate in chiaro", async () => {
  const passwordHash = await hashPassword("password-sintetica-lunga");
  assert.equal(passwordHash.includes("password-sintetica-lunga"), false);
  assert.equal(await verifyPassword("password-sintetica-lunga", passwordHash), true);
  assert.equal(await verifyPassword("password-errata", passwordHash), false);
});

test("le credenziali provider sono autenticate e non restano in chiaro", () => {
  const key = Buffer.alloc(32, 7).toString("base64url");
  const encrypted = encryptCredential({ token: "segreto-sintetico" }, key);
  assert.equal(encrypted.includes("segreto-sintetico"), false);
  assert.deepEqual(decryptCredential(encrypted, key), { token: "segreto-sintetico" });
  assert.throws(() => decryptCredential(`${encrypted}x`, key));
});

test("l’hash dichiara i parametri di costo usati per verificarlo", async () => {
  const passwordHash = await hashPassword("password-sintetica-lunga");
  const [algorithm, N, r, p] = passwordHash.split("$");
  assert.deepEqual([algorithm, N, r, p], ["scrypt", "16384", "8", "1"]);
  // Un costo diverso da quello registrato non deve mai validare la stessa password.
  const altered = passwordHash.replace("$16384$", "$8192$");
  assert.equal(await verifyPassword("password-sintetica-lunga", altered), false);
  assert.equal(await verifyPassword("password-sintetica-lunga", "scrypt$salt$hash"), false);
});
