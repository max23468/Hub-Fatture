import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { verifyTarget } from "./provider-preflight.mjs";

test("accetta soltanto il target osservato atteso", () => {
  const expected = { provider: "mock", account: "account-1", target: "sandbox" };

  assert.deepEqual(verifyTarget(expected, expected), { status: "ready", ...expected });
  assert.throws(
    () => verifyTarget(expected, { ...expected, target: "production" }),
    /target non coincide/,
  );
});

test("la CLI resta fail-closed anche da un percorso con spazi", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hf preflight "));
  await copyFile(
    fileURLToPath(new URL("./provider-preflight.mjs", import.meta.url)),
    path.join(directory, "provider-preflight.mjs"),
  );
  const script = path.join(directory, "provider-preflight.mjs");

  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [script, "mock", "account-1", "sandbox", "mock", "account-1", "production"],
        {
          encoding: "utf8",
          stdio: "pipe",
        },
      ),
    (error) => error.status === 1 && /target non coincide/.test(error.stderr),
  );

  assert.match(
    execFileSync(
      process.execPath,
      [script, "mock", "account-1", "sandbox", "mock", "account-1", "sandbox"],
      { encoding: "utf8" },
    ),
    /"status":"ready"/,
  );
});
