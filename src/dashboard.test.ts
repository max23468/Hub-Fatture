import assert from "node:assert/strict";
import test from "node:test";

import {
  dashboardConnectionFreshness,
  SALES_CHANNEL_BLOCKING_AGE_MS,
  SALES_CHANNEL_WARNING_AGE_MS,
} from "./dashboard.ts";

const now = "2026-08-30T10:00:00.000Z";

test("la Dashboard applica le soglie 20/60 minuti ai canali di vendita", () => {
  assert.deepEqual(
    dashboardConnectionFreshness({
      connected: true,
      lastUpdatedAt: new Date(Date.parse(now) - SALES_CHANNEL_WARNING_AGE_MS).toISOString(),
      now,
    }),
    { stale: false, blocking: false },
  );
  assert.deepEqual(
    dashboardConnectionFreshness({
      connected: true,
      lastUpdatedAt: new Date(Date.parse(now) - SALES_CHANNEL_WARNING_AGE_MS - 1).toISOString(),
      now,
    }),
    { stale: true, blocking: false },
  );
  assert.deepEqual(
    dashboardConnectionFreshness({
      connected: true,
      lastUpdatedAt: new Date(Date.parse(now) - SALES_CHANNEL_BLOCKING_AGE_MS - 1).toISOString(),
      now,
    }),
    { stale: true, blocking: true },
  );
});

test("lo stato Aruba deriva dalla salute dell'inventario, non dai batch documentali", () => {
  assert.deepEqual(
    dashboardConnectionFreshness({
      connected: true,
      lastUpdatedAt: "2026-08-30T09:45:00.000Z",
      now,
      providerStatus: "HEALTHY",
    }),
    { stale: false, blocking: false },
  );
  assert.deepEqual(
    dashboardConnectionFreshness({
      connected: true,
      lastUpdatedAt: "2026-08-30T09:45:00.000Z",
      now,
      providerStatus: "WARNING",
    }),
    { stale: true, blocking: false },
  );
  assert.deepEqual(
    dashboardConnectionFreshness({
      connected: true,
      lastUpdatedAt: "2026-08-30T09:45:00.000Z",
      now,
      providerStatus: "BLOCKED",
    }),
    { stale: true, blocking: true },
  );
});

test("un collegamento assente o disconnesso richiede sempre attenzione", () => {
  assert.deepEqual(dashboardConnectionFreshness({ connected: false, lastUpdatedAt: now, now }), {
    stale: true,
    blocking: true,
  });
  assert.deepEqual(dashboardConnectionFreshness({ connected: true, lastUpdatedAt: null, now }), {
    stale: true,
    blocking: true,
  });
});
