export const ARUBA_API_POLICY = Object.freeze({
  inventoryStart: "2026-07-01T00:00:00.000Z",
  authenticationIntervalMs: 60_100,
  invoiceReadIntervalMs: 6_100,
  notificationReadIntervalMs: 6_100,
  providerReadIntervalMinimumMs: 5_000,
  providerCooldownMs: 65 * 60_000,
  requestLimitPerRun: 10_000,
  backfillWindowMs: 48 * 60 * 60_000,
});

export type ArubaApiReadScope = "INVOICE_READ" | "NOTIFICATION_READ";

export function configuredArubaApiReadIntervalMs(configuredIntervalMs: number) {
  return Math.max(configuredIntervalMs, ARUBA_API_POLICY.providerReadIntervalMinimumMs);
}
