import { execFileSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { classifyFiles } from "./change-impact.mjs";

const FOUNDATION_IMAGE = "Foundation (immagine)";
const REQUIRED = [
  "CI",
  "Foundation",
  FOUNDATION_IMAGE,
  "Analyze (javascript-typescript)",
  "react-doctor",
];
const CHECK_CONTEXT_BY_TARGET = {
  [FOUNDATION_IMAGE]: "Foundation",
};
const SURFACE_BY_CHECK = {
  CI: "standard",
  [FOUNDATION_IMAGE]: "image",
  "Analyze (javascript-typescript)": "standard",
  "react-doctor": "react",
};
const CONDITIONAL_SURFACE_BY_CHECK = {
  "PostgreSQL e migrazioni": "database",
  "Audit dipendenze": "securityData",
  "Contract test provider": "provider",
  "E2E Chromium": "e2e",
  "E2E WebKit": "e2eWebkit",
  "Helper Aruba (chrome / macos-latest)": "arubaPlatform",
  "Helper Aruba (msedge / windows-latest)": "arubaPlatform",
};
const CONDITIONAL_CHECKS = new Set(Object.keys(CONDITIONAL_SURFACE_BY_CHECK));
const WORKFLOW_MARKER_BY_CHECK = {
  "PostgreSQL e migrazioni": "name: PostgreSQL e migrazioni",
  "Audit dipendenze": "name: Audit dipendenze",
  "Contract test provider": "name: Contract test provider",
  "E2E Chromium": '"label":"Chromium"',
  "E2E WebKit": '"label":"WebKit"',
  "Helper Aruba (chrome / macos-latest)": "name: Helper Aruba (",
  "Helper Aruba (msedge / windows-latest)": "name: Helper Aruba (",
};

export function checkConclusions(checkRuns, required = REQUIRED) {
  const latest = new Map();
  for (const check of checkRuns) {
    const previous = latest.get(check.name);
    const timestamp = check.completed_at ?? check.started_at ?? "";
    const previousTimestamp = previous?.completed_at ?? previous?.started_at ?? "";
    if (!previous || timestamp >= previousTimestamp) latest.set(check.name, check);
  }
  const pending = [];
  const failed = [];
  for (const name of required) {
    const check = latest.get(CHECK_CONTEXT_BY_TARGET[name] ?? name);
    if (!check || check.status !== "completed") pending.push(name);
    else if (
      !["success", "neutral", "skipped"].includes(check.conclusion) ||
      (CONDITIONAL_CHECKS.has(name) && check.conclusion === "skipped")
    )
      failed.push(name);
  }
  return { pending, failed };
}

export function selectCheckTargets(entries, candidate, required = REQUIRED) {
  const targets = Object.fromEntries(required.map((name) => [name, candidate]));
  for (const entry of entries) {
    for (const name of required) {
      if (entry.impact[SURFACE_BY_CHECK[name]]) targets[name] = entry.sha;
    }
    for (const [name, surface] of Object.entries(CONDITIONAL_SURFACE_BY_CHECK)) {
      if (entry.impact[surface] && (entry.conditionalChecks?.includes(name) ?? true)) {
        targets[name] = entry.sha;
      }
    }
  }
  return targets;
}

export function revisionRangeArguments(base, candidate) {
  return /^0{40}$/.test(base)
    ? ["rev-list", "--reverse", "--first-parent", candidate]
    : ["rev-list", "--reverse", "--first-parent", `${base}..${candidate}`];
}

function changedFilesForCommit(sha) {
  return execFileSync(
    "git",
    [
      "diff-tree",
      "--root",
      "--no-commit-id",
      "--name-only",
      "--no-renames",
      "--diff-filter=ACDMRTUXB",
      "-r",
      sha,
      "--",
    ],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);
}

export function classifyCheckImpact(files) {
  const impact = classifyFiles(files);
  if (!files.includes("scripts/change-impact.mjs")) return impact;
  return {
    ...impact,
    lane: "deploy",
    standard: true,
    database: true,
    securityData: true,
    provider: true,
    arubaPlatform: true,
    e2e: true,
    e2eWebkit: true,
    image: true,
  };
}

function conditionalChecksForCommit(sha) {
  let workflow;
  try {
    workflow = execFileSync("git", ["show", `${sha}:.github/workflows/ci.yml`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  return Object.entries(WORKFLOW_MARKER_BY_CHECK)
    .filter(([, marker]) => workflow.includes(marker))
    .map(([name]) => name);
}

export function resolveCheckTargets(base, candidate) {
  const commits = execFileSync("git", revisionRangeArguments(base, candidate), {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  const entries = commits.map((sha) => ({
    sha,
    impact: classifyCheckImpact(changedFilesForCommit(sha)),
    conditionalChecks: conditionalChecksForCommit(sha),
  }));
  return selectCheckTargets(entries, candidate);
}

async function api(path, token, repository) {
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  return response.json();
}

export async function waitForChecks({
  targets,
  token,
  repository,
  attempts = 90,
  intervalMs = 10_000,
}) {
  const checksBySha = new Map();
  for (const [name, sha] of Object.entries(targets)) {
    const names = checksBySha.get(sha) ?? [];
    names.push(name);
    checksBySha.set(sha, names);
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const pending = [];
    const failed = [];
    for (const [sha, names] of checksBySha) {
      const data = await api(`/commits/${sha}/check-runs?per_page=100`, token, repository);
      const state = checkConclusions(data.check_runs, names);
      pending.push(...state.pending.map((name) => `${name}@${sha.slice(0, 12)}`));
      failed.push(...state.failed.map((name) => `${name}@${sha.slice(0, 12)}`));
    }
    if (failed.length > 0)
      throw new Error(`Check bloccanti falliti sul cumulativo: ${failed.join(", ")}`);
    if (pending.length === 0) return;
    if (attempt === attempts)
      throw new Error(`Check non conclusi sul cumulativo: ${pending.join(", ")}`);
    process.stdout.write(`Attendo check del cumulativo: ${pending.join(", ")}\n`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function run() {
  const sha = process.env.CANDIDATE;
  const base = process.env.BASE;
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (
    !/^[0-9a-f]{40}$/.test(sha ?? "") ||
    !/^[0-9a-f]{40}$/.test(base ?? "") ||
    !token ||
    !repository
  )
    throw new Error("BASE, CANDIDATE, GITHUB_TOKEN e GITHUB_REPOSITORY sono obbligatori");
  const targets = resolveCheckTargets(base, sha);
  await waitForChecks({ targets, token, repository });
  process.stdout.write(`Gate cumulativi conclusi per ${sha}: ${JSON.stringify(targets)}.\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await run();
