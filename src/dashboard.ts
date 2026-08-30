export const SALES_CHANNEL_WARNING_AGE_MS = 20 * 60_000;
export const SALES_CHANNEL_BLOCKING_AGE_MS = 60 * 60_000;

export interface DashboardConnectionFreshnessInput {
  connected: boolean;
  lastUpdatedAt: string | null;
  now: string;
  warningAgeMs?: number;
  blockingAgeMs?: number;
  providerStatus?: "HEALTHY" | "WARNING" | "BLOCKED" | "NEVER";
}

export function dashboardConnectionFreshness(input: DashboardConnectionFreshnessInput) {
  if (!input.connected || !input.lastUpdatedAt) {
    return { stale: true, blocking: true };
  }
  if (input.providerStatus) {
    return {
      stale: input.providerStatus !== "HEALTHY",
      blocking: input.providerStatus === "BLOCKED" || input.providerStatus === "NEVER",
    };
  }
  const age = Math.max(0, new Date(input.now).getTime() - new Date(input.lastUpdatedAt).getTime());
  return {
    stale: age > (input.warningAgeMs ?? SALES_CHANNEL_WARNING_AGE_MS),
    blocking: age > (input.blockingAgeMs ?? SALES_CHANNEL_BLOCKING_AGE_MS),
  };
}
