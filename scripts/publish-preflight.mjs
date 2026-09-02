import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { classifyFiles } from "./change-impact.mjs";
import { changelogSection } from "./prepare-production-release.mjs";

const command = (script) => ["npm", "run", script];

export function preflightPlan(impact) {
  const core = [command("check:docs")];
  if (impact.standard) core.push(command("check:standard"));

  const parallel = [];
  if (impact.securityData) parallel.push(command("audit"));
  if (impact.database) parallel.push(command("test:db"));
  if (impact.provider) parallel.push(command("test:provider"));

  const browser = [];
  if (impact.e2e) browser.push(command("test:e2e:chromium"));
  if (impact.e2eWebkit) browser.push(command("test:e2e:webkit"));
  return { browser, core, parallel };
}

export function classifyPreflightFiles(files) {
  return classifyFiles(
    files.includes("scripts/change-impact.mjs")
      ? [...files, "__change-impact-authority-must-fail-closed__"]
      : files,
  );
}

function versionParts(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Versione ${version} non valida`);
  return version.split(".").map(Number);
}

export function validateReleaseMetadata({
  baseVersion,
  changelog,
  lockVersion,
  releaseTagExists = false,
  rootLockVersion,
  version,
}) {
  const current = versionParts(version);
  const base = versionParts(baseVersion);
  if (lockVersion !== version || rootLockVersion !== version) {
    throw new Error(`Versione ${version} non allineata in package-lock.json`);
  }
  const incrementsBase = current.some(
    (part, index) =>
      part > base[index] && current.slice(0, index).every((value, i) => value === base[i]),
  );
  if (releaseTagExists) {
    throw new Error(`La versione runtime ${version} è già pubblicata`);
  }
  const replacesUnpublishedCandidate = version === baseVersion;
  if (!incrementsBase && !replacesUnpublishedCandidate) {
    throw new Error(`La versione runtime ${version} non incrementa ${baseVersion}`);
  }
  changelogSection(changelog, version);
}

function gitLines(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} fallito`);
  return result.stdout.split("\n").filter(Boolean);
}

export function changedFiles(base = "origin/main") {
  gitLines(["rev-parse", "--verify", `${base}^{commit}`]);
  return [
    ...new Set([
      ...gitLines(["diff", "--name-only", "--no-renames", "--diff-filter=ACDMRTUXB", base, "--"]),
      ...gitLines(["ls-files", "--others", "--exclude-standard"]),
    ]),
  ].sort();
}

function run([executable, ...args]) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${executable} ${args.join(" ")} terminato con ${signal ?? code}`));
    });
  });
}

async function main(argv = process.argv.slice(2)) {
  const base = argv[0] ?? "origin/main";
  const diffCheck = spawnSync("git", ["diff", "--check"], { stdio: "inherit" });
  if (diffCheck.status !== 0) throw new Error("git diff --check non superato");

  const files = changedFiles(base);
  const impact = classifyPreflightFiles(files);
  if (impact.runtime) {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    const basePackage = JSON.parse(gitLines(["show", `${base}:package.json`]).join("\n"));
    const releaseTag = `refs/tags/v${packageJson.version}`;
    const remoteTag = spawnSync(
      "git",
      ["ls-remote", "--exit-code", "--tags", "origin", releaseTag],
      {
        encoding: "utf8",
      },
    );
    if (![0, 2].includes(remoteTag.status ?? -1)) {
      throw new Error(remoteTag.stderr.trim() || `Verifica tag remoto ${releaseTag} fallita`);
    }
    validateReleaseMetadata({
      baseVersion: basePackage.version,
      changelog: readFileSync("CHANGELOG.md", "utf8"),
      lockVersion: packageLock.version,
      releaseTagExists: remoteTag.status === 0,
      rootLockVersion: packageLock.packages?.[""]?.version,
      version: packageJson.version,
    });
  }
  const plan = preflightPlan(impact);
  process.stdout.write(
    `Preflight ${impact.lane}: ${files.length} file, ${plan.core.length + plan.parallel.length + plan.browser.length} gate.\n`,
  );
  for (const item of plan.core) await run(item);
  await Promise.all(plan.parallel.map(run));
  for (const item of plan.browser) await run(item);
  process.stdout.write("Preflight di pubblicazione completato.\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
