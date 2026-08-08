import assert from "node:assert/strict";
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
  const entries = await readdir(absolutePath, { withFileTypes: true });
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

test("la sigla interna non compare nel frontend", async () => {
  const files = await contents(await collect("app"));
  const offenders = files.filter(({ text }) => /\bHF\b/.test(text)).map(({ file }) => file);
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
  const italianDate =
    /\b\d{1,2} (?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre) 20\d{2}\b/i;
  const offenders = (await contents([...rootDocuments, ...docs]))
    .filter(({ text }) => italianDate.test(text))
    .map(({ file }) => file);
  assert.deepEqual(offenders, []);
});

test("il proxy locale resta accessibile soltanto dal Mac", async () => {
  const compose = await readFile(path.join(root, "compose.yaml"), "utf8");
  assert.match(compose, /"127\.0\.0\.1:8080:80"/);
});

test("lo stack Development mantiene nome e riavvio stabili", async () => {
  const compose = await readFile(path.join(root, "compose.yaml"), "utf8");
  assert.match(compose, /^name: hub-fatture-development$/m);
  assert.equal(compose.match(/^    restart: unless-stopped$/gm)?.length, 3);
});
