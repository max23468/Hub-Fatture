import { pathToFileURL } from "node:url";

const CODEX_BOT = "chatgpt-codex-connector[bot]";
const isDirectExecution =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

const timestamp = (value) => new Date(value ?? 0).getTime();
const reviewedCommit = (body = "") =>
  body.match(/\*\*Reviewed commit:\*\*\s*`([0-9a-f]{10,40})`/i)?.[1];

export function classifyCodexReview({
  headSha,
  requestedAt,
  now = Date.now(),
  comments,
  reactions,
  progressReactions = reactions,
  requiresReviewedCommit = false,
  reviewComments,
}) {
  const completions = [];
  const cleanComments = [];
  const inProgress = progressReactions.some(
    (reaction) =>
      reaction.user?.login === CODEX_BOT &&
      reaction.content === "eyes" &&
      timestamp(reaction.created_at) >= timestamp(requestedAt),
  );

  for (const comment of reviewComments) {
    if (
      comment.user?.login === CODEX_BOT &&
      (comment.original_commit_id ?? comment.commit_id) === headSha &&
      timestamp(comment.created_at) >= timestamp(requestedAt) &&
      /\bP[0-3]\b/.test(comment.body)
    ) {
      completions.push({
        state: "failure",
        at: timestamp(comment.created_at),
        description: "Codex ha trovato problemi nell'ultimo commit",
      });
    }
  }

  if (completions.length) {
    return completions.sort((left, right) => right.at - left.at)[0];
  }

  for (const comment of comments) {
    if (comment.user?.login !== CODEX_BOT) continue;

    const commit = reviewedCommit(comment.body);
    if (
      commit &&
      headSha.startsWith(commit) &&
      timestamp(comment.created_at) >= timestamp(requestedAt) &&
      /didn't find any major issues/i.test(comment.body)
    ) {
      cleanComments.push(timestamp(comment.created_at));
    } else if (
      timestamp(comment.created_at) >= timestamp(requestedAt) &&
      now - timestamp(requestedAt) >= 30_000 &&
      !inProgress &&
      /reached your Codex usage limits|could not complete|unable to review/i.test(comment.body)
    ) {
      completions.push({
        state: "failure",
        at: timestamp(comment.created_at),
        description: "La review Codex non è stata completata",
      });
    }
  }

  const thumbsUpAt = reactions
    .filter(
      (reaction) =>
        reaction.user?.login === CODEX_BOT &&
        reaction.content === "+1" &&
        timestamp(reaction.created_at) >= timestamp(requestedAt),
    )
    .reduce((latest, reaction) => Math.max(latest, timestamp(reaction.created_at)), 0);

  if (thumbsUpAt) {
    if (!requiresReviewedCommit) cleanComments.push(thumbsUpAt);
    for (const commentAt of cleanComments) {
      completions.push({
        state: "success",
        at: Math.max(thumbsUpAt, commentAt),
        description: "Codex ha approvato l'ultimo commit",
      });
    }
  }

  return (
    completions.sort((left, right) => right.at - left.at)[0] ?? {
      state: "pending",
      description: "In attesa della review Codex sull'ultimo commit",
    }
  );
}

export function codexReviewStarted({ requestedAt, comments, reactions, reviews }) {
  const startedAt = timestamp(requestedAt);
  return (
    reactions.some(
      (reaction) =>
        reaction.user?.login === CODEX_BOT && timestamp(reaction.created_at) >= startedAt,
    ) ||
    comments.some(
      (comment) => comment.user?.login === CODEX_BOT && timestamp(comment.created_at) >= startedAt,
    ) ||
    reviews.some(
      (review) => review.user?.login === CODEX_BOT && timestamp(review.submitted_at) >= startedAt,
    )
  );
}

export function pullRequestNumber(event, input) {
  const number = String(event.pull_request?.number ?? input);
  if (!/^\d+$/.test(number)) throw new Error("Numero PR non valido");
  return number;
}

async function request(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "x-github-api-version": "2022-11-28",
      ...options.headers,
    },
  });
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path}: ${response.status}`);
  return response.json();
}

async function all(path) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const batch = await request(
      `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

async function setStatus(repository, sha, state, description) {
  await request(`/repos/${repository}/statuses/${sha}`, {
    method: "POST",
    body: JSON.stringify({
      state,
      context: "codex-review",
      description,
      target_url: `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    }),
  });
}

const reviewSignals = (repository, number, reactionCommentId) =>
  Promise.all([
    all(`/repos/${repository}/issues/${number}/comments`),
    all(`/repos/${repository}/issues/${number}/reactions`),
    all(`/repos/${repository}/pulls/${number}/reviews`),
    all(`/repos/${repository}/pulls/${number}/comments`),
    reactionCommentId
      ? all(`/repos/${repository}/issues/comments/${reactionCommentId}/reactions`)
      : Promise.resolve([]),
  ]);

async function main() {
  const event = JSON.parse(
    await (await import("node:fs/promises")).readFile(process.env.GITHUB_EVENT_PATH),
  );
  const repository = process.env.GITHUB_REPOSITORY;
  const requestedNumber = pullRequestNumber(event, process.env.PULL_REQUEST_NUMBER);
  const pullRequest =
    event.pull_request ?? (await request(`/repos/${repository}/pulls/${requestedNumber}`));
  const number = pullRequest.number;
  const headSha = pullRequest.head.sha;

  await setStatus(
    repository,
    headSha,
    "pending",
    "In attesa della review Codex sull'ultimo commit",
  );
  if (pullRequest.draft) return;

  if (event.action === "synchronize") {
    // ponytail: finestra fissa per assorbire rebase ravvicinati; passare agli
    // eventi dei check solo se due minuti rallentano concretamente il flusso.
    await new Promise((resolve) => setTimeout(resolve, 120_000));
    const currentPullRequest = await request(`/repos/${repository}/pulls/${number}`);
    if (currentPullRequest.head.sha !== headSha) return;
  }

  let requestedAt = pullRequest.updated_at;
  let reactionCommentId;
  if (["opened", "ready_for_review"].includes(event.action)) {
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    const currentPullRequest = await request(`/repos/${repository}/pulls/${number}`);
    if (currentPullRequest.head.sha !== headSha) return;
    const [comments, reactions, reviews, reviewComments] = await reviewSignals(repository, number);
    const result = classifyCodexReview({
      headSha,
      requestedAt,
      comments,
      reactions,
      reviewComments,
    });
    if (result.state !== "pending") {
      await setStatus(repository, headSha, result.state, result.description);
      return;
    }
    if (!codexReviewStarted({ requestedAt, comments, reactions, reviews })) {
      const comment = await request(`/repos/${repository}/issues/${number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: `@codex review\n\n<!-- codex-review-gate:${headSha} -->` }),
      });
      requestedAt = comment.created_at;
      reactionCommentId = comment.id;
    }
  } else if (
    process.env.GITHUB_EVENT_NAME === "workflow_dispatch" ||
    ["synchronize", "reopened"].includes(event.action)
  ) {
    const comment = await request(`/repos/${repository}/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: `@codex review\n\n<!-- codex-review-gate:${headSha} -->` }),
    });
    requestedAt = comment.created_at;
    reactionCommentId = comment.id;
  }

  for (let attempt = 0; attempt < 600; attempt += 1) {
    const [comments, reactions, , reviewComments, requestReactions] = await reviewSignals(
      repository,
      number,
      reactionCommentId,
    );
    const result = classifyCodexReview({
      headSha,
      requestedAt,
      comments,
      reactions: reactionCommentId ? [...reactions, ...requestReactions] : reactions,
      progressReactions: reactionCommentId ? requestReactions : reactions,
      requiresReviewedCommit: Boolean(reactionCommentId),
      reviewComments,
    });
    if (result.state !== "pending") {
      await setStatus(repository, headSha, result.state, result.description);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }

  await setStatus(repository, headSha, "error", "Review Codex non conclusa entro cinque ore");
}

if (process.env.GITHUB_ACTIONS === "true" && isDirectExecution) {
  await main().catch(async (error) => {
    console.error(error);
    const event = JSON.parse(
      await (await import("node:fs/promises")).readFile(process.env.GITHUB_EVENT_PATH),
    );
    let requestedNumber;
    try {
      requestedNumber = pullRequestNumber(event, process.env.PULL_REQUEST_NUMBER);
    } catch {
      return;
    }
    const pullRequest =
      event.pull_request ??
      (await request(`/repos/${process.env.GITHUB_REPOSITORY}/pulls/${requestedNumber}`).catch(
        () => null,
      ));
    if (!pullRequest) return;
    await setStatus(
      process.env.GITHUB_REPOSITORY,
      pullRequest.head.sha,
      "error",
      "Impossibile verificare la review Codex",
    ).catch(console.error);
  });
}
