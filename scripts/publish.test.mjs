import assert from "node:assert/strict";
import test from "node:test";
import { publicationPlan, queuedTooLong, worktrees } from "./publish.mjs";

test("segnala una coda soltanto dopo cinque minuti", () => {
  const now = Date.parse("2026-09-13T12:10:00Z");
  assert.equal(queuedTooLong({ status: "queued", created_at: "2026-09-13T12:04:59Z" }, now), true);
  assert.equal(
    queuedTooLong({ status: "in_progress", created_at: "2026-09-13T12:00:00Z" }, now),
    false,
  );
});

test("il piano comprende dispatch immediato e chiusura", () => {
  const plan = publicationPlan({
    branch: "codex/example",
    head: "a".repeat(40),
    title: "fix: esempio",
  });
  assert.match(plan.join("\n"), /dispatch Production immediato/);
  assert.match(plan.join("\n"), /pulizia del branch/);
});

test("individua il checkout di main dall'inventario worktree", () => {
  const parsed = worktrees(
    "worktree /repo\nHEAD aaa\nbranch refs/heads/main\n\nworktree /tmp/feature\nHEAD bbb\nbranch refs/heads/codex/example\n",
  );
  assert.equal(parsed[0].worktree, "/repo");
  assert.equal(parsed[0].branch, "refs/heads/main");
});
