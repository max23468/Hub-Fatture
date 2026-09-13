import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const shaPattern = /^[0-9a-f]{40}$/;
const trustedPaths = [
  /^\.github\/workflows\//,
  /^AGENTS\.md$/,
  /^docs\/(?:Hub_Fatture_MASTER_PLAN\.md|contracts\/versioning\.md|runbooks\/production\.md)$/,
  /^scripts\/(?:change-impact|check-reuse|commit-checks)\.(?:mjs|test\.mjs)$/,
  /^scripts\/(?:repository-content|toolchain-policy)\.node-test\.mjs$/,
];

export function changesPublicationTrust(files) {
  return files.some((file) => trustedPaths.some((pattern) => pattern.test(file)));
}

export function successfulChecks(checkRuns, required, repository) {
  const latest = new Map();
  for (const check of checkRuns) {
    const previous = latest.get(check.name);
    const timestamp = check.completed_at ?? check.started_at ?? "";
    const previousTimestamp = previous?.completed_at ?? previous?.started_at ?? "";
    if (!previous || timestamp >= previousTimestamp) latest.set(check.name, check);
  }
  return required.every((name) => {
    const check = latest.get(name);
    return (
      check?.status === "completed" &&
      check.conclusion === "success" &&
      check.app?.slug === "github-actions" &&
      check.details_url?.startsWith(`https://github.com/${repository}/actions/runs/`)
    );
  });
}

async function githubRequest(path, token, repository) {
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} durante la verifica del riuso`);
  return response.json();
}

async function allPages(path, key, request) {
  const values = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const result = await request(`${path}${separator}per_page=100&page=${page}`);
    const entries = key ? result[key] : result;
    if (!Array.isArray(entries)) throw new Error("Risposta GitHub inattesa durante la verifica");
    values.push(...entries);
    if (entries.length < 100) return values;
  }
}

export async function findReusableValidation({
  candidate,
  required,
  repository,
  token,
  request = (path) => githubRequest(path, token, repository),
}) {
  if (!shaPattern.test(candidate) || !repository || !token || required.length === 0) return null;
  const pulls = await allPages(`/commits/${candidate}/pulls`, null, request);
  const matches = pulls.filter(
    (pull) =>
      pull.merged_at &&
      pull.merge_commit_sha === candidate &&
      pull.base?.ref === "main" &&
      pull.head?.repo?.full_name === repository &&
      shaPattern.test(pull.head?.sha ?? ""),
  );
  if (matches.length !== 1) return null;

  const pull = matches[0];
  const files = await allPages(`/pulls/${pull.number}/files`, null, request);
  const changedPaths = files.flatMap((file) =>
    [file.filename, file.previous_filename].filter((path) => typeof path === "string"),
  );
  if (changesPublicationTrust(changedPaths)) return null;

  const [candidateCommit, sourceCommit, checks] = await Promise.all([
    request(`/git/commits/${candidate}`),
    request(`/git/commits/${pull.head.sha}`),
    allPages(`/commits/${pull.head.sha}/check-runs`, "check_runs", request),
  ]);
  if (!candidateCommit.tree?.sha || candidateCommit.tree.sha !== sourceCommit.tree?.sha)
    return null;
  if (!successfulChecks(checks, [...new Set(required)], repository)) return null;
  return { pullNumber: pull.number, sourceSha: pull.head.sha, treeSha: candidateCommit.tree.sha };
}

async function writeOutputs(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  } else {
    process.stdout.write(`${lines.join("\n")}\n`);
  }
}

async function main() {
  const required = JSON.parse(process.env.REQUIRED_CHECKS_JSON ?? "[]");
  if (!Array.isArray(required) || required.some((name) => typeof name !== "string")) {
    throw new Error("REQUIRED_CHECKS_JSON deve essere un array di nomi");
  }
  const validation = await findReusableValidation({
    candidate: process.env.CANDIDATE ?? "",
    required,
    repository: process.env.GITHUB_REPOSITORY ?? "",
    token: process.env.GITHUB_TOKEN ?? "",
  });
  await writeOutputs(
    validation
      ? {
          reused: true,
          source_sha: validation.sourceSha,
          pull_request: validation.pullNumber,
          tree_sha: validation.treeSha,
        }
      : { reused: false },
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
