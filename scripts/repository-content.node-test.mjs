import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const textExtensions = new Set([
  ".css",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

async function collect(relativePath) {
  const absolutePath = path.join(root, relativePath);
  // Una cartella nasce con la milestone che la usa: la sua assenza è uno zero, non un errore.
  const entries = await readdir(absolutePath, { withFileTypes: true }).catch(() => []);
  const files = [];

  for (const entry of entries) {
    const child = path.join(relativePath, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(child)));
    else if (textExtensions.has(path.extname(entry.name))) files.push(child);
  }

  return files;
}

async function contents(files) {
  return Promise.all(
    files.map(async (file) => ({ file, text: await readFile(path.join(root, file), "utf8") })),
  );
}

// `git grep` esce 0 con match, 1 senza match e 2 in errore: `!` in shell trasformerebbe
// anche l'errore in successo, quindi la guardia vive qui dove lo stato è ispezionabile.
function tracked(pattern) {
  const result = spawnSync("git", ["grep", "-nIE", pattern], { cwd: root, encoding: "utf8" });
  assert.equal(result.error, undefined);
  assert.ok(result.status === 0 || result.status === 1, `git grep fallito: ${result.stderr}`);
  return result.status === 0 ? result.stdout.trim().split("\n") : [];
}

test("nessuna chiave privata in chiaro è tracciata", () => {
  assert.deepEqual(tracked("BEGIN ([A-Z0-9 ]+ )?PRIVATE KEY"), []);
  const keys = spawnSync("git", ["ls-files", "*.key"], { cwd: root, encoding: "utf8" });
  assert.equal(keys.status, 0);
  assert.equal(keys.stdout.trim(), "");
});

test("nessun riferimento a nomi storici del Master Plan", () => {
  assert.deepEqual(tracked("Hub-Fatture-Master-Plan[.]md|docs/MASTER_PLAN[.]md"), []);
});

test("la policy Pubblica resta coerente nelle fonti canoniche", async () => {
  const [agents, masterPlan, glossary] = await Promise.all(
    ["AGENTS.md", "docs/Hub_Fatture_MASTER_PLAN.md", "docs/glossario.md"].map((file) =>
      readFile(path.join(root, file), "utf8"),
    ),
  );
  assert.match(agents, /richiesta affermativa di pubblicazione/);
  assert.match(agents, /P2\/P3 della review restano advisory e non autorizzano modifiche/);
  assert.match(masterPlan, /richiesta affermativa di pubblicazione autorizza (?:invece )?deploy/);
  assert.match(glossary, /\| Pubblica\s+\| ciclo tecnico completo\s+\|/);
});

test("la sigla interna non compare nella superficie utente", async () => {
  const files = [...(await collect("app")), "src/errors.ts", "src/db/auth.server.ts"];
  const offenders = (await contents(files))
    .filter(({ text }) => /\bhf\b/i.test(text))
    .map(({ file }) => file);
  assert.deepEqual(offenders, []);
});

test("il frontend usa Preparazione fattura al posto dei vecchi nomi", async () => {
  const files = await contents(await collect("app"));
  const offenders = files
    .filter(({ text }) => /\b(?:Scheda|Schede|Pratica|Pratiche)\b/.test(text))
    .map(({ file }) => file);
  assert.deepEqual(offenders, []);
});

test("le sigle della roadmap restano fuori da codice e documenti operativi", async () => {
  const roots = ["app", "src", "tests", "scripts", ".github/workflows", "docs"];
  const files = (await Promise.all(roots.map(collect)))
    .flat()
    .filter((file) => file !== "docs/Hub_Fatture_MASTER_PLAN.md");
  const offenders = (await contents(files))
    .filter(({ text }) => /\bM\d+(?:-M\d+)?\b/.test(text))
    .map(({ file }) => file);
  assert.deepEqual(offenders, []);
});

test("i documenti evergreen non duplicano date di avanzamento", async () => {
  const rootDocuments = [
    "AGENTS.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "README.md",
    "SECURITY.md",
  ];
  const docs = (await collect("docs")).filter(
    (file) => !file.startsWith("docs/evidence/") && file !== "docs/Hub_Fatture_MASTER_PLAN.md",
  );
  const dates = [
    /\b\d{1,2} (?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre) 20\d{2}\b/i,
    /\b20\d{2}-\d{2}-\d{2}\b/,
  ];
  const offenders = (await contents([...rootDocuments, ...docs]))
    .filter(({ text }) => dates.some((date) => date.test(text)))
    .map(({ file }) => file);
  assert.deepEqual(offenders, []);
});

test("le fixture usano soltanto host sintetici .invalid", async () => {
  const offenders = (await contents(await collect("tests/fixtures"))).flatMap(({ file, text }) =>
    [...text.matchAll(/(?:@|https?:\/\/)([a-z0-9.-]+\.[a-z]{2,})/gi)]
      .filter(([, host]) => !host.endsWith(".invalid"))
      .map(([, host]) => `${file}: ${host}`),
  );
  assert.deepEqual(offenders, []);
});

test("il proxy locale resta accessibile soltanto dal Mac", async () => {
  const compose = await readFile(path.join(root, "compose.yaml"), "utf8");
  assert.match(compose, /"127\.0\.0\.1:8080:80"/);
  assert.match(compose, /"127\.0\.0\.1:5432:5432"/);
});

test("Shopify CLI riusa database e chiave dello stack Development", async () => {
  const [script, manifest] = await Promise.all(
    ["scripts/development.sh", "package.json"].map((file) =>
      readFile(path.join(root, file), "utf8"),
    ),
  );
  assert.match(script, /Hub Fatture Development Encryption/);
  assert.match(script, /127\.0\.0\.1:5432\/hub_fatture/);
  assert.match(script, /syncbay-dev\.myshopify\.com/);
  assert.match(script, /shopify app dev/);
  assert.match(manifest, /"@shopify\/cli": "4\.6\.0"/);
});

test("lo stack Development mantiene nome e riavvio stabili", async () => {
  const [compose, script] = await Promise.all(
    ["compose.yaml", "scripts/development.sh"].map((file) =>
      readFile(path.join(root, file), "utf8"),
    ),
  );
  assert.match(compose, /^name: hub-fatture-development$/m);
  assert.equal(compose.match(/^    restart: unless-stopped$/gm)?.length, 4);
  assert.match(compose, /- app_node_modules:\/workspace\/node_modules/);
  assert.match(compose, /- worker_node_modules:\/workspace\/node_modules/);
  assert.match(compose, /- worker_build_server:\/workspace\/build-server/);
  assert.match(script, /docker compose up -d --build --wait app app-worker caddy/);
});

test("i webhook Shopify sono dichiarati nella configurazione dell'app", async () => {
  const [config, connector] = await Promise.all(
    ["shopify.app.toml", "src/integrations/shopify.server.ts"].map((file) =>
      readFile(path.join(root, file), "utf8"),
    ),
  );
  for (const topic of [
    "app/uninstalled",
    "customers/data_request",
    "customers/redact",
    "fulfillments/create",
    "fulfillments/update",
    "orders/cancelled",
    "orders/create",
    "orders/paid",
    "orders/updated",
    "refunds/create",
    "shop/redact",
  ]) {
    assert.match(config, new RegExp(`"${topic}"`));
  }
  assert.match(config, /scopes = "read_customers,read_fulfillments,read_orders"/);
  assert.match(
    connector,
    /SHOPIFY_SCOPES = \["read_orders", "read_customers", "read_fulfillments"\]/,
  );
  assert.doesNotMatch(connector, /webhooks\.register/);
});

test("l'applicazione accede a PostgreSQL soltanto tramite il livello dati", async () => {
  const files = [
    ...(await collect("app")),
    ...(await collect("src")).filter((file) => !file.startsWith("src/db/")),
  ];
  const offenders = (await contents(files))
    .filter(({ text }) =>
      /import\s*\{[^}]*\b(?:getPool|withTransaction)\b[^}]*\}\s*from\s*["'][^"']*db\/client\.server|from ["']pg["']/.test(
        text,
      ),
    )
    .map(({ file }) => file);
  assert.deepEqual(offenders, []);
});
