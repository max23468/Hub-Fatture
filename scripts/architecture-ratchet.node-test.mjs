import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const capabilitySizeCaps = new Map([
  ["src/db/aruba-inbound.server.ts", 34_000],
  ["src/db/aruba-reconciliation.server.ts", 28_000],
  ["src/db/aruba-document-materialization.server.ts", 40_000],
  ["src/db/aruba-official-file-import.server.ts", 15_000],
  ["src/db/aruba-api-inbound.server.ts", 32_000],
  ["src/db/aruba-api-context.server.ts", 7_000],
  ["src/db/aruba-api-settings.server.ts", 18_000],
  ["src/db/documents.server.ts", 48_000],
  ["src/db/document-archive.server.ts", 7_000],
  ["src/db/document-mass-approval.server.ts", 7_000],
  ["src/db/order-commands.server.ts", 13_000],
  ["src/db/historical-order-reconciliation.server.ts", 56_000],
  ["src/db/order-import.server.ts", 39_000],
  ["src/db/order-grouping.server.ts", 6_000],
  ["src/db/order-children-persistence.server.ts", 10_000],
  ["src/db/order-source-conflict.server.ts", 8_000],
  ["app/routes/settings.tsx", 12_000],
  ["app/components/settings/aruba-settings-section.tsx", 31_000],
  ["app/components/settings/billing-settings-section.tsx", 5_000],
  ["app/components/settings/connections-settings-section.tsx", 10_000],
  ["app/components/settings/profile-settings-section.tsx", 8_000],
  ["app/components/settings/system-settings-section.tsx", 5_000],
  ["app/styles/foundation-shell.css", 21_000],
  ["app/styles/motion.css", 12_000],
  ["app/styles/dashboard-orders.css", 17_000],
  ["app/styles/detail-workflows.css", 19_000],
  ["app/styles/settings.css", 12_000],
  ["app/styles/activity-documents.css", 22_000],
  ["app/styles/customers-responsive.css", 41_000],
  ["tests/e2e/readiness/core.ts", 80_000],
  ["tests/e2e/readiness/interface.ts", 20_000],
  ["tests/e2e/readiness/motion.ts", 8_000],
  ["tests/e2e/readiness/historical-credit-note-flow.ts", 11_000],
  ["tests/e2e/readiness/configured-aruba-api-ui.ts", 8_000],
  ["src/db/migrations-scenarios/legacy-upgrades.test.ts", 26_000],
  ["src/db/migrations-scenarios/mapper-reimports.test.ts", 35_000],
  ["src/db/migrations-scenarios/installation-upgrades.test.ts", 34_000],
  ["app/copy.it.ts", 59_800],
]);

const scenarioSizeCaps = new Map([
  ["src/db/orders.server.test.ts", 2_000],
  ["src/db/orders-scenarios/orders-import-settings.scenario.test.ts", 22_000],
  ["src/db/orders-scenarios/orders-mutations-grouping.scenario.test.ts", 18_000],
  ["src/db/orders-scenarios/orders-payments-core.scenario.test.ts", 60_000],
  ["src/db/orders-scenarios/orders-history-matching.scenario.test.ts", 74_000],
  ["src/db/orders-scenarios/orders-history-extended.scenario.test.ts", 80_000],
  ["src/db/orders-scenarios/orders-refunds-concurrency.scenario.test.ts", 45_000],
]);

test("le capacità estratte non tornano a crescere in monoliti", async () => {
  const offenders = [];
  for (const [file, maxBytes] of capabilitySizeCaps) {
    const size = (await stat(path.join(root, file))).size;
    if (size > maxBytes) offenders.push(`${file}: ${size} > ${maxBytes}`);
  }
  assert.deepEqual(offenders, []);
});

test("readiness e migrazioni restano partizionate senza perdere scenari", async () => {
  const readinessFiles = [
    "tests/e2e/readiness/core.ts",
    "tests/e2e/readiness/interface.ts",
    "tests/e2e/readiness/motion.ts",
    "tests/e2e/readiness/http.ts",
  ];
  const migrationFiles = [
    "src/db/migrations-scenarios/legacy-upgrades.test.ts",
    "src/db/migrations-scenarios/mapper-reimports.test.ts",
    "src/db/migrations-scenarios/installation-upgrades.test.ts",
  ];
  const [readinessEntry, migrationEntry, ...sources] = await Promise.all([
    readFile(path.join(root, "tests/e2e/readiness.spec.ts"), "utf8"),
    readFile(path.join(root, "src/db/migrations.server.test.ts"), "utf8"),
    ...[...readinessFiles, ...migrationFiles].map((file) =>
      readFile(path.join(root, file), "utf8"),
    ),
  ]);
  for (const file of readinessFiles) {
    assert.match(readinessEntry, new RegExp(path.basename(file, ".ts")));
  }
  for (const file of migrationFiles) {
    assert.match(migrationEntry, new RegExp(path.basename(file, ".ts")));
  }
  const readinessTests = sources
    .slice(0, readinessFiles.length)
    .flatMap((source) => [...source.matchAll(/^test\(/gm)]);
  const migrationTests = sources
    .slice(readinessFiles.length)
    .flatMap((source) => [...source.matchAll(/^test\(/gm)]);
  assert.equal(readinessTests.length, 9);
  assert.equal(migrationTests.length, 18);
});

test("lo scenario PostgreSQL degli ordini resta partizionato per capacità", async () => {
  const [source, serverConfig] = await Promise.all([
    readFile(path.join(root, "src/db/orders.server.test.ts"), "utf8"),
    readFile(path.join(root, "tsconfig.server.json"), "utf8"),
  ]);
  const capabilities = [...source.matchAll(/await t\.test\("([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(capabilities, [
    "importazione, impostazioni e letture concorrenti",
    "mutazioni, raggruppamento e identità cliente",
    "pagamenti, riconciliazione storica e casi complessi",
    "rimborsi, concorrenza e proiezioni finali",
  ]);
  const offenders = [];
  for (const [file, maxBytes] of scenarioSizeCaps) {
    const size = (await stat(path.join(root, file))).size;
    if (size > maxBytes) offenders.push(`${file}: ${size} > ${maxBytes}`);
  }
  assert.deepEqual(offenders, []);
  assert.ok(
    [...scenarioSizeCaps.keys()]
      .filter((file) => file !== "src/db/orders.server.test.ts")
      .every((file) => file.endsWith(".test.ts")),
  );
  const excluded = JSON.parse(serverConfig).exclude;
  assert.ok(excluded.includes("**/*.test.ts"));
});

test("i percorsi legacy rimossi non restano esportabili né tornano come default", async () => {
  const [aruba, connectionModule, jobModule, webhookModule, migration] = await Promise.all([
    readFile(path.join(root, "src/db/aruba.server.ts"), "utf8"),
    readFile(path.join(root, "src/db/connector-connections.server.ts"), "utf8"),
    readFile(path.join(root, "src/db/connector-jobs.server.ts"), "utf8"),
    readFile(path.join(root, "src/db/connector-webhooks.server.ts"), "utf8"),
    readFile(path.join(root, "migrations/045_remove_aruba_browser_legacy.sql"), "utf8"),
  ]);
  const connectors = `${connectionModule}\n${jobModule}\n${webhookModule}`;
  assert.doesNotMatch(aruba, /export async function createArubaBatch\b/);
  assert.doesNotMatch(connectors, /export async function (?:completeHistoryImport|enqueueJob)\b/);
  assert.match(migration, /aruba_sync_sessions[\s\S]*source SET DEFAULT 'MANUAL'/);
  assert.match(migration, /aruba_batches[\s\S]*transport SET DEFAULT 'API'/);
  assert.match(migration, /aruba_submissions[\s\S]*transport SET DEFAULT 'API'/);
});

test("privacy e documentazione non regrediscono verso superfici indistinguibili o helper correnti", async () => {
  const [activity, masterPlan, retention] = await Promise.all([
    readFile(path.join(root, "app/components/activity-view.tsx"), "utf8"),
    readFile(path.join(root, "docs/Hub_Fatture_MASTER_PLAN.md"), "utf8"),
    readFile(path.join(root, "docs/contracts/retention-deletion.md"), "utf8"),
  ]);
  assert.match(activity, /privacyRequest\.externalEventId/);
  assert.match(activity, /privacyRequest\.customerIds\.join/);
  assert.match(activity, /privacyRequest\.orderIds\.join/);
  assert.doesNotMatch(
    masterPlan,
    /guida l'helper locale|pagina unica con navigazione interna[^\n]*Aruba e helper|`Fallback transitorio`|comunicazione HTTPS helper-HF|helper su account o batch errato/,
  );
  assert.doesNotMatch(retention, /Token helper Aruba/);
});

test("i moduli server del dominio hanno almeno un consumer runtime", async () => {
  const sourceRoots = ["app", "src", "scripts"];
  const sourceFiles = (
    await Promise.all(
      sourceRoots.map(async (directory) =>
        (await readdir(path.join(root, directory), { recursive: true, withFileTypes: true }))
          .filter(
            (entry) =>
              entry.isFile() &&
              /\.(?:ts|tsx|mjs)$/.test(entry.name) &&
              !entry.name.endsWith(".test.ts"),
          )
          .map((entry) => path.join(entry.parentPath, entry.name)),
      ),
    )
  ).flat();
  const sourceSet = new Set(sourceFiles);
  const incoming = new Map(sourceFiles.map((file) => [file, []]));
  for (const importer of sourceFiles) {
    const source = await readFile(importer, "utf8");
    for (const match of source.matchAll(/(?:from\s+|import\s*)["'](\.[^"']+)["']/g)) {
      const imported = path.resolve(path.dirname(importer), match[1]);
      if (sourceSet.has(imported)) incoming.get(imported).push(importer);
    }
  }
  const orphaned = sourceFiles
    .filter((file) => /\/src\/db\/[^/]+\.server\.ts$/.test(file))
    .filter((file) => incoming.get(file).length === 0)
    .map((file) => path.relative(root, file));
  assert.deepEqual(orphaned, []);
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
  const [routes, settings, inbound, manual, preflight, manifest, readme, transition] =
    await Promise.all([
      readFile(path.join(root, "app/routes.ts"), "utf8"),
      readFile(path.join(root, "app/routes/settings.server.ts"), "utf8"),
      readFile(path.join(root, "src/db/aruba-inbound.server.ts"), "utf8"),
      readFile(path.join(root, "src/db/aruba-manual-readback.server.ts"), "utf8"),
      readFile(path.join(root, "src/db/aruba-preflight.server.ts"), "utf8"),
      readFile(path.join(root, "package.json"), "utf8"),
      readFile(path.join(root, "README.md"), "utf8"),
      readFile(path.join(root, "docs/evidence/aruba-api-transition.md"), "utf8"),
    ]);
  const executable = `${routes}\n${settings}\n${inbound}\n${manual}\n${preflight}\n${manifest}`;
  assert.doesNotMatch(executable, /aruba-(?:ponte|sintetica|bookmarklet)/i);
  assert.doesNotMatch(executable, /api\/aruba\/(?:helper|sync)/i);
  assert.doesNotMatch(executable, /issueArubaReadSession|loadArubaReadSession/);
  assert.doesNotMatch(executable, /requestImmediateArubaSync/);
  const packageJson = JSON.parse(manifest);
  assert.equal(packageJson.scripts["aruba:sync"], undefined);
  assert.equal(packageJson.scripts["aruba:helper"], undefined);
  assert.doesNotMatch(readme, /aruba:helper|barra dei preferiti|ponte autenticato/i);
  assert.match(readme, /API Aruba v2 sono l.unico canale automatico/);
  assert.match(`${manual}\n${preflight}`, /request_json,\s*source, status,[\s\S]*'MANUAL'/);
  assert.match(transition, /nuovi readback manuali usano origine `MANUAL`/);
  const [major, minor] = packageJson.version.split(".").map(Number);
  assert.ok(
    major >= 1 || (major === 0 && minor >= 5),
    `treno pre-transizione: ${packageJson.version}`,
  );
});
