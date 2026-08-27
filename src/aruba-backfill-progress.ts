import { ARUBA_API_POLICY } from "./aruba-api-policy.ts";

export interface ArubaBackfillProgressInput {
  kind: "BACKFILL" | "INCREMENTAL" | "TARGETED" | "FULL";
  status: "RUNNING" | "COMPLETED" | "FAILED" | "INCOMPLETE" | "CANCELLED";
  windowStart: Date;
  windowEnd: Date;
  checkpointStart: Date;
  lineageStartedAt: Date;
  completedAt: Date | null;
  now?: Date;
}

export function calculateArubaBackfillProgress(input: ArubaBackfillProgressInput) {
  if (input.kind !== "BACKFILL" && input.kind !== "FULL") return null;
  const windowStart = input.windowStart.getTime();
  const windowEnd = input.windowEnd.getTime();
  const coveredThrough = input.status === "COMPLETED" ? windowEnd : input.checkpointStart.getTime();
  const totalMs = Math.max(1, windowEnd - windowStart);
  const coveredMs = Math.max(0, Math.min(totalMs, coveredThrough - windowStart));
  const remainingMs = Math.max(0, totalMs - coveredMs);
  const percent = Math.round((coveredMs / totalMs) * 1_000) / 10;
  const totalWindows = Math.ceil(totalMs / ARUBA_API_POLICY.backfillWindowMs);
  const remainingWindows = Math.ceil(remainingMs / ARUBA_API_POLICY.backfillWindowMs);
  const observedAt = input.completedAt ?? input.now ?? new Date();
  const elapsedMs = Math.max(0, observedAt.getTime() - input.lineageStartedAt.getTime());
  const estimatedRemainingMs =
    coveredMs > 0 && remainingMs > 0 ? Math.ceil((elapsedMs * remainingMs) / coveredMs) : null;
  const estimatedCompletionAt =
    estimatedRemainingMs === null
      ? input.status === "COMPLETED"
        ? input.completedAt
        : null
      : new Date(observedAt.getTime() + estimatedRemainingMs);
  return {
    percent,
    coveredThrough: new Date(
      Math.min(windowEnd, Math.max(windowStart, coveredThrough)),
    ).toISOString(),
    totalWindows,
    remainingWindows,
    estimatedRemainingMinutes:
      estimatedRemainingMs === null ? null : Math.ceil(estimatedRemainingMs / 60_000),
    estimatedCompletionAt: estimatedCompletionAt?.toISOString() ?? null,
  };
}
