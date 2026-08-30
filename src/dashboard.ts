export const SALES_CHANNEL_WARNING_AGE_MS = 20 * 60_000;
export const SALES_CHANNEL_BLOCKING_AGE_MS = 60 * 60_000;
export const ARUBA_SYNC_WARNING_AGE_MS = 30 * 60_000;
export const ARUBA_SYNC_BLOCKING_AGE_MS = 4 * 60 * 60_000;

export type DashboardArubaConnectionState =
  | "CONNECTED"
  | "SYNCING"
  | "PAUSED"
  | "STALE"
  | "FAILED"
  | "NEVER_SYNCED"
  | "NOT_CONNECTED";

export interface DashboardArubaConnectionInput {
  configured: boolean;
  connectionStatus:
    | "NOT_CONFIGURED"
    | "PAUSED"
    | "CONNECTED"
    | "REAUTH_REQUIRED"
    | "REVOKED"
    | "ERROR";
  apiPaused: boolean;
  inboundEnabled: boolean;
  activeSync: boolean;
  lastCompletedAt: string | null;
  syncFailed: boolean;
  now: string;
}

export function dashboardArubaConnectionState(input: DashboardArubaConnectionInput): {
  state: DashboardArubaConnectionState;
  attention: boolean;
  blocking: boolean;
} {
  if (!input.configured || ["NOT_CONFIGURED", "REVOKED"].includes(input.connectionStatus)) {
    return { state: "NOT_CONNECTED", attention: true, blocking: true };
  }
  if (["REAUTH_REQUIRED", "ERROR"].includes(input.connectionStatus)) {
    return { state: "FAILED", attention: true, blocking: true };
  }
  if (input.apiPaused || !input.inboundEnabled || input.connectionStatus === "PAUSED") {
    return { state: "PAUSED", attention: true, blocking: true };
  }
  if (input.activeSync) {
    return { state: "SYNCING", attention: false, blocking: false };
  }
  if (input.syncFailed) {
    return { state: "FAILED", attention: true, blocking: true };
  }
  if (!input.lastCompletedAt) {
    return { state: "NEVER_SYNCED", attention: true, blocking: true };
  }
  const age = Math.max(
    0,
    new Date(input.now).getTime() - new Date(input.lastCompletedAt).getTime(),
  );
  if (age > ARUBA_SYNC_BLOCKING_AGE_MS) {
    return { state: "STALE", attention: true, blocking: true };
  }
  if (age > ARUBA_SYNC_WARNING_AGE_MS) {
    return { state: "STALE", attention: true, blocking: false };
  }
  return { state: "CONNECTED", attention: false, blocking: false };
}

export interface DashboardConnectionFreshnessInput {
  connected: boolean;
  lastUpdatedAt: string | null;
  now: string;
  warningAgeMs?: number;
  blockingAgeMs?: number;
}

export function dashboardConnectionFreshness(input: DashboardConnectionFreshnessInput) {
  if (!input.connected || !input.lastUpdatedAt) {
    return { stale: true, blocking: true };
  }
  const age = Math.max(0, new Date(input.now).getTime() - new Date(input.lastUpdatedAt).getTime());
  return {
    stale: age > (input.warningAgeMs ?? SALES_CHANNEL_WARNING_AGE_MS),
    blocking: age > (input.blockingAgeMs ?? SALES_CHANNEL_BLOCKING_AGE_MS),
  };
}
