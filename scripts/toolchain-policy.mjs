import { readFile } from "node:fs/promises";
import process from "node:process";

const forbiddenName = /(^|[/@-])(eslint|prettier)([/@-]|$)/;

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

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const forbidden = findForbiddenPackages(manifest);

  if (forbidden.length > 0) {
    console.error(`Toolchain parallela non ammessa: ${forbidden.join(", ")}`);
    process.exitCode = 1;
  }
}
