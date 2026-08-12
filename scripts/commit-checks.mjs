import process from "node:process";
import { pathToFileURL } from "node:url";

const REQUIRED = ["CI", "Foundation", "Analyze (javascript-typescript)", "react-doctor"];

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
    const check = latest.get(name);
    if (!check || check.status !== "completed") pending.push(name);
    else if (!["success", "neutral", "skipped"].includes(check.conclusion)) failed.push(name);
  }
  return { pending, failed };
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
  sha,
  token,
  repository,
  attempts = 90,
  intervalMs = 10_000,
}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const data = await api(`/commits/${sha}/check-runs?per_page=100`, token, repository);
    const state = checkConclusions(data.check_runs);
    if (state.failed.length > 0)
      throw new Error(`Check bloccanti falliti sull'HEAD esatto: ${state.failed.join(", ")}`);
    if (state.pending.length === 0) return;
    if (attempt === attempts)
      throw new Error(`Check non conclusi sull'HEAD esatto: ${state.pending.join(", ")}`);
    process.stdout.write(`Attendo check exact-SHA: ${state.pending.join(", ")}\n`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function run() {
  const sha = process.env.CANDIDATE;
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[0-9a-f]{40}$/.test(sha ?? "") || !token || !repository)
    throw new Error("CANDIDATE, GITHUB_TOKEN e GITHUB_REPOSITORY sono obbligatori");
  await waitForChecks({ sha, token, repository });
  process.stdout.write(`Gate exact-SHA conclusi per ${sha}.\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await run();
