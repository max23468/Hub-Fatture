import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkConclusions,
  revisionRangeArguments,
  resolveCheckTargets,
  selectCheckTargets,
} from "./commit-checks.mjs";

const success = (name, completedAt = "2026-08-12T12:00:00Z") => ({
  name,
  status: "completed",
  conclusion: "success",
  completed_at: completedAt,
});

test("accetta soltanto tutti i gate richiesti conclusi sul candidato", () => {
  const state = checkConclusions([
    success("CI"),
    success("Foundation"),
    success("Analyze (javascript-typescript)"),
    success("react-doctor"),
  ]);
  assert.deepEqual(state, { pending: [], failed: [] });
});

test("distingue check mancanti, pendenti e falliti", () => {
  const state = checkConclusions([
    success("CI"),
    { name: "Foundation", status: "in_progress", conclusion: null },
    { name: "react-doctor", status: "completed", conclusion: "failure" },
  ]);
  assert.deepEqual(state.pending.sort(), ["Analyze (javascript-typescript)", "Foundation"]);
  assert.deepEqual(state.failed, ["react-doctor"]);
});

test("usa l'esecuzione più recente dello stesso contesto", () => {
  const state = checkConclusions(
    [
      success("CI", "2026-08-12T12:01:00Z"),
      { ...success("CI", "2026-08-12T12:00:00Z"), conclusion: "failure" },
    ],
    ["CI"],
  );
  assert.deepEqual(state, { pending: [], failed: [] });
});

test("lega i gate di superficie al commit applicabile e Foundation al candidato", () => {
  const runtime = "1".repeat(40);
  const docs = "2".repeat(40);
  const targets = selectCheckTargets(
    [
      {
        sha: runtime,
        impact: { standard: true, image: true, react: true },
      },
      {
        sha: docs,
        impact: { standard: false, image: false, react: false },
      },
    ],
    docs,
  );
  assert.deepEqual(targets, {
    CI: runtime,
    Foundation: docs,
    "Analyze (javascript-typescript)": runtime,
    "react-doctor": runtime,
  });
});

test("un fix runtime successivo sostituisce i gate del candidato fallito", () => {
  const failed = "1".repeat(40);
  const fixed = "2".repeat(40);
  const targets = selectCheckTargets(
    [
      { sha: failed, impact: { standard: true, image: true, react: false } },
      { sha: fixed, impact: { standard: true, image: true, react: false } },
    ],
    fixed,
  );
  assert.equal(targets.CI, fixed);
  assert.equal(targets.Foundation, fixed);
  assert.equal(targets["Analyze (javascript-typescript)"], fixed);
  assert.equal(targets["react-doctor"], fixed);
});

test("conserva il target di ogni superficie CI indipendente", () => {
  const database = "1".repeat(40);
  const provider = "2".repeat(40);
  const runtime = "3".repeat(40);
  const targets = selectCheckTargets(
    [
      {
        sha: database,
        impact: { standard: true, image: true, database: true, securityData: true, e2e: true },
      },
      {
        sha: provider,
        impact: { standard: true, image: true, provider: true, e2e: true },
      },
      {
        sha: runtime,
        impact: { standard: true, image: true, e2e: true },
      },
    ],
    runtime,
  );
  assert.equal(targets.CI, runtime);
  assert.equal(targets["PostgreSQL e migrazioni"], database);
  assert.equal(targets["Audit dipendenze"], database);
  assert.equal(targets["Contract test provider"], provider);
  assert.equal(targets["E2E Chromium"], runtime);
  assert.equal(targets["E2E WebKit"], runtime);
});

test("i commit con CI monolitica non richiedono job storici inesistenti", () => {
  const legacy = "1".repeat(40);
  const candidate = "2".repeat(40);
  const targets = selectCheckTargets(
    [
      {
        sha: legacy,
        impact: { standard: true, image: true, database: true, provider: true, e2e: true },
        conditionalChecks: [],
      },
      {
        sha: candidate,
        impact: { standard: false, image: false },
        conditionalChecks: [],
      },
    ],
    candidate,
  );
  assert.equal(targets.CI, legacy);
  assert.equal("PostgreSQL e migrazioni" in targets, false);
  assert.equal("Contract test provider" in targets, false);
  assert.equal("E2E Chromium" in targets, false);
  assert.equal("E2E WebKit" in targets, false);
});

test("richiede entrambe le piattaforme Aruba sull'ultimo commit applicabile", () => {
  const aruba = "1".repeat(40);
  const docs = "2".repeat(40);
  const targets = selectCheckTargets(
    [
      { sha: aruba, impact: { standard: true, image: true, arubaPlatform: true } },
      { sha: docs, impact: { standard: false, image: false, arubaPlatform: false } },
    ],
    docs,
  );
  assert.equal(targets["Helper Aruba (chrome / macos-latest)"], aruba);
  assert.equal(targets["Helper Aruba (msedge / windows-latest)"], aruba);
});

test("un gate di superficie applicabile non può risultare saltato", () => {
  const state = checkConclusions(
    [{ ...success("PostgreSQL e migrazioni"), conclusion: "skipped" }],
    ["PostgreSQL e migrazioni"],
  );
  assert.deepEqual(state, { pending: [], failed: ["PostgreSQL e migrazioni"] });
});

test("la prima distribuzione analizza tutta la storia first-parent", () => {
  const candidate = "a".repeat(40);
  assert.deepEqual(revisionRangeArguments("0".repeat(40), candidate), [
    "rev-list",
    "--reverse",
    "--first-parent",
    candidate,
  ]);
  assert.deepEqual(revisionRangeArguments("b".repeat(40), candidate), [
    "rev-list",
    "--reverse",
    "--first-parent",
    `${"b".repeat(40)}..${candidate}`,
  ]);
});

test("la baseline vuota conserva i gate runtime di un commit precedente", async (context) => {
  const repository = await mkdtemp(path.join(tmpdir(), "hub-fatture-checks-"));
  const originalDirectory = process.cwd();
  context.after(async () => {
    process.chdir(originalDirectory);
    await rm(repository, { recursive: true, force: true });
  });
  const git = (...arguments_) =>
    execFileSync("git", arguments_, { cwd: repository, encoding: "utf8" }).trim();

  git("init", "--quiet");
  git("config", "user.email", "tests@hub-fatture.invalid");
  git("config", "user.name", "Hub Fatture tests");
  await mkdir(path.join(repository, "app"));
  await mkdir(path.join(repository, ".github", "workflows"), { recursive: true });
  await writeFile(path.join(repository, "app", "runtime.ts"), "export const runtime = true;\n");
  await writeFile(
    path.join(repository, ".github", "workflows", "ci.yml"),
    "name: CI\njobs:\n  e2e:\n    name: E2E ${{ matrix.label }}\n    label: Chromium\n    label: WebKit\n",
  );
  git("add", "app/runtime.ts", ".github/workflows/ci.yml");
  git("commit", "--quiet", "-m", "test: runtime");
  const runtime = git("rev-parse", "HEAD");
  await mkdir(path.join(repository, "docs"));
  await writeFile(path.join(repository, "docs", "readme.md"), "# Docs\n");
  git("add", "docs/readme.md");
  git("commit", "--quiet", "-m", "docs: candidate");
  const candidate = git("rev-parse", "HEAD");

  process.chdir(repository);
  const targets = resolveCheckTargets("0".repeat(40), candidate);
  assert.equal(targets.CI, runtime);
  assert.equal(targets.Foundation, candidate);
  assert.equal(targets["E2E Chromium"], runtime);
  assert.equal(targets["E2E WebKit"], runtime);
});
