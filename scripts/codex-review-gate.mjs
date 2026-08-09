const CODEX_BOT = "chatgpt-codex-connector[bot]";
const findingPriority = (body = "") =>
  body.match(/^(?:\*\*|<sub>)*(?:!?\[)?(P[0-3])(?: Badge)?(?:\]\([^)]*\)|\]\s*|\*\*)/m)?.[1];
const isBlockingFinding = (body) => ["P0", "P1"].includes(findingPriority(body));
const ADVISORY_SETTLING_MS = 30_000;
// ponytail: 180 s limita cinque PR concorrenti a circa 500 richieste/ora; passare a
// un'unica query GraphQL se la concorrenza reale cresce oltre questo livello.
export const CODEX_REVIEW_POLLING = { attempts: 100, intervalMs: 180_000, marginMs: 300_000 };

const timestamp = (value) => new Date(value ?? 0).getTime();
const reviewedCommit = (body = "") =>
  body.match(/\*\*Reviewed commit:\*\*\s*`([0-9a-f]{10,40})`/i)?.[1];

export function classifyCodexReview({
  headSha,
  requestedAt,
  now = Date.now(),
  comments,
  exactReactions = [],
  reactions,
  progressReactions = reactions,
  requiresReviewedCommit = false,
  reviews = [],
  reviewComments,
}) {
  const completions = [];
  const advisoryFindings = [];
  const cleanComments = [];
  const latestEyesAt = progressReactions
    .filter(
      (reaction) =>
        reaction.user?.login === CODEX_BOT &&
        reaction.content === "eyes" &&
        timestamp(reaction.created_at) >= timestamp(requestedAt),
    )
    .reduce((latest, reaction) => Math.max(latest, timestamp(reaction.created_at)), 0);

  for (const comment of reviewComments) {
    if (
      comment.user?.login === CODEX_BOT &&
      (comment.original_commit_id ?? comment.commit_id) === headSha &&
      timestamp(comment.created_at) >= timestamp(requestedAt) &&
      findingPriority(comment.body)
    ) {
      if (isBlockingFinding(comment.body)) {
        completions.push({
          state: "failure",
          at: timestamp(comment.created_at),
          description: "Codex ha trovato problemi nell'ultimo commit",
        });
      } else {
        advisoryFindings.push(timestamp(comment.created_at));
      }
    }
  }

  for (const comment of comments) {
    if (comment.user?.login !== CODEX_BOT) continue;

    const commit = reviewedCommit(comment.body);
    const currentFinding =
      (commit ? headSha.startsWith(commit) : timestamp(requestedAt) > 0) &&
      timestamp(comment.created_at) >= timestamp(requestedAt) &&
      findingPriority(comment.body);
    if (currentFinding) {
      if (isBlockingFinding(comment.body)) {
        completions.push({
          state: "failure",
          at: timestamp(comment.created_at),
          description: "Codex ha trovato problemi nell'ultimo commit",
        });
      } else if (commit && headSha.startsWith(commit)) {
        advisoryFindings.push(timestamp(comment.created_at));
      }
    }

    if (
      commit &&
      headSha.startsWith(commit) &&
      timestamp(comment.created_at) >= timestamp(requestedAt) &&
      /^Codex Review: Didn't find any major issues\./m.test(comment.body)
    ) {
      completions.push({
        state: "success",
        at: timestamp(comment.created_at),
        description: "Codex ha approvato l'ultimo commit",
      });
    }

    if (
      timestamp(requestedAt) > 0 &&
      timestamp(comment.created_at) >= timestamp(requestedAt) &&
      now - timestamp(requestedAt) >= 30_000 &&
      timestamp(comment.created_at) >= latestEyesAt &&
      /reached your Codex usage limits|could not complete|unable to review|something went wrong|unknown error/i.test(
        comment.body,
      )
    ) {
      completions.push({
        state: "failure",
        at: timestamp(comment.created_at),
        description: "La review Codex non è stata completata",
      });
    }
  }

  const commentFailure = completions
    .filter((completion) => completion.state === "failure")
    .sort((left, right) => right.at - left.at)[0];
  if (commentFailure) return commentFailure;

  for (const review of reviews) {
    const commit = review.commit_id ?? reviewedCommit(review.body);
    if (
      review.user?.login === CODEX_BOT &&
      commit &&
      headSha.startsWith(commit) &&
      timestamp(review.submitted_at) >= timestamp(requestedAt)
    ) {
      cleanComments.push(timestamp(review.submitted_at));
    }
  }

  const latestAdvisoryAt = Math.max(...advisoryFindings, 0);
  const matchingReviewAt = cleanComments
    .filter((reviewAt) => Math.abs(reviewAt - latestAdvisoryAt) <= ADVISORY_SETTLING_MS)
    .sort((left, right) => right - left)[0];
  if (
    latestAdvisoryAt &&
    matchingReviewAt &&
    now - Math.max(latestAdvisoryAt, matchingReviewAt) >= ADVISORY_SETTLING_MS
  ) {
    completions.push({
      state: "success",
      at: Math.max(latestAdvisoryAt, matchingReviewAt),
      description: "Codex ha completato la review con soli finding advisory",
    });
  }

  const thumbsUpAt = reactions
    .filter(
      (reaction) =>
        reaction.user?.login === CODEX_BOT &&
        reaction.content === "+1" &&
        timestamp(reaction.created_at) >= timestamp(requestedAt),
    )
    .reduce((latest, reaction) => Math.max(latest, timestamp(reaction.created_at)), 0);
  const exactThumbsUpAt = exactReactions
    .filter(
      (reaction) =>
        timestamp(requestedAt) > 0 &&
        reaction.user?.login === CODEX_BOT &&
        reaction.content === "+1" &&
        timestamp(reaction.created_at) >= timestamp(requestedAt),
    )
    .reduce((latest, reaction) => Math.max(latest, timestamp(reaction.created_at)), 0);

  if (thumbsUpAt) {
    if (!requiresReviewedCommit || exactThumbsUpAt) {
      cleanComments.push(exactThumbsUpAt || thumbsUpAt);
    }
    for (const commentAt of cleanComments) {
      if (thumbsUpAt < commentAt) continue;
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

export const hasSuccessfulCodexStatus = (statuses) =>
  statuses.find((status) => status.context === "codex-review")?.state === "success";

export const latestCodexInvocation = (comments, requestedAt) =>
  comments
    .filter(
      (comment) =>
        timestamp(requestedAt) > 0 &&
        comment.user?.login !== CODEX_BOT &&
        /@codex\s+review\b/i.test(comment.body) &&
        timestamp(comment.created_at) > timestamp(requestedAt),
    )
    .sort((left, right) => timestamp(right.created_at) - timestamp(left.created_at))[0];

export function pullRequestNumber(event, input) {
  const number = String(event.pull_request?.number ?? input);
  if (!/^\d+$/.test(number)) throw new Error("Numero PR non valido");
  return number;
}

export const isRetryableGitHubResponse = (status, remaining, retryAfter = null, body = "") =>
  status === 429 ||
  status >= 500 ||
  (status === 403 &&
    (remaining === "0" ||
      retryAfter !== null ||
      /secondary rate limit|abuse detection/i.test(body)));

export function githubRetryDelay(retryAfter, remaining, resetAt, now = Date.now()) {
  const retryAfterSeconds = Number(retryAfter);
  if (retryAfter !== null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return retryAfterSeconds * 1000;
  }
  const resetAtSeconds = Number(resetAt);
  return remaining === "0" && resetAt !== null && Number.isFinite(resetAtSeconds)
    ? Math.max(0, resetAtSeconds * 1000 - now)
    : 0;
}

export const githubPollTiming = (remainingMs, retryDelayMs) =>
  retryDelayMs > remainingMs
    ? { pollDelayMs: null, terminalDelayMs: retryDelayMs }
    : {
        pollDelayMs: Math.min(remainingMs, Math.max(CODEX_REVIEW_POLLING.intervalMs, retryDelayMs)),
        terminalDelayMs: 0,
      };

export const githubStatusRetryDelay = (error) =>
  error instanceof TypeError || error.retryable
    ? Math.max(CODEX_REVIEW_POLLING.intervalMs, error.retryAfterMs ?? 0)
    : null;

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
  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`${options.method ?? "GET"} ${path}: ${response.status}`);
    error.retryable = isRetryableGitHubResponse(
      response.status,
      response.headers.get("x-ratelimit-remaining"),
      response.headers.get("retry-after"),
      body,
    );
    error.retryAfterMs = githubRetryDelay(
      response.headers.get("retry-after"),
      response.headers.get("x-ratelimit-remaining"),
      response.headers.get("x-ratelimit-reset"),
    );
    throw error;
  }
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
  for (;;) {
    try {
      await request(`/repos/${repository}/statuses/${sha}`, {
        method: "POST",
        body: JSON.stringify({
          state,
          context: "codex-review",
          description,
          target_url: `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`,
        }),
      });
      return;
    } catch (error) {
      const delayMs = githubStatusRetryDelay(error);
      if (delayMs === null) throw error;
      console.warn(`Scrittura status GitHub transitoria, nuovo tentativo: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function reviewSignals(repository, number, requestedAt) {
  const [comments, reactions, reviews, reviewComments] = await Promise.all([
    all(`/repos/${repository}/issues/${number}/comments`),
    all(`/repos/${repository}/issues/${number}/reactions`),
    all(`/repos/${repository}/pulls/${number}/reviews`),
    all(`/repos/${repository}/pulls/${number}/comments`),
  ]);
  const invocation = latestCodexInvocation(comments, requestedAt);
  const invocationReactions = invocation
    ? await all(`/repos/${repository}/issues/comments/${invocation.id}/reactions`)
    : [];
  return [
    comments,
    [...reactions, ...invocationReactions],
    reviews,
    reviewComments,
    invocationReactions,
  ];
}

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
  const reusesExistingReview =
    process.env.GITHUB_EVENT_NAME === "workflow_dispatch" || event.action === "reopened";
  const deadline =
    Date.now() +
    CODEX_REVIEW_POLLING.attempts * CODEX_REVIEW_POLLING.intervalMs -
    CODEX_REVIEW_POLLING.marginMs;

  if (reusesExistingReview) {
    const statuses = await all(`/repos/${repository}/commits/${headSha}/statuses`);
    if (hasSuccessfulCodexStatus(statuses)) return;
  }

  await setStatus(
    repository,
    headSha,
    "pending",
    "In attesa della review Codex sull'ultimo commit",
  );
  if (pullRequest.draft) return;

  if (["opened", "ready_for_review"].includes(event.action)) {
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    const currentPullRequest = await request(`/repos/${repository}/pulls/${number}`);
    if (currentPullRequest.head.sha !== headSha) return;
  }

  const freshReview = ["opened", "ready_for_review"].includes(event.action);
  const requestedAt = reusesExistingReview ? 0 : pullRequest.updated_at;
  let terminalDelayMs = 0;
  for (;;) {
    let signals;
    let retryDelayMs = 0;
    try {
      signals = await reviewSignals(repository, number, requestedAt);
    } catch (error) {
      if (!(error instanceof TypeError) && !error.retryable) throw error;
      console.warn(`Lettura GitHub transitoria, nuovo tentativo: ${error.message}`);
      retryDelayMs = error.retryAfterMs ?? 0;
    }
    if (signals) {
      const [comments, reactions, reviews, reviewComments, exactReactions] = signals;
      const result = classifyCodexReview({
        headSha,
        requestedAt,
        comments,
        exactReactions,
        reactions,
        requiresReviewedCommit: !freshReview,
        reviews,
        reviewComments,
      });
      if (result.state !== "pending") {
        await setStatus(repository, headSha, result.state, result.description);
        return;
      }
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const timing = githubPollTiming(remainingMs, retryDelayMs);
    if (timing.pollDelayMs === null) {
      terminalDelayMs = timing.terminalDelayMs;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, timing.pollDelayMs));
  }

  if (terminalDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, terminalDelayMs));
  }
  await setStatus(repository, headSha, "error", "Review Codex non conclusa entro cinque ore");
}

if (process.env.GITHUB_ACTIONS === "true" && import.meta.main) {
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
