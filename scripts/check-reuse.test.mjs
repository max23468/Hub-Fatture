import assert from "node:assert/strict";
import test from "node:test";
import {
  changesPublicationTrust,
  findReusableValidation,
  successfulChecks,
} from "./check-reuse.mjs";

const candidate = "a".repeat(40);
const source = "b".repeat(40);
const tree = "c".repeat(40);
const repository = "max23468/Hub-Fatture";
const check = (name) => ({
  app: { slug: "github-actions" },
  completed_at: "2026-09-13T10:00:00Z",
  conclusion: "success",
  details_url: `https://github.com/${repository}/actions/runs/1`,
  name,
  status: "completed",
});

test("riconosce le modifiche alla catena di fiducia della pubblicazione", () => {
  assert.equal(changesPublicationTrust(["app/routes/orders.tsx"]), false);
  assert.equal(changesPublicationTrust([".github/workflows/ci.yml"]), true);
  assert.equal(changesPublicationTrust(["scripts/check-reuse.mjs"]), true);
  assert.equal(changesPublicationTrust(["docs/runbooks/production.md"]), true);
});

test("accetta soltanto check GitHub Actions riusciti e appartenenti alla repository", () => {
  assert.equal(successfulChecks([check("CI")], ["CI"], repository), true);
  assert.equal(
    successfulChecks([{ ...check("CI"), conclusion: "failure" }], ["CI"], repository),
    false,
  );
  assert.equal(
    successfulChecks([{ ...check("CI"), app: { slug: "external" } }], ["CI"], repository),
    false,
  );
});

test("riusa una sola PR interna con albero e check equivalenti", async () => {
  const responses = new Map([
    [
      `/commits/${candidate}/pulls?per_page=100&page=1`,
      [
        {
          number: 42,
          merged_at: "2026-09-13T10:01:00Z",
          merge_commit_sha: candidate,
          base: { ref: "main" },
          head: { sha: source, repo: { full_name: repository } },
        },
      ],
    ],
    ["/pulls/42/files?per_page=100&page=1", [{ filename: "app/routes/orders.tsx" }]],
    [`/git/commits/${candidate}`, { tree: { sha: tree } }],
    [`/git/commits/${source}`, { tree: { sha: tree } }],
    [`/commits/${source}/check-runs?per_page=100&page=1`, { check_runs: [check("CI")] }],
  ]);
  const result = await findReusableValidation({
    candidate,
    required: ["CI"],
    repository,
    token: "synthetic",
    request: async (path) => responses.get(path),
  });
  assert.deepEqual(result, { pullNumber: 42, sourceSha: source, treeSha: tree });
});

test("ricade sui gate completi quando cambia una fonte fidata", async () => {
  const request = async (path) => {
    if (path.startsWith(`/commits/${candidate}/pulls`)) {
      return [
        {
          number: 42,
          merged_at: "2026-09-13T10:01:00Z",
          merge_commit_sha: candidate,
          base: { ref: "main" },
          head: { sha: source, repo: { full_name: repository } },
        },
      ];
    }
    if (path.startsWith("/pulls/42/files")) return [{ filename: "scripts/commit-checks.mjs" }];
    throw new Error(`Richiesta inattesa: ${path}`);
  };
  assert.equal(
    await findReusableValidation({
      candidate,
      required: ["CI"],
      repository,
      token: "synthetic",
      request,
    }),
    null,
  );
});

test("considera fidato anche il percorso precedente di un file rinominato", async () => {
  const request = async (path) => {
    if (path.startsWith(`/commits/${candidate}/pulls`)) {
      return [
        {
          number: 42,
          merged_at: "2026-09-13T10:01:00Z",
          merge_commit_sha: candidate,
          base: { ref: "main" },
          head: { sha: source, repo: { full_name: repository } },
        },
      ];
    }
    if (path.startsWith("/pulls/42/files")) {
      return [{ filename: "scripts/old-check.mjs", previous_filename: "scripts/check-reuse.mjs" }];
    }
    throw new Error(`Richiesta inattesa: ${path}`);
  };
  assert.equal(
    await findReusableValidation({
      candidate,
      required: ["CI"],
      repository,
      token: "synthetic",
      request,
    }),
    null,
  );
});
