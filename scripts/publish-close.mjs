import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";

const [branch, worktreePath] = process.argv.slice(2);

if (!branch || !worktreePath || process.argv.length !== 4) {
  console.error("Uso: node scripts/publish-close.mjs <branch-temporaneo> <percorso-worktree>");
  process.exit(2);
}

const baseBranch = "main";
const remote = "origin";

function run(command, args, options = {}) {
  const output = execFileSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
  return output?.trim() ?? "";
}

function succeeds(command, args, options = {}) {
  return (
    spawnSync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: "pipe",
    }).status === 0
  );
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseWorktrees(value) {
  return value
    .split("\n\n")
    .filter(Boolean)
    .map((record) => {
      const fields = Object.fromEntries(
        record.split("\n").map((line) => {
          const separator = line.indexOf(" ");
          return separator === -1
            ? [line, true]
            : [line.slice(0, separator), line.slice(separator + 1)];
        }),
      );
      return {
        path: fields.worktree,
        branch: fields.branch ?? null,
        detached: fields.detached === true,
      };
    });
}

function inventory(root) {
  const worktrees = parseWorktrees(run("git", ["worktree", "list", "--porcelain"], { cwd: root }));
  const branches = run("git", ["branch", "--format=%(refname:short)"], { cwd: root })
    .split("\n")
    .filter((name) => name && name !== baseBranch);
  const stashes = run("git", ["stash", "list", "--format=%gd %h %s"], { cwd: root })
    .split("\n")
    .filter(Boolean);
  return { worktrees, branches, stashes };
}

function printItems(label, items) {
  console.log(`${label}:`);
  if (items.length === 0) {
    console.log("  - nessuno");
    return;
  }
  for (const item of items) console.log(`  - ${item}`);
}

if (!path.isAbsolute(worktreePath)) fail("Il percorso del worktree deve essere assoluto.");

const root = realpathSync(run("git", ["rev-parse", "--show-toplevel"]));
let target;
try {
  target = realpathSync(worktreePath);
} catch {
  fail("Il percorso indicato non esiste: nessun elemento è stato rimosso.");
}
const currentBranch = run("git", ["symbolic-ref", "--short", "HEAD"], { cwd: root });

if (currentBranch !== baseBranch) {
  fail(`Eseguire la chiusura dal worktree pulito di ${baseBranch}, non da ${currentBranch}.`);
}
if (
  branch === baseBranch ||
  !succeeds("git", ["check-ref-format", "--branch", branch], { cwd: root })
) {
  fail("Il branch temporaneo indicato non è valido.");
}
if (target === root) fail("Il worktree temporaneo non può coincidere con il checkout principale.");
if (run("git", ["status", "--porcelain"], { cwd: root })) {
  fail(`Il checkout ${baseBranch} contiene modifiche locali: chiusura interrotta.`);
}

const worktreesBefore = parseWorktrees(
  run("git", ["worktree", "list", "--porcelain"], { cwd: root }),
);
const targetRecord = worktreesBefore.find((entry) => realpathSync(entry.path) === target);
if (!targetRecord) fail("Il percorso indicato non è un worktree registrato in questa repository.");
if (targetRecord.branch !== `refs/heads/${branch}`) {
  fail(
    `Il worktree indicato appartiene a ${targetRecord.branch ?? "HEAD detached"}, non a ${branch}.`,
  );
}
if (run("git", ["status", "--porcelain"], { cwd: target })) {
  fail(`Il worktree di ${branch} contiene modifiche locali: nessun elemento è stato rimosso.`);
}

const featureSha = run("git", ["rev-parse", `refs/heads/${branch}`], { cwd: root });
run("git", ["fetch", remote, "--prune"], { cwd: root, stdio: "inherit" });
const remoteBase = run("git", ["rev-parse", `${remote}/${baseBranch}`], { cwd: root });

let pullRequests;
try {
  pullRequests = JSON.parse(
    run(
      "gh",
      [
        "pr",
        "list",
        "--state",
        "merged",
        "--head",
        branch,
        "--base",
        baseBranch,
        "--limit",
        "100",
        "--json",
        "number,headRefName,headRefOid,baseRefName,mergeCommit",
      ],
      { cwd: root },
    ),
  );
} catch {
  fail("Impossibile rileggere le PR unite da GitHub: nessun elemento è stato rimosso.");
}

const matchingPullRequests = pullRequests.filter(
  (pullRequest) =>
    pullRequest.headRefName === branch &&
    pullRequest.baseRefName === baseBranch &&
    pullRequest.headRefOid === featureSha &&
    pullRequest.mergeCommit?.oid,
);
if (matchingPullRequests.length !== 1) {
  fail("Non esiste una sola PR unita che corrisponda esattamente all'HEAD del branch temporaneo.");
}

const pullRequest = matchingPullRequests[0];
if (
  !succeeds(
    "git",
    ["merge-base", "--is-ancestor", pullRequest.mergeCommit.oid, `${remote}/${baseBranch}`],
    {
      cwd: root,
    },
  )
) {
  fail(
    `Il merge della PR #${pullRequest.number} non appartiene alla linea corrente di ${remote}/${baseBranch}.`,
  );
}
if (
  !succeeds("git", ["merge-base", "--is-ancestor", "HEAD", `${remote}/${baseBranch}`], {
    cwd: root,
  })
) {
  fail(
    `Il checkout ${baseBranch} non può essere allineato in fast-forward a ${remote}/${baseBranch}.`,
  );
}

const remoteBranch = run("git", ["ls-remote", "--heads", remote, `refs/heads/${branch}`], {
  cwd: root,
});
if (remoteBranch && remoteBranch.split(/\s+/)[0] !== featureSha) {
  fail("Il branch remoto è avanzato dopo la PR unita: chiusura interrotta.");
}

run("git", ["merge", "--ff-only", `${remote}/${baseBranch}`], { cwd: root, stdio: "inherit" });
if (run("git", ["rev-parse", "HEAD"], { cwd: root }) !== remoteBase) {
  fail(`Il checkout ${baseBranch} non coincide con ${remote}/${baseBranch}.`);
}

if (remoteBranch) run("git", ["push", remote, "--delete", branch], { cwd: root, stdio: "inherit" });
run("git", ["fetch", remote, "--prune"], { cwd: root, stdio: "inherit" });
run("git", ["worktree", "remove", target], { cwd: root, stdio: "inherit" });
run("git", ["branch", "-D", branch], { cwd: root, stdio: "inherit" });
run("git", ["worktree", "prune"], { cwd: root });

if (succeeds("git", ["show-ref", "--verify", `refs/heads/${branch}`], { cwd: root })) {
  fail("Il branch locale temporaneo risulta ancora presente.");
}
if (run("git", ["ls-remote", "--heads", remote, `refs/heads/${branch}`], { cwd: root })) {
  fail("Il branch remoto temporaneo risulta ancora presente.");
}
if (succeeds("git", ["show-ref", "--verify", `refs/remotes/${remote}/${branch}`], { cwd: root })) {
  fail("Il riferimento locale al branch remoto temporaneo risulta ancora presente.");
}
if (
  parseWorktrees(run("git", ["worktree", "list", "--porcelain"], { cwd: root })).some(
    (entry) => entry.path === target,
  )
) {
  fail("Il worktree temporaneo risulta ancora registrato.");
}
if (run("git", ["status", "--porcelain"], { cwd: root })) {
  fail(`Il checkout ${baseBranch} non è pulito dopo la chiusura.`);
}

const remaining = inventory(root);
console.log(`Chiusura verificata per PR #${pullRequest.number}: ${baseBranch} = ${remoteBase}.`);
console.log(`Rimossi branch ${branch} e worktree ${target}.`);
console.log("Residui preservati da dichiarare nel riepilogo finale:");
printItems(
  "  Worktree",
  remaining.worktrees
    .filter((entry) => realpathSync(entry.path) !== root)
    .map((entry) => `${entry.path} (${entry.branch ?? "HEAD detached"})`),
);
printItems("  Branch locali non permanenti", remaining.branches);
printItems("  Stash", remaining.stashes);
