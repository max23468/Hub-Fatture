import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { classifyFiles } from "./change-impact.mjs";

const script = fileURLToPath(new URL("./change-impact.mjs", import.meta.url));

test("la documentazione resta nella corsia docs senza artefatto o deploy", () => {
  const impact = classifyFiles(["docs/runbooks/production.md", "README.md"]);
  assert.equal(impact.lane, "docs");
  assert.equal(impact.docsOnly, true);
  assert.equal(impact.runtime, false);
  assert.equal(impact.image, false);
});

test("la governance GitHub evita i gate applicativi ma conserva la dependency review", () => {
  const impact = classifyFiles([".github/workflows/ci.yml"]);
  assert.equal(impact.lane, "docs");
  assert.equal(impact.docsOnly, true);
  assert.equal(impact.standard, false);
  assert.equal(impact.dependencies, true);
  assert.equal(impact.securityData, false);
  assert.equal(impact.runtime, false);
});

test("una modifica a Foundation rigenera e verifica l'immagine", () => {
  const impact = classifyFiles([".github/workflows/foundation.yml"]);
  assert.equal(impact.lane, "standard");
  assert.equal(impact.docsOnly, false);
  assert.equal(impact.standard, true);
  assert.equal(impact.runtime, true);
  assert.equal(impact.image, true);
  assert.equal(impact.e2e, true);
  assert.equal(impact.e2eWebkit, false);
});

test("un candidato già distribuito non richiede alcun gate o deploy", () => {
  const impact = classifyFiles([]);
  assert.equal(impact.lane, "none");
  assert.equal(impact.standard, false);
  assert.equal(impact.runtime, false);
});

test("i test isolati non trasformano il candidato in runtime", () => {
  const impact = classifyFiles(["src/orders.test.ts", "tests/e2e/readiness.spec.ts"]);
  assert.equal(impact.testsOnly, true);
  assert.equal(impact.runtime, false);
  assert.equal(impact.e2e, true);
  assert.equal(impact.e2eWebkit, true);
});

test("UI e codice ordinario richiedono artefatto, E2E e React Doctor", () => {
  const impact = classifyFiles(["app/routes/home.tsx", "app/styles.css"]);
  assert.equal(impact.lane, "standard");
  assert.equal(impact.runtime, true);
  assert.equal(impact.image, true);
  assert.equal(impact.e2e, true);
  assert.equal(impact.e2eWebkit, true);
  assert.equal(impact.react, true);
});

test("i tsconfig che guidano la build server richiedono un nuovo artefatto", () => {
  const impact = classifyFiles(["tsconfig.json", "tsconfig.server.json"]);
  assert.equal(impact.runtime, true);
  assert.equal(impact.image, true);
  assert.equal(impact.e2e, true);
});

test("dockerignore è un input dell'immagine Production", () => {
  const impact = classifyFiles([".dockerignore"]);
  assert.equal(impact.runtime, true);
  assert.equal(impact.image, true);
  assert.equal(impact.e2e, true);
});

test("il Dockerfile applicativo attiva la corsia runtime e immagine completa", () => {
  const impact = classifyFiles(["Dockerfile"]);
  assert.equal(impact.lane, "deploy");
  assert.equal(impact.runtime, true);
  assert.equal(impact.image, true);
  assert.equal(impact.dependencies, true);
  assert.equal(impact.securityData, true);
  assert.equal(impact.deploy, true);
  assert.equal(impact.e2e, true);
});

test("migrazioni e storage attivano DB, sicurezza e backup aggiuntivo", () => {
  const impact = classifyFiles(["migrations/019_example.sql", "src/db/document-storage.server.ts"]);
  assert.equal(impact.lane, "deploy");
  assert.equal(impact.database, true);
  assert.equal(impact.securityData, true);
  assert.equal(impact.migrationStorage, true);
  assert.equal(impact.deploy, true);
  assert.equal(impact.e2eWebkit, false);
});

test("i connettori attivano contract test e corsia provider", () => {
  const impact = classifyFiles(["src/integrations/shopify.server.ts"]);
  assert.equal(impact.lane, "provider");
  assert.equal(impact.provider, true);
  assert.equal(impact.runtime, true);
  assert.equal(impact.e2e, true);
  assert.equal(impact.e2eWebkit, false);
});

test("l'helper Aruba limita la matrice multipiattaforma ai cambi pertinenti", () => {
  for (const file of [
    "scripts/aruba-helper.ts",
    "src/aruba-bookmarklet.ts",
    "app/routes/aruba-browser-session.ts",
    "scripts/aruba-read-helper.ts",
    "scripts/aruba-read-runner.ts",
    "scripts/aruba-download-limit.ts",
    "src/aruba.ts",
    "src/aruba-inbound.ts",
  ]) {
    const impact = classifyFiles([file]);
    assert.equal(impact.arubaPlatform, true, file);
    assert.equal(impact.provider, true, file);
    if (file.startsWith("scripts/")) assert.equal(impact.e2e, true, file);
  }
});

test("l'orchestrazione Aruba richiede sempre le ricevute multipiattaforma", () => {
  const impact = classifyFiles([".github/workflows/aruba-platform.yml"]);
  assert.equal(impact.arubaPlatform, true);
});

test("un percorso sconosciuto ricade fail-closed nel gate completo", () => {
  const impact = classifyFiles(["nuovo-sistema/config.custom"]);
  assert.equal(impact.failClosed, true);
  assert.deepEqual(impact.unknown, ["nuovo-sistema/config.custom"]);
  assert.equal(impact.runtime, true);
  assert.equal(impact.provider, true);
  assert.equal(impact.migrationStorage, true);
  assert.equal(impact.deploy, true);
});

test("le eliminazioni runtime restano nel calcolo dell'impatto Git", async (context) => {
  const repository = await mkdtemp(path.join(tmpdir(), "hub-fatture-impact-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  const git = (...arguments_) =>
    execFileSync("git", arguments_, { cwd: repository, encoding: "utf8" }).trim();

  git("init", "--quiet");
  git("config", "user.email", "tests@hub-fatture.invalid");
  git("config", "user.name", "Hub Fatture tests");
  await mkdir(path.join(repository, "app"));
  await writeFile(path.join(repository, "app", "removed.ts"), "export const removed = true;\n");
  git("add", "app/removed.ts");
  git("commit", "--quiet", "-m", "test: add runtime file");
  const base = git("rev-parse", "HEAD");
  await rm(path.join(repository, "app", "removed.ts"));
  git("commit", "--quiet", "-am", "test: remove runtime file");
  const head = git("rev-parse", "HEAD");

  const impact = JSON.parse(
    execFileSync(process.execPath, [script, base, head, "json"], {
      cwd: repository,
      encoding: "utf8",
    }),
  );
  assert.deepEqual(impact.files, ["app/removed.ts"]);
  assert.equal(impact.runtime, true);
  assert.equal(impact.image, true);
});

test("le rinomine da runtime espongono origine e destinazione", async (context) => {
  const repository = await mkdtemp(path.join(tmpdir(), "hub-fatture-impact-"));
  context.after(() => rm(repository, { recursive: true, force: true }));
  const git = (...arguments_) =>
    execFileSync("git", arguments_, { cwd: repository, encoding: "utf8" }).trim();

  git("init", "--quiet");
  git("config", "user.email", "tests@hub-fatture.invalid");
  git("config", "user.name", "Hub Fatture tests");
  await mkdir(path.join(repository, "app"));
  await writeFile(path.join(repository, "app", "renamed.ts"), "export const renamed = true;\n");
  git("add", "app/renamed.ts");
  git("commit", "--quiet", "-m", "test: add runtime file");
  const base = git("rev-parse", "HEAD");
  await mkdir(path.join(repository, "docs"));
  git("mv", "app/renamed.ts", "docs/renamed.md");
  git("commit", "--quiet", "-m", "test: rename runtime file");
  const head = git("rev-parse", "HEAD");

  const impact = JSON.parse(
    execFileSync(process.execPath, [script, base, head, "json"], {
      cwd: repository,
      encoding: "utf8",
    }),
  );
  assert.deepEqual(impact.files, ["app/renamed.ts", "docs/renamed.md"]);
  assert.equal(impact.runtime, true);
  assert.equal(impact.image, true);
});
