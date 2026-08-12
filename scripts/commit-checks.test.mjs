import assert from "node:assert/strict";
import test from "node:test";
import { checkConclusions, selectCheckTargets } from "./commit-checks.mjs";

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

test("lega ogni gate all'ultimo commit del cumulativo che attiva la sua superficie", () => {
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
    Foundation: runtime,
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
