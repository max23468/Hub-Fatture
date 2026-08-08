import { readFile } from "node:fs/promises";
import process from "node:process";

import { isDirectExecution } from "./direct-execution.mjs";

const forbiddenName = /(^|[/@-])(eslint|prettier|jest|vitest|mocha|ava|biome|dprint)([/@-]|$)/;

// Strumenti di build che non devono mai entrare nella chiusura di produzione.
// `typescript` e `@typescript/*` sono l'unica eccezione nota: `@react-router/node`
// li dichiara come peer dependency opzionale, quindi npm li marca non-dev anche se
// il progetto li usa soltanto per typecheck e compilazione del runner.
// ponytail: allowlist statica; l'immagine Production li rimuove nel layer finale.
const productionToolAllowlist = /^(typescript|@typescript\/)/;
const forbiddenInProduction =
  /^(vite|@react-router\/dev|@playwright\/|oxlint|oxfmt|react-doctor|typescript|@typescript\/)/;

export function findForbiddenPackages(manifest) {
  const sections = [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ];

  return sections
    .flatMap((section) => Object.keys(section ?? {}))
    .filter((name) => forbiddenName.test(name));
}

export function findRuntimePins(manifest, mise, dockerfile) {
  return {
    node: [
      manifest.engines?.node,
      mise.match(/^node\s*=\s*"([^"]+)"/m)?.[1],
      dockerfile.match(/^FROM node:([\d.]+)-/m)?.[1],
    ],
    npm: [
      manifest.engines?.npm,
      manifest.packageManager?.replace(/^npm@/, ""),
      mise.match(/^npm\s*=\s*"([^"]+)"/m)?.[1],
      dockerfile.match(/npm install --global npm@([\d.]+)/)?.[1],
    ],
  };
}

export function findPinDrift(pins) {
  return Object.entries(pins)
    .filter(([, values]) => new Set(values).size !== 1 || values.some((value) => !value))
    .map(([tool, values]) => `${tool}: ${values.map((value) => value ?? "assente").join(" != ")}`);
}

// Dependabot aggiorna Compose e Dockerfile ma non le immagini dei `services:` nei
// workflow: senza questo confronto la CI resterebbe indietro in silenzio.
export function findImageDrift(compose, ci) {
  const references = (text) =>
    [...text.matchAll(/image: (postgres:\S+)/g)].map(([, image]) => image);
  const all = [...references(compose), ...references(ci)];
  return new Set(all).size === 1 ? [] : [`postgres: ${[...new Set(all)].join(" != ")}`];
}

export function findProductionBuildTools(lockfile) {
  return Object.entries(lockfile.packages ?? {})
    .filter(([name, node]) => name.startsWith("node_modules/") && !node.dev)
    .map(([name]) => name.slice(name.lastIndexOf("node_modules/") + "node_modules/".length))
    .filter((name) => forbiddenInProduction.test(name) && !productionToolAllowlist.test(name));
}

if (isDirectExecution(import.meta.url)) {
  const read = async (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
  const manifest = JSON.parse(await read("package.json"));
  const lockfile = JSON.parse(await read("package-lock.json"));
  const problems = [];

  const forbidden = findForbiddenPackages(manifest);
  if (forbidden.length > 0)
    problems.push(`Toolchain parallela non ammessa: ${forbidden.join(", ")}`);

  const drift = findPinDrift(
    findRuntimePins(manifest, await read("mise.toml"), await read("Dockerfile")),
  );
  if (drift.length > 0) problems.push(`Pin runtime divergenti: ${drift.join("; ")}`);

  const images = findImageDrift(await read("compose.yaml"), await read(".github/workflows/ci.yml"));
  if (images.length > 0)
    problems.push(`Immagini divergenti fra Compose e CI: ${images.join("; ")}`);

  const buildTools = findProductionBuildTools(lockfile);
  if (buildTools.length > 0)
    problems.push(`Strumenti di build nella chiusura di produzione: ${buildTools.join(", ")}`);

  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exitCode = 1;
  }
}
