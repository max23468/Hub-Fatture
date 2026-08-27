export const ARUBA_API_POLICY = Object.freeze({
  authenticationIntervalMs: 60_100,
  invoiceReadIntervalMs: 6_100,
  notificationReadIntervalMs: 6_100,
  providerCooldownMs: 65 * 60_000,
  requestLimitPerRun: 10_000,
  backfillWindowMs: 48 * 60 * 60_000,
});

export type ArubaApiReadScope = "INVOICE_READ" | "NOTIFICATION_READ";

export function arubaApiReadIntervalMs(scope: ArubaApiReadScope) {
  return scope === "INVOICE_READ"
    ? ARUBA_API_POLICY.invoiceReadIntervalMs
    : ARUBA_API_POLICY.notificationReadIntervalMs;
}
