import assert from "node:assert/strict";
import test from "node:test";
import { checkConclusions } from "./commit-checks.mjs";

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
