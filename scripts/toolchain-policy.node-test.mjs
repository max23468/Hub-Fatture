import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import {
  findForbiddenPackages,
  findImageDrift,
  findPinDrift,
  findProductionBuildTools,
  findRuntimePins,
} from "./toolchain-policy.mjs";

const read = async (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("blocca toolchain e runner paralleli in ogni sezione", () => {
  assert.deepEqual(
    findForbiddenPackages({
      dependencies: { eslint: "1", "@typescript-eslint/parser": "1" },
      devDependencies: {
        prettier: "1",
        "prettier-plugin-example": "1",
        vitest: "1",
        biome: "1",
        oxlint: "1",
        "lucide-react": "1",
      },
    }),
    [
      "eslint",
      "@typescript-eslint/parser",
      "prettier",
      "prettier-plugin-example",
      "vitest",
      "biome",
    ],
  );
});

test("i pin di Node e npm coincidono in manifest, mise e Dockerfile", async () => {
  const pins = findRuntimePins(
    JSON.parse(await read("package.json")),
    await read("mise.toml"),
    await read("Dockerfile"),
  );
  assert.deepEqual(findPinDrift(pins), []);
});

// Il gate Codex canonico usa solo stdlib ed è autocollaudato; i workflow applicativi
// che eseguono Node devono invece installare il runtime di progetto pinzato.
test("i workflow che eseguono Node installano prima il runtime pinzato", async () => {
  const directory = new URL("../.github/workflows/", import.meta.url);
  const workflows = (await readdir(directory)).filter((name) => name.endsWith(".yml"));
  assert.ok(workflows.length > 0, "nessun workflow trovato");

  for (const workflow of workflows) {
    if (workflow === "codex-review-gate.yml") continue;
    const text = await read(`.github/workflows/${workflow}`);
    const usesNode = text.search(/^\s+(?:- )?(?:run: )?(?:\|\s*)?[^\n]*\bnode /m);
    if (usesNode === -1) continue;
    const installsRuntime = text.indexOf("uses: jdx/mise-action@");
    assert.ok(
      installsRuntime !== -1 && installsRuntime < usesNode,
      `${workflow}: esegue node senza installare prima il runtime pinzato`,
    );
  }
});

test("React Doctor blocca warning ed errori con versione e Action pinzate", async () => {
  const manifest = JSON.parse(await read("package.json"));
  const workflow = await read(".github/workflows/react-doctor.yml");

  assert.equal(manifest.scripts.doctor, "react-doctor --scope full --blocking warning .");
  assert.match(workflow, /millionco\/react-doctor@[0-9a-f]{40}\b/);
  assert.match(workflow, /version:\s*latest/);
  assert.match(workflow, /scope:.*github\.event_name == 'pull_request'.*'changed'.*'full'/);
  assert.match(workflow, /blocking:\s*warning/);
  assert.match(workflow, /comment:\s*"false"/);
  assert.match(workflow, /review-comments:\s*"true"/);
  assert.match(workflow, /commit-status:\s*"false"/);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.doesNotMatch(workflow, /continue-on-error/);
});

test("Dependabot auto-unisce soltanto minor e patch npm e GitHub Actions", async () => {
  const [config, workflow] = await Promise.all([
    read(".github/dependabot.yml"),
    read(".github/workflows/dependabot-automerge.yml"),
  ]);

  assert.match(config, /npm-minor-patch:[\s\S]*update-types:\s*\n\s*- minor\s*\n\s*- patch/);
  assert.match(config, /actions-minor-patch:[\s\S]*update-types:\s*\n\s*- minor\s*\n\s*- patch/);
  assert.match(workflow, /package-ecosystem == 'npm'/);
  assert.match(workflow, /package-ecosystem == 'github-actions'/);
  assert.match(workflow, /version-update:semver-patch/);
  assert.match(workflow, /version-update:semver-minor/);
  assert.match(workflow, /head\.repo\.full_name == github\.repository/);
  assert.match(workflow, /--match-head-commit "\$HEAD_SHA"/);
  assert.doesNotMatch(workflow, /actions\/checkout|npm ci/);
});

test("una patch divergente viene segnalata", () => {
  assert.deepEqual(findPinDrift({ node: ["26.7.0", "26.7.1"], npm: ["12.0.2", "12.0.2"] }), [
    "node: 26.7.0 != 26.7.1",
  ]);
  assert.deepEqual(findPinDrift({ node: ["26.7.0", undefined] }), ["node: 26.7.0 != assente"]);
});

test("l'immagine PostgreSQL coincide fra Compose e CI", async () => {
  assert.deepEqual(
    findImageDrift(await read("compose.yaml"), await read(".github/workflows/ci.yml")),
    [],
  );
  assert.deepEqual(
    findImageDrift("    image: postgres:18.4@sha256:aa", "        image: postgres:18.3@sha256:bb"),
    ["postgres: postgres:18.4@sha256:aa != postgres:18.3@sha256:bb"],
  );
});

test("un riferimento assente o non riconosciuto non vale come accordo", () => {
  assert.deepEqual(findImageDrift("    image: postgres:18.4@sha256:aa", "services: {}"), [
    "postgres: riferimento assente in ci.yml",
  ]);
  assert.deepEqual(findImageDrift("services: {}", "    image: postgres:18.4@sha256:aa"), [
    "postgres: riferimento assente in compose.yaml",
  ]);
  assert.deepEqual(findImageDrift("services: {}", "services: {}"), [
    "postgres: riferimento assente in compose.yaml, ci.yml",
  ]);
  // La forma quotata è YAML valido: va riconosciuta, non trattata come assente.
  assert.deepEqual(
    findImageDrift('    image: "postgres:18.4@sha256:aa"', "    image: postgres:18.4@sha256:aa"),
    [],
  );
});

test("nessuno strumento di build oltre l'eccezione TypeScript resta in produzione", async () => {
  assert.deepEqual(findProductionBuildTools(JSON.parse(await read("package-lock.json"))), []);
  assert.deepEqual(
    findProductionBuildTools({
      packages: { "node_modules/vite": {}, "node_modules/oxlint": { dev: true } },
    }),
    ["vite"],
  );
});
