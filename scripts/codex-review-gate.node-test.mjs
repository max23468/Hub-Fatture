import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  classifyCodexReview,
  hasSuccessfulCodexStatus,
  pullRequestNumber,
} from "./codex-review-gate.mjs";

const headSha = "0123456789abcdef0123456789abcdef01234567";
const requestedAt = "2026-08-04T12:00:00Z";
const bot = { login: "chatgpt-codex-connector[bot]" };

const classify = (overrides = {}) =>
  classifyCodexReview({
    headSha,
    requestedAt,
    now: new Date(requestedAt).getTime() + 60_000,
    comments: [],
    reactions: [],
    reviewComments: [],
    ...overrides,
  });

test("resta pending senza un esito Codex", () => {
  assert.equal(classify().state, "pending");
});

test("il pollice sulla PR approva la review automatica iniziale", () => {
  assert.equal(
    classify({
      reactions: [{ user: bot, content: "+1", created_at: "2026-08-04T12:00:03Z" }],
    }).state,
    "success",
  );
});

test("un pollice tardivo non approva una review del commit precedente", () => {
  assert.equal(
    classify({
      reactions: [{ user: bot, content: "+1", created_at: "2026-08-04T12:00:02Z" }],
      requiresReviewedCommit: true,
      reviews: [
        {
          user: bot,
          submitted_at: "2026-08-04T12:00:01Z",
          body: "**Reviewed commit:** `abcdef0123`",
        },
      ],
    }).state,
    "pending",
  );
});

test("un vecchio pollice non approva una review successiva dello stesso commit", () => {
  assert.equal(
    classify({
      reactions: [{ user: bot, content: "+1", created_at: "2026-08-04T12:00:01Z" }],
      requiresReviewedCommit: true,
      reviews: [
        {
          user: bot,
          submitted_at: "2026-08-04T12:00:02Z",
          body: `**Reviewed commit:** \`${headSha.slice(0, 10)}\``,
        },
      ],
    }).state,
    "pending",
  );
});

test("il pollice senza Reviewed commit non approva", () => {
  assert.equal(
    classify({
      requiresReviewedCommit: true,
      reactions: [{ user: bot, content: "+1", created_at: "2026-08-04T12:00:01Z" }],
    }).state,
    "pending",
  );
});

test("il verdetto pulito del task agent approva soltanto l'HEAD dichiarato", () => {
  assert.equal(
    classify({
      requiresReviewedCommit: true,
      comments: [
        {
          user: bot,
          created_at: "2026-08-04T12:00:01Z",
          body: `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${headSha.slice(0, 10)}\``,
        },
      ],
    }).state,
    "success",
  );
  assert.equal(
    classify({
      requiresReviewedCommit: true,
      comments: [
        {
          user: bot,
          created_at: "2026-08-04T12:00:01Z",
          body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `abcdef0123`",
        },
      ],
    }).state,
    "pending",
  );
  assert.equal(
    classify({
      requiresReviewedCommit: true,
      comments: [
        {
          user: bot,
          created_at: "2026-08-04T12:00:01Z",
          body: `Nessun problema.\n\n**Reviewed commit:** \`${headSha.slice(0, 10)}\``,
        },
      ],
    }).state,
    "pending",
  );
});

test("un finding sull'HEAD corrente blocca il gate", () => {
  assert.equal(
    classify({
      reviewComments: [
        {
          user: bot,
          commit_id: headSha,
          created_at: "2026-08-04T12:00:01Z",
          body: "**P1** Correggi questo caso",
        },
      ],
    }).state,
    "failure",
  );
});

test("un finding del tentativo corrente prevale sul pollice", () => {
  assert.equal(
    classify({
      reviewComments: [
        {
          user: bot,
          commit_id: headSha,
          created_at: "2026-08-04T12:00:01Z",
          body: "**P1** Correggi questo caso",
        },
      ],
      reactions: [{ user: bot, content: "+1", created_at: "2026-08-04T12:00:02Z" }],
    }).state,
    "failure",
  );
});

test("un finding top-level sull'HEAD prevale sul riepilogo pulito", () => {
  assert.equal(
    classify({
      requiresReviewedCommit: true,
      comments: [
        {
          user: bot,
          created_at: "2026-08-04T12:00:01Z",
          body: `**P2** Correggi il gate.\n\n**Reviewed commit:** \`${headSha.slice(0, 10)}\``,
        },
        {
          user: bot,
          created_at: "2026-08-04T12:00:02Z",
          body: `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${headSha.slice(0, 10)}\``,
        },
      ],
    }).state,
    "failure",
  );
});

test("un finding top-level senza marker prevale sul riepilogo pulito", () => {
  assert.equal(
    classify({
      requiresReviewedCommit: true,
      comments: [
        {
          user: bot,
          created_at: "2026-08-04T12:00:01Z",
          body: "**P2** Correggi il gate.",
        },
        {
          user: bot,
          created_at: "2026-08-04T12:00:02Z",
          body: `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${headSha.slice(0, 10)}\``,
        },
      ],
    }).state,
    "failure",
  );
});

test("un finding top-level marcato su un altro SHA non blocca l'HEAD", () => {
  assert.equal(
    classify({
      requiresReviewedCommit: true,
      comments: [
        {
          user: bot,
          created_at: "2026-08-04T12:00:01Z",
          body: "**P2** Finding precedente.\n\n**Reviewed commit:** `abcdef0123`",
        },
        {
          user: bot,
          created_at: "2026-08-04T12:00:02Z",
          body: `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${headSha.slice(0, 10)}\``,
        },
      ],
    }).state,
    "success",
  );
});

test("una review Codex vuota non viene scambiata per un finding", () => {
  assert.equal(
    classify({
      reviewComments: [
        {
          user: bot,
          commit_id: headSha,
          created_at: "2026-08-04T12:00:01Z",
          body: "Nessuna modifica necessaria.",
        },
      ],
    }).state,
    "pending",
  );
});

test("un finding precedente non segue l'HEAD dopo un rebase", () => {
  assert.equal(
    classify({
      reviewComments: [
        {
          user: bot,
          commit_id: headSha,
          original_commit_id: "abcdef0123456789abcdef0123456789abcdef01",
          created_at: "2026-08-04T12:00:01Z",
          body: "**P1** Finding già corretto",
        },
      ],
    }).state,
    "pending",
  );
});

test("un finding precedente non chiude un nuovo tentativo sullo stesso HEAD", () => {
  assert.equal(
    classify({
      reviewComments: [
        {
          user: bot,
          commit_id: headSha,
          original_commit_id: headSha,
          created_at: "2026-08-04T11:59:59Z",
          body: "**P1** Finding precedente",
        },
      ],
      reviews: [
        {
          user: bot,
          submitted_at: "2026-08-04T12:00:02Z",
          body: `**Reviewed commit:** \`${headSha.slice(0, 10)}\``,
        },
      ],
      reactions: [{ user: bot, content: "+1", created_at: "2026-08-04T12:00:03Z" }],
    }).state,
    "success",
  );
});

test("un limite Codex chiude il gate senza lasciare il workflow appeso", () => {
  assert.equal(
    classify({
      comments: [
        {
          user: bot,
          created_at: "2026-08-04T12:00:01Z",
          body: "You have reached your Codex usage limits for code reviews.",
        },
      ],
    }).state,
    "failure",
  );
});

test("un errore tardivo non chiude una review corrente ancora in corso", () => {
  assert.equal(
    classify({
      comments: [
        {
          user: bot,
          created_at: "2026-08-04T12:00:01Z",
          body: "Codex could not complete the review",
        },
      ],
      progressReactions: [{ user: bot, content: "eyes", created_at: "2026-08-04T12:00:02Z" }],
    }).state,
    "pending",
  );
});

test("il bootstrap accetta soltanto un numero PR", () => {
  assert.equal(pullRequestNumber({ pull_request: { number: 42 } }), "42");
  assert.equal(pullRequestNumber({}, "208"), "208");
  assert.throws(() => pullRequestNumber({}, "208/merge"), /Numero PR non valido/);
});

test("un rerun riusa soltanto l'ultimo status Codex riuscito dello stesso SHA", () => {
  assert.equal(
    hasSuccessfulCodexStatus([
      { context: "codex-review", state: "success" },
      { context: "codex-review", state: "pending" },
    ]),
    true,
  );
  assert.equal(
    hasSuccessfulCodexStatus([
      { context: "codex-review", state: "failure" },
      { context: "codex-review", state: "success" },
    ]),
    false,
  );
});

test("l'import in GitHub Actions non avvia la CLI", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import(${JSON.stringify(import.meta.resolve("./codex-review-gate.mjs"))})`,
    ],
    {
      env: { ...process.env, GITHUB_ACTIONS: "true", GITHUB_EVENT_PATH: "/non-esiste" },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
});
