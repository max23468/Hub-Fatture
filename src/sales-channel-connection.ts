export type SalesChannelConnectionStatus =
  | "CONNECTED"
  | "REAUTH_REQUIRED"
  | "REVOKED"
  | "ERROR"
  | null
  | undefined;

export type SalesChannelConnectionState =
  | "CONNECTED"
  | "SYNC_FAILED"
  | "REAUTH_REQUIRED"
  | "NOT_CONNECTED";

/**
 * Il collegamento descrive la credenziale verso il canale; gli errori di importazione
 * appartengono invece alla sincronizzazione e non rendono falso il collegamento.
 */
export function salesChannelConnectionState(
  status: SalesChannelConnectionStatus,
): SalesChannelConnectionState {
  if (status === "CONNECTED") return "CONNECTED";
  if (status === "ERROR") return "SYNC_FAILED";
  if (status === "REAUTH_REQUIRED") return "REAUTH_REQUIRED";
  return "NOT_CONNECTED";
}

export function salesChannelIsConnected(state: SalesChannelConnectionState): boolean {
  return state === "CONNECTED" || state === "SYNC_FAILED";
}
