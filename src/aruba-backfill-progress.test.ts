import assert from "node:assert/strict";
import test from "node:test";

import { calculateArubaBackfillProgress } from "./aruba-backfill-progress.ts";

test("il progresso del backfill usa soltanto finestre consolidate e stima la lineage", () => {
  assert.deepEqual(
    calculateArubaBackfillProgress({
      kind: "BACKFILL",
      status: "RUNNING",
      windowStart: new Date("2026-01-01T00:00:00.000Z"),
      windowEnd: new Date("2026-01-11T00:00:00.000Z"),
      checkpointStart: new Date("2026-01-05T00:00:00.000Z"),
      lineageStartedAt: new Date("2026-02-01T00:00:00.000Z"),
      now: new Date("2026-02-02T00:00:00.000Z"),
      completedAt: null,
    }),
    {
      percent: 40,
      coveredThrough: "2026-01-05T00:00:00.000Z",
      totalWindows: 5,
      remainingWindows: 3,
      estimatedRemainingMinutes: 2_160,
      estimatedCompletionAt: "2026-02-03T12:00:00.000Z",
    },
  );
});

test("il progresso completato è 100% e non usa il budget richieste", () => {
  const completedAt = new Date("2026-02-02T00:00:00.000Z");
  assert.deepEqual(
    calculateArubaBackfillProgress({
      kind: "FULL",
      status: "COMPLETED",
      windowStart: new Date("2026-01-01T00:00:00.000Z"),
      windowEnd: new Date("2026-01-03T00:00:00.000Z"),
      checkpointStart: new Date("2026-01-01T00:00:00.000Z"),
      lineageStartedAt: new Date("2026-02-01T00:00:00.000Z"),
      completedAt,
    }),
    {
      percent: 100,
      coveredThrough: "2026-01-03T00:00:00.000Z",
      totalWindows: 1,
      remainingWindows: 0,
      estimatedRemainingMinutes: null,
      estimatedCompletionAt: completedAt.toISOString(),
    },
  );
  assert.equal(
    calculateArubaBackfillProgress({
      kind: "INCREMENTAL",
      status: "RUNNING",
      windowStart: new Date("2026-01-01T00:00:00.000Z"),
      windowEnd: new Date("2026-01-03T00:00:00.000Z"),
      checkpointStart: new Date("2026-01-01T00:00:00.000Z"),
      lineageStartedAt: new Date("2026-02-01T00:00:00.000Z"),
      completedAt: null,
    }),
    null,
  );
});
