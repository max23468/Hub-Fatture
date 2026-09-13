import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const shaPattern = /^[0-9a-f]{40}$/;
const conventionalPattern =
  /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([a-z0-9 /_-]+\))?!?: .+/;

function exec(command, args, options = {}) {
  const output = execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  return typeof output === "string" ? output.trim() : "";
}

function ghJson(args) {
  const output = exec("gh", args);
  return output ? JSON.parse(output) : null;
}

export function queuedTooLong(run, now = Date.now(), thresholdMs = 300_000) {
  return run.status === "queued" && now - Date.parse(run.created_at) >= thresholdMs;
}

export function publicationPlan({ branch, head, title }) {
  return [
    `preflight locale per ${head.slice(0, 12)}`,
    `push di ${branch}`,
    `PR con titolo: ${title}`,
    "auto-merge squash vincolato all'HEAD esatto",
    "dispatch Production immediato sullo SHA di main",
    "attesa di gate, deploy, release e ricevuta live exact-SHA",
    "pulizia del branch e del worktree assorbiti",
  ];
}

export function worktrees(porcelain) {
  return porcelain
    .trim()
    .split("\n\n")
    .map((block) =>
      Object.fromEntries(
        block.split("\n").map((line) => {
          const separator = line.indexOf(" ");
          return separator < 0
            ? [line, true]
            : [line.slice(0, separator), line.slice(separator + 1)];
        }),
      ),
    );
}

function queueHealth() {
  const runs = ghJson([
    "run",
    "list",
    "--limit",
    "100",
    "--json",
    "databaseId,name,status,createdAt,url,headSha",
  ]).map((run) => ({ ...run, created_at: run.createdAt }));
  const stale = runs.filter((run) => queuedTooLong(run));
  const pulls = ghJson(["pr", "list", "--state", "open", "--json", "number,title,headRefName,url"]);
  if (stale.length === 0)
    process.stdout.write("Coda GitHub: nessuna esecuzione in attesa da oltre 5 minuti.\n");
  for (const run of stale) {
    const minutes = Math.floor((Date.now() - Date.parse(run.createdAt)) / 60_000);
    process.stdout.write(
      `ALLARME CODA: ${run.name} #${run.databaseId} attende da ${minutes} minuti: ${run.url}\n`,
    );
  }
  if (pulls.length > 0) {
    process.stdout.write(
      `PR aperte da valutare per lo stesso candidato: ${pulls.map((pull) => `#${pull.number} ${pull.headRefName}`).join(", ")}\n`,
    );
  }
  return stale.length === 0;
}

async function waitForMerge(number, expectedHead) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const pull = ghJson([
      "pr",
      "view",
      String(number),
      "--json",
      "state,headRefOid,mergeCommit,url",
    ]);
    if (pull.headRefOid !== expectedHead)
      throw new Error("L'HEAD della PR è cambiato durante la pubblicazione");
    if (pull.state === "MERGED") {
      const mergeSha = pull.mergeCommit?.oid;
      if (!shaPattern.test(mergeSha ?? "")) throw new Error("SHA di merge non disponibile");
      return mergeSha;
    }
    if (attempt > 0 && attempt % 30 === 0) queueHealth();
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error("La PR non è stata unita entro 30 minuti");
}

async function waitForProduction(commit) {
  let run;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const runs = ghJson([
      "run",
      "list",
      "--workflow",
      "Production",
      "--limit",
      "20",
      "--json",
      "databaseId,displayTitle,status,conclusion,url",
    ]);
    run = runs.find((entry) => entry.displayTitle === `Production ${commit}`);
    if (run?.status === "completed") break;
    if (attempt > 0 && attempt % 30 === 0) queueHealth();
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  if (!run || run.conclusion !== "success")
    throw new Error(`Production non conclusa con successo per ${commit}`);
  const version = JSON.parse(readFileSync("package.json", "utf8")).version;
  const release = ghJson([
    "release",
    "view",
    `v${version}`,
    "--json",
    "tagName,targetCommitish,url",
  ]);
  if (release.targetCommitish !== commit)
    throw new Error("La GitHub Release non punta al commit distribuito");
  const deployments = ghJson([
    "api",
    `repos/{owner}/{repo}/deployments?sha=${commit}&environment=Production`,
  ]);
  if (!Array.isArray(deployments) || deployments.length === 0)
    throw new Error("Deployment exact-SHA assente");
  process.stdout.write(`Production verificata: ${run.url}\nRelease verificata: ${release.url}\n`);
}

async function executePublication({ branch, head, title }) {
  if (exec("git", ["status", "--porcelain"]))
    throw new Error("Il worktree deve essere pulito prima della pubblicazione");
  exec("npm", ["run", "publish:preflight"], { stdio: "inherit" });
  exec("git", ["push", "--set-upstream", "origin", branch], { stdio: "inherit" });
  let pull = ghJson([
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "open",
    "--json",
    "number,headRefOid",
  ])[0];
  if (!pull) {
    const url = exec("gh", [
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      branch,
      "--title",
      title,
      "--fill",
    ]);
    pull = ghJson(["pr", "view", url, "--json", "number,headRefOid"]);
  }
  if (pull.headRefOid !== head) throw new Error("La PR non punta all'HEAD verificato");
  exec("gh", ["pr", "edit", String(pull.number), "--title", title]);
  exec("gh", [
    "pr",
    "merge",
    String(pull.number),
    "--auto",
    "--squash",
    "--match-head-commit",
    head,
  ]);
  const mergeSha = await waitForMerge(pull.number, head);
  exec("sh", ["scripts/dispatch-production.sh", mergeSha], { stdio: "inherit" });
  await waitForProduction(mergeSha);
  const trees = worktrees(exec("git", ["worktree", "list", "--porcelain"]));
  const main = trees.find((tree) => tree.branch === "refs/heads/main")?.worktree;
  if (!main) throw new Error("Checkout pulito di main non trovato per la chiusura");
  exec("git", ["status", "--porcelain"], { cwd: main });
  exec("node", ["scripts/publish-close.mjs", branch, process.cwd()], {
    cwd: main,
    stdio: "inherit",
  });
}

export async function run(argv = process.argv.slice(2)) {
  if (argv.includes("--queue-health")) {
    queueHealth();
    if (!argv.includes("--execute")) return;
  }
  const branch = exec("git", ["branch", "--show-current"]);
  const head = exec("git", ["rev-parse", "HEAD"]);
  const title = exec("git", ["log", "-1", "--pretty=%s"]);
  if (!branch || branch === "main")
    throw new Error("La pubblicazione richiede un branch temporaneo");
  if (!shaPattern.test(head) || !conventionalPattern.test(title))
    throw new Error("HEAD o titolo Conventional Commit non validi");
  process.stdout.write(
    `${publicationPlan({ branch, head, title })
      .map((step, index) => `${index + 1}. ${step}`)
      .join("\n")}\n`,
  );
  queueHealth();
  if (!argv.includes("--execute")) {
    process.stdout.write(
      "Piano soltanto. Usa --execute esclusivamente dentro un ciclo Pubblica autorizzato.\n",
    );
    return;
  }
  await executePublication({ branch, head, title });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
