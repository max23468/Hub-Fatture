import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const legacySizeCaps = new Map([
  ["src/db/aruba-inbound.server.ts", 158_884],
  ["src/db/order-import.server.ts", 65_706],
  ["src/db/aruba-inbound.server.test.ts", 94_835],
  ["src/db/orders.server.test.ts", 278_450],
  ["app/styles.css", 118_195],
  ["app/copy.it.ts", 59_008],
]);

test("i file legacy sovradimensionati non crescono ulteriormente", async () => {
  const offenders = [];
  for (const [file, maxBytes] of legacySizeCaps) {
    const size = (await stat(path.join(root, file))).size;
    if (size > maxBytes) offenders.push(`${file}: ${size} > ${maxBytes}`);
  }
  assert.deepEqual(offenders, []);
});

test("manifest, completamento e runner Aruba usano i moduli estratti", async () => {
  const [manifestRoute, completeRoute, manifest, runner] = await Promise.all([
    readFile(path.join(root, "app/routes/aruba-sync-manifest.ts"), "utf8"),
    readFile(path.join(root, "app/routes/aruba-sync-complete.ts"), "utf8"),
    readFile(path.join(root, "package.json"), "utf8"),
    readFile(path.join(root, "scripts/aruba-read-runner.ts"), "utf8"),
  ]);
  assert.match(manifestRoute, /arubaInventoryManifest/);
  assert.doesNotMatch(manifestRoute, /\barubaReadManifest\b/);
  assert.match(completeRoute, /completeStableArubaInventory/);
  assert.doesNotMatch(completeRoute, /\bcompleteArubaInventory\b/);
  assert.equal(JSON.parse(manifest).scripts["aruba:sync"], "node scripts/aruba-read-runner.ts");
  assert.match(runner, /installBoundedArubaRequestGet/);
  assert.match(runner, /chromium\.launchPersistentContext/);
});
