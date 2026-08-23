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
  ["app/styles.css", 119_474],
  ["app/copy.it.ts", 59_800],
]);

test("i file legacy sovradimensionati non crescono ulteriormente", async () => {
  const offenders = [];
  for (const [file, maxBytes] of legacySizeCaps) {
    const size = (await stat(path.join(root, file))).size;
    if (size > maxBytes) offenders.push(`${file}: ${size} > ${maxBytes}`);
  }
  assert.deepEqual(offenders, []);
});

test("le route e l'emissione della sessione Aruba usano i moduli estratti", async () => {
  const [manifestRoute, completeRoute, settings, inbound, session, manifest, runner] =
    await Promise.all([
      readFile(path.join(root, "app/routes/aruba-sync-manifest.ts"), "utf8"),
      readFile(path.join(root, "app/routes/aruba-sync-complete.ts"), "utf8"),
      readFile(path.join(root, "app/routes/settings.server.ts"), "utf8"),
      readFile(path.join(root, "src/db/aruba-inbound.server.ts"), "utf8"),
      readFile(path.join(root, "src/db/aruba-read-session.server.ts"), "utf8"),
      readFile(path.join(root, "package.json"), "utf8"),
      readFile(path.join(root, "scripts/aruba-read-runner.ts"), "utf8"),
    ]);
  assert.match(manifestRoute, /arubaInventoryManifest/);
  assert.doesNotMatch(manifestRoute, /\barubaReadManifest\b/);
  assert.match(completeRoute, /completeStableArubaInventory/);
  assert.doesNotMatch(completeRoute, /\bcompleteArubaInventory\b/);
  assert.match(settings, /buildArubaBookmarklet/);
  assert.doesNotMatch(settings, /approveArubaConnectorPairing/);
  assert.doesNotMatch(settings, /issueStableArubaReadSession/);
  assert.match(inbound, /freezeArubaInventorySnapshot/);
  assert.doesNotMatch(inbound, /export async function arubaReadManifest/);
  assert.doesNotMatch(inbound, /export async function completeArubaInventory/);
  assert.match(session, /export async function loadArubaReadSession/);
  assert.equal(JSON.parse(manifest).scripts["aruba:sync"], "node scripts/aruba-read-runner.ts");
  assert.match(runner, /installBoundedArubaRequestGet/);
  assert.match(runner, /chromium\.launchPersistentContext/);
});
