import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readRuntimeSources(directory) {
  const entries = await readdir(path.join(root, directory), {
    recursive: true,
    withFileTypes: true,
  });
  return Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name),
      )
      .map(async (entry) => {
        const file = path.join(entry.parentPath, entry.name);
        return {
          file: path.relative(root, file),
          source: await readFile(file, "utf8"),
        };
      }),
  );
}

async function reachableFiles(entry, candidates) {
  const reachable = new Set();
  async function visit(file) {
    if (reachable.has(file)) return;
    reachable.add(file);
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/(?:from\s+|import\s*)["'](\.[^"']+)["']/g)) {
      const imported = path.resolve(path.dirname(file), match[1]);
      if (candidates.has(imported)) await visit(imported);
    }
  }
  await visit(entry);
  return reachable;
}

test("le richieste leggono la proiezione e il worker la aggiorna fuori dalla navigazione", async () => {
  const [
    shell,
    rootRoute,
    routes,
    home,
    controlsRoute,
    controlsModule,
    searchModule,
    dashboardConnections,
    login,
    setup,
    motion,
    worker,
  ] = await Promise.all([
    readFile(path.join(root, "app/components/app-shell.tsx"), "utf8"),
    readFile(path.join(root, "app/root.tsx"), "utf8"),
    readFile(path.join(root, "app/routes.ts"), "utf8"),
    readFile(path.join(root, "app/routes/home.tsx"), "utf8"),
    readFile(path.join(root, "app/routes/controls.tsx"), "utf8"),
    readFile(path.join(root, "src/db/operational-controls.server.ts"), "utf8"),
    readFile(path.join(root, "src/db/search.server.ts"), "utf8"),
    readFile(path.join(root, "app/components/dashboard-connections.tsx"), "utf8"),
    readFile(path.join(root, "app/routes/login.tsx"), "utf8"),
    readFile(path.join(root, "app/routes/setup.tsx"), "utf8"),
    readFile(path.join(root, "app/styles/motion.css"), "utf8"),
    readFile(path.join(root, "src/worker.ts"), "utf8"),
  ]);
  assert.doesNotMatch(shell, /viewTransition/);
  assert.doesNotMatch(motion, /view-transition/);
  assert.match(shell, /<NavLink[\s\S]*?reloadDocument[\s\S]*?to=\{to\}/);
  assert.doesNotMatch(shell, /useNavigation|aria-busy|nav-item--pending/);
  assert.doesNotMatch(shell, /useFetcher|\/controlli\/riepilogo/);
  assert.match(shell, /useRouteLoaderData<typeof rootLoader>\("root"\)/);
  assert.match(rootRoute, /readOperationalControlSummary/);
  assert.doesNotMatch(rootRoute, /refreshOperationalControls/);
  assert.doesNotMatch(routes, /controlli\/riepilogo|controls-summary/);
  assert.match(home, /<Link[\s\S]*?reloadDocument[\s\S]*?to=\{item\.to\}/);
  assert.match(home, /readOperationalControlSummary/);
  assert.doesNotMatch(home, /getOperationalControlSummary/);
  assert.doesNotMatch(home, /refreshOperationalControls/);
  assert.doesNotMatch(home, /\/controlli\/riepilogo\?refresh=1/);
  assert.match(controlsRoute, /readOperationalControls/);
  assert.doesNotMatch(controlsRoute, /refreshOperationalControls/);
  assert.match(controlsModule, /export async function readOperationalControls/);
  assert.doesNotMatch(
    controlsModule,
    /export async function readOperationalControls[\s\S]*?await refreshOperationalControls\(\)/,
  );
  assert.doesNotMatch(searchModule, /refreshOperationalControls/);
  assert.match(dashboardConnections, /<Link[^>]*reloadDocument[^>]*to=\{to\}/);
  assert.match(login, /<Form[^>]*method="post"[^>]*reloadDocument/);
  assert.match(setup, /<Form[^>]*method="post"[^>]*reloadDocument/);
  assert.match(worker, /scheduleOperationalControlsRefresh\(\)/);
  assert.match(worker, /await refreshOperationalControls\(\)/);
  assert.match(worker, /await waitForOperationalControlsRefresh\(\)/);

  const runtimeRefreshConsumers = (
    await Promise.all([readRuntimeSources("app"), readRuntimeSources("src")])
  )
    .flat()
    .filter(({ source }) => source.includes("refreshOperationalControls"))
    .map(({ file }) => file)
    .sort();
  assert.deepEqual(runtimeRefreshConsumers, [
    "src/db/operational-controls.server.ts",
    "src/worker.ts",
  ]);
});

test("readiness e migrazioni restano partizionate senza perdere scenari", async () => {
  for (const [entry, directory, suffix] of [
    ["tests/e2e/readiness.spec.ts", "tests/e2e/readiness", ".ts"],
    ["src/db/migrations.server.test.ts", "src/db/migrations-scenarios", ".test.ts"],
  ]) {
    const files = new Set(
      (await readdir(path.join(root, directory), { withFileTypes: true }))
        .filter((item) => item.isFile() && item.name.endsWith(suffix))
        .map((item) => path.join(root, directory, item.name)),
    );
    const reachable = await reachableFiles(path.join(root, entry), files);
    const unexecuted = [];
    for (const file of files) {
      if ((await readFile(file, "utf8")).match(/^test\(/m) && !reachable.has(file)) {
        unexecuted.push(path.relative(root, file));
      }
    }
    assert.deepEqual(unexecuted, []);
  }
});

test("lo scenario PostgreSQL degli ordini resta partizionato per capacità", async () => {
  const [source, serverConfig, scenarioEntries] = await Promise.all([
    readFile(path.join(root, "src/db/orders.server.test.ts"), "utf8"),
    readFile(path.join(root, "tsconfig.server.json"), "utf8"),
    readdir(path.join(root, "src/db/orders-scenarios"), { withFileTypes: true }),
  ]);
  assert.match(source, /await t\.test\(/);
  const scenarios = new Set(
    scenarioEntries
      .filter((item) => item.isFile() && item.name.endsWith(".scenario.test.ts"))
      .map((item) => path.join(root, "src/db/orders-scenarios", item.name)),
  );
  const reachable = await reachableFiles(
    path.join(root, "src/db/orders.server.test.ts"),
    scenarios,
  );
  assert.deepEqual(
    [...scenarios].filter((file) => !reachable.has(file)).map((file) => path.relative(root, file)),
    [],
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
  const [activity, controls, operationalControls, masterPlan, retention] = await Promise.all([
    readFile(path.join(root, "app/components/activity-view.tsx"), "utf8"),
    readFile(path.join(root, "app/routes/controls.tsx"), "utf8"),
    readFile(path.join(root, "src/db/operational-controls.server.ts"), "utf8"),
    readFile(path.join(root, "docs/Hub_Fatture_MASTER_PLAN.md"), "utf8"),
    readFile(path.join(root, "docs/contracts/retention-deletion.md"), "utf8"),
  ]);
  assert.doesNotMatch(activity, /privacyRequest/);
  assert.match(operationalControls, /privacy\.externalEventId/);
  assert.match(operationalControls, /privacy\.customerIds\.join/);
  assert.match(operationalControls, /privacy\.orderIds\.join/);
  assert.match(controls, /metadata\.privacyEventId/);
  assert.match(controls, /name="externalEventId"/);
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
