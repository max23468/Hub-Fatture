import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("i workflow Node installano il runtime pinzato prima di eseguire script", async () => {
  for (const workflow of ["foundation.yml", "codex-review-gate.yml"]) {
    assert.match(
      await read(`.github/workflows/${workflow}`),
      /uses: jdx\/mise-action@[\s\S]*run: (?:\|\s*)?node /,
      workflow,
    );
  }
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
