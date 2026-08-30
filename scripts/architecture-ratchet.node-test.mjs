import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const legacySizeCaps = new Map([
  ["src/db/aruba-inbound.server.ts", 158_884],
  ["src/db/order-import.server.ts", 65_706],
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

test("il runtime Aruba resta esclusivamente API o manuale", async () => {
  const runtimeRoots = ["app", "src", "scripts", ".github"];
  const runtimeFiles = (
    await Promise.all(
      runtimeRoots.map(async (directory) =>
        (await readdir(path.join(root, directory), { recursive: true, withFileTypes: true }))
          .filter((entry) => entry.isFile())
          .map((entry) => path.join(entry.parentPath, entry.name)),
      ),
    )
  ).flat();
  const forbiddenFiles = runtimeFiles
    .map((file) => path.relative(root, file))
    .filter((file) =>
      /aruba.*(?:bookmarklet|bridge|browser|helper|synthetic|shadow|parity)/i.test(file),
    );
  assert.deepEqual(forbiddenFiles, []);
  const [routes, settings, inbound, manifest, readme, transition] = await Promise.all([
    readFile(path.join(root, "app/routes.ts"), "utf8"),
    readFile(path.join(root, "app/routes/settings.server.ts"), "utf8"),
    readFile(path.join(root, "src/db/aruba-inbound.server.ts"), "utf8"),
    readFile(path.join(root, "package.json"), "utf8"),
    readFile(path.join(root, "README.md"), "utf8"),
    readFile(path.join(root, "docs/evidence/aruba-api-transition.md"), "utf8"),
  ]);
  const executable = `${routes}\n${settings}\n${inbound}\n${manifest}`;
  assert.doesNotMatch(executable, /aruba-(?:ponte|sintetica|bookmarklet)/i);
  assert.doesNotMatch(executable, /api\/aruba\/(?:helper|sync)/i);
  assert.doesNotMatch(executable, /issueArubaReadSession|loadArubaReadSession/);
  assert.doesNotMatch(executable, /requestImmediateArubaSync/);
  const packageJson = JSON.parse(manifest);
  assert.equal(packageJson.scripts["aruba:sync"], undefined);
  assert.equal(packageJson.scripts["aruba:helper"], undefined);
  assert.doesNotMatch(readme, /aruba:helper|barra dei preferiti|ponte autenticato/i);
  assert.match(readme, /API Aruba v2 sono l.unico canale automatico/);
  assert.match(inbound, /request_json,\s*source, status,[\s\S]*'MANUAL'/);
  assert.match(transition, /nuovi readback manuali usano origine `MANUAL`/);
  const [major, minor] = packageJson.version.split(".").map(Number);
  assert.ok(
    major >= 1 || (major === 0 && minor >= 5),
    `treno pre-transizione: ${packageJson.version}`,
  );
});
