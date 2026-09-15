import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { classifyFiles } from "./change-impact.mjs";
import { changelogSection } from "./prepare-production-release.mjs";

const command = (script) => ["npm", "run", script];

export function preflightPlan(impact) {
  const setup = [command("check:docs")];
  if (impact.securityData) setup.push(command("audit"));
  const core = impact.standard ? [command("check:standard")] : [];

  const parallel = [];
  if (impact.database) parallel.push(["env", "TEST_DATABASE_LANE=db", "npm", "run", "test:db"]);
  if (impact.provider) parallel.push(command("test:provider"));
  if (impact.e2e)
    parallel.push([
      "env",
      "TEST_DATABASE_LANE=e2e_chromium",
      "PLAYWRIGHT_BASE_URL=http://127.0.0.1:4173",
      "DOCUMENT_STORAGE_ROOT=storage/e2e-documents-chromium",
      "npm",
      "run",
      "test:e2e:chromium:prepared",
    ]);
  if (impact.e2eWebkit)
    parallel.push([
      "env",
      "TEST_DATABASE_LANE=e2e_webkit",
      "PLAYWRIGHT_BASE_URL=http://127.0.0.1:4174",
      "DOCUMENT_STORAGE_ROOT=storage/e2e-documents-webkit",
      "npm",
      "run",
      "test:e2e:webkit:prepared",
    ]);
  return { core, parallel, setup };
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

/** Come Foundation, controlla anche i commit rispetto alla base, non solo il working tree. */
export function diffCheckCommands(base) {
  return [
    ["git", "diff", "--check"],
    ["git", "diff", "--check", base, "HEAD"],
  ];
}

/** Riferimenti `uses:` soggetti alle Action consentite: esclusi quelli locali e `docker://`. */
export function workflowActionReferences(workflow) {
  return [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*["']?([^\s"'#]+)/gm)]
    .map(([, reference]) => reference)
    .filter((reference) => !reference.startsWith("./") && !reference.startsWith("docker://"));
}

const allowedPattern = (pattern) =>
  new RegExp(`^${pattern.split("*").map(RegExp.escape).join(".*")}$`, "i");

export function findDisallowedActions(references, permissions, selected) {
  const problems = [];
  for (const reference of new Set(references)) {
    const [path, ref = ""] = reference.split("@");
    if (permissions.sha_pinning_required && !/^[0-9a-f]{40}$/.test(ref)) {
      problems.push(`${reference}: non fissata a uno SHA completo`);
    }
    if (permissions.allowed_actions === "all") continue;
    const allowed =
      permissions.allowed_actions === "selected" &&
      ((selected.github_owned_allowed && /^(?:actions|github)\//i.test(path)) ||
        selected.patterns_allowed.some((pattern) => allowedPattern(pattern).test(reference)));
    if (!allowed)
      problems.push(`${reference}: non ammessa dalle Action consentite della repository`);
  }
  return problems;
}

function ghApi(endpoint) {
  const result = spawnSync("gh", ["api", endpoint], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `gh api ${endpoint} fallito`);
  return JSON.parse(result.stdout);
}

// Un'Action esclusa fa terminare il workflow in startup_failure: nessun job, nessun log e
// required check mai arrivato. Il GITHUB_TOKEN non legge queste impostazioni, quindi il
// confronto vive qui con le credenziali del titolare.
function verifyAllowedActions() {
  const directory = ".github/workflows";
  const references = readdirSync(directory)
    .filter((name) => /\.ya?ml$/.test(name))
    .flatMap((name) => workflowActionReferences(readFileSync(`${directory}/${name}`, "utf8")));
  const permissions = ghApi("repos/{owner}/{repo}/actions/permissions");
  const selected =
    permissions.allowed_actions === "selected"
      ? ghApi("repos/{owner}/{repo}/actions/permissions/selected-actions")
      : { github_owned_allowed: false, patterns_allowed: [] };
  const problems = findDisallowedActions(references, permissions, selected);
  if (problems.length > 0) {
    throw new Error(
      [
        "Action non eseguibili con le impostazioni GitHub correnti (startup_failure):",
        ...problems.map((problem) => `- ${problem}`),
        "Usa un riferimento ammesso oppure chiedi al proprietario di aggiornare le Action consentite.",
      ].join("\n"),
    );
  }
}

async function main(argv = process.argv.slice(2)) {
  const base = argv[0] ?? "origin/main";
  for (const [executable, ...args] of diffCheckCommands(base)) {
    const diffCheck = spawnSync(executable, args, { stdio: "inherit" });
    if (diffCheck.status !== 0) throw new Error(`${executable} ${args.join(" ")} non superato`);
  }

  const files = changedFiles(base);
  if (files.some((file) => file.startsWith(".github/workflows/"))) verifyAllowedActions();
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
    `Preflight ${impact.lane}: ${files.length} file, ${plan.setup.length + plan.core.length + plan.parallel.length} gate.\n`,
  );
  await Promise.all(plan.setup.map(run));
  for (const item of plan.core) await run(item);
  await Promise.all(plan.parallel.map(run));
  process.stdout.write("Preflight di pubblicazione completato.\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
