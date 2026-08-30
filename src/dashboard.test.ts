import assert from "node:assert/strict";
import test from "node:test";

import {
  ARUBA_SYNC_WARNING_AGE_MS,
  dashboardArubaConnectionState,
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

test("Aruba resta collegata quando la sincronizzazione è fresca, senza dipendere dalle riconciliazioni", () => {
  assert.deepEqual(
    dashboardArubaConnectionState({
      configured: true,
      connectionStatus: "CONNECTED",
      apiPaused: false,
      inboundEnabled: true,
      activeSync: false,
      lastCompletedAt: new Date(Date.parse(now) - ARUBA_SYNC_WARNING_AGE_MS).toISOString(),
      syncFailed: false,
      now,
    }),
    { state: "CONNECTED", attention: false, blocking: false },
  );
});

test("Aruba espone gli stati tecnici della sincronizzazione", () => {
  const base = {
    configured: true,
    connectionStatus: "CONNECTED" as const,
    apiPaused: false,
    inboundEnabled: true,
    activeSync: false,
    lastCompletedAt: now,
    syncFailed: false,
    now,
  };
  assert.deepEqual(dashboardArubaConnectionState({ ...base, activeSync: true }), {
    state: "SYNCING",
    attention: false,
    blocking: false,
  });
  assert.deepEqual(dashboardArubaConnectionState({ ...base, syncFailed: true }), {
    state: "FAILED",
    attention: true,
    blocking: true,
  });
  assert.deepEqual(
    dashboardArubaConnectionState({
      ...base,
      lastCompletedAt: new Date(Date.parse(now) - ARUBA_SYNC_WARNING_AGE_MS - 1).toISOString(),
    }),
    { state: "STALE", attention: true, blocking: false },
  );
});
