import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CODEX_REVIEW_POLLING,
  advisoryThreadIds,
  codexReviewPollingDelay,
  codexReviewPollingDuration,
  classifyCodexReview,
  findingPriority,
  isAutomaticFirstReview,
  latestCodexInvocation,
  pullRequestNumber,
} from "./codex-review-gate.mjs";

const headSha = "0123456789abcdef0123456789abcdef01234567";
const oldSha = "abcdef0123456789abcdef0123456789abcdef01";
const requestedAt = "2026-08-09T12:00:00Z";
const bot = { login: "chatgpt-codex-connector[bot]" };
const classify = (overrides = {}) =>
  classifyCodexReview({
    headSha,
    requestedAt,
    now: new Date("2026-08-09T12:01:00Z").getTime(),
    ...overrides,
  });

test("legge la priorità solo dall'intestazione del finding", () => {
  assert.equal(findingPriority("**P2** Advisory che cita P0 e P1"), "P2");
  assert.equal(findingPriority("testo che cita P1"), undefined);
});

test("blocca soltanto P0/P1 dell'HEAD corrente", () => {
  assert.equal(
    classify({
      reviewComments: [
        {
          user: bot,
          original_commit_id: headSha,
          created_at: "2026-08-09T11:59:59Z",
          body: "**P1** Correggi questo problema",
        },
      ],
    }).state,
    "failure",
  );
  assert.equal(
    classify({
      reviewComments: [
        {
          user: bot,
          original_commit_id: oldSha,
          created_at: "2026-08-09T12:00:01Z",
          body: "**P0** Finding del commit precedente",
        },
      ],
    }).state,
    "pending",
  );
});

test("P2/P3 sono advisory e completano il gate dopo l'assestamento", () => {
  const input = {
    reviewComments: [
      {
        user: bot,
        original_commit_id: headSha,
        created_at: "2026-08-09T12:00:02Z",
        body: "**P2** Advisory che cita P1",
      },
    ],
    reviews: [
      {
        user: bot,
        commit_id: headSha,
        submitted_at: "2026-08-09T12:00:03Z",
        body: "",
      },
    ],
  };
  assert.equal(
    classify({ ...input, now: new Date("2026-08-09T12:00:20Z").getTime() }).state,
    "pending",
  );
  assert.equal(classify(input).state, "success");
});

test("risolve soltanto thread Codex P2/P3 dell'HEAD esatto", () => {
  const thread = (id, priority, commit = headSha, login = bot.login, isResolved = false) => ({
    id,
    isResolved,
    comments: {
      nodes: [
        { author: { login }, body: `**${priority}** Finding`, originalCommit: { oid: commit } },
      ],
    },
  });
  assert.deepEqual(
    advisoryThreadIds(
      [
        thread("p2", "P2"),
        thread("p3", "P3"),
        thread("p1", "P1"),
        thread("old", "P2", oldSha),
        thread("human", "P2", headSha, "max23468"),
        {
          ...thread("answered", "P2"),
          comments: {
            nodes: [
              ...thread("answered", "P2").comments.nodes,
              { author: { login: "max23468" }, body: "Risposta del proprietario" },
            ],
          },
        },
        {
          ...thread("mixed-priority", "P2"),
          comments: {
            nodes: [
              {
                author: bot,
                body: "**P1** Finding precedente",
                originalCommit: { oid: oldSha },
              },
              ...thread("mixed-priority", "P2").comments.nodes,
            ],
          },
        },
        thread("graphql-bot", "P2", headSha, "chatgpt-codex-connector"),
        thread("done", "P2", headSha, bot.login, true),
      ],
      headSha,
    ),
    ["p2", "p3", "graphql-bot"],
  );
});

test("un advisory top-level richiede il marker dell'HEAD", () => {
  const advisory = (commit) => ({
    user: bot,
    created_at: "2026-08-09T12:00:01Z",
    body: `**P3** Suggerimento\n\n**Reviewed commit:** \`${commit}\``,
  });
  assert.equal(classify({ comments: [advisory(headSha.slice(0, 10))] }).state, "success");
  assert.equal(classify({ comments: [advisory(oldSha.slice(0, 10))] }).state, "pending");
});

test("il pollice della PR vale solo per il primo giro automatico", () => {
  const prReactions = [{ user: bot, content: "+1", created_at: "2026-08-09T12:00:01Z" }];
  assert.equal(classify({ automatic: true, prReactions }).state, "success");
  assert.equal(classify({ automatic: false, prReactions }).state, "pending");
});

test("i giri successivi usano la reaction dell'invocazione corrente", () => {
  assert.equal(
    classify({
      invocationReactions: [{ user: bot, content: "+1", created_at: "2026-08-09T12:00:01Z" }],
    }).state,
    "success",
  );
});

test("seleziona solo un'invocazione esatta, fidata e successiva all'HEAD", () => {
  const comments = [
    {
      id: 1,
      user: { login: "max23468" },
      author_association: "OWNER",
      body: "@codex review",
      created_at: "2026-08-09T11:59:59Z",
    },
    {
      id: 4,
      user: { login: "max23468" },
      author_association: "OWNER",
      body: "non eseguire @codex review",
      created_at: "2026-08-09T12:00:01Z",
    },
    {
      id: 2,
      user: { login: "utente" },
      author_association: "NONE",
      body: "@codex review",
      created_at: "2026-08-09T12:00:02Z",
    },
    {
      id: 3,
      user: { login: "max23468" },
      author_association: "OWNER",
      body: "@codex review",
      created_at: "2026-08-09T12:00:03Z",
    },
  ];
  assert.equal(latestCodexInvocation(comments, requestedAt).id, 3);
});

test("il primo giro è automatico solo su apertura o ready", () => {
  assert.equal(isAutomaticFirstReview("pull_request_target", "opened"), true);
  assert.equal(isAutomaticFirstReview("pull_request_target", "ready_for_review"), true);
  assert.equal(isAutomaticFirstReview("pull_request_target", "synchronize"), false);
  assert.equal(isAutomaticFirstReview("workflow_dispatch", undefined), false);
});

test("gli errori operativi bloccano in assenza di una review conclusa più recente", () => {
  assert.equal(
    classify({
      comments: [
        {
          user: bot,
          created_at: "2026-08-09T12:00:01Z",
          body: "Codex Review: Something went wrong. Unknown error",
        },
      ],
    }).state,
    "error",
  );
});

test("valida il numero PR e usa un polling rapido con fallback entro cinque ore", () => {
  assert.equal(pullRequestNumber({ issue: { number: 42 } }), "42");
  assert.throws(() => pullRequestNumber({}, "x"), /Numero PR non valido/);
  assert.equal(codexReviewPollingDelay(0), 30_000);
  assert.equal(codexReviewPollingDelay(CODEX_REVIEW_POLLING.fastAttempts), 180_000);
  assert.ok(codexReviewPollingDuration() < 18_000_000);
  assert.ok(codexReviewPollingDuration() >= 17_000_000);
});

test("il workflow usa codice trusted e non richiede commenti al primo giro", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/codex-review-gate.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /issue_comment:/);
  assert.match(workflow, /pull_request_review:/);
  assert.match(workflow, /chatgpt-codex-connector\[bot\]/);
  assert.match(workflow, /github\.event\.comment\.body == '@codex review'/);
  assert.match(workflow, /github\.event\.comment\.author_association == 'OWNER'/);
  assert.doesNotMatch(workflow, /contains\(github\.event\.comment\.body/);
  assert.match(workflow, /statuses: write/);
  assert.match(workflow, /pull-requests: write/);
  assert.doesNotMatch(workflow, /issues: write/);
  assert.match(workflow, /node --test scripts\/codex-review-gate\.test\.mjs/);
  assert.match(workflow, /ref:\s*\$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.doesNotMatch(workflow, /github\.ref_name/);
  assert.match(workflow, /jobs:\s*\n  gate:[\s\S]*?    concurrency:/);
});
