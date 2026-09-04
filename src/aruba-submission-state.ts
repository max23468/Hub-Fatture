import { remoteStatusTransition, type ArubaRemoteStatus } from "./aruba-inbound.ts";

export const monitoredArubaSubmissionStatuses = [
  "ARUBA_ACCEPTED",
  "SDI_PROCESSING",
  "SUBMITTED",
  "UNKNOWN",
  "UNKNOWN_REMOTE_STATE",
] as const;

export type MonitoredArubaSubmissionStatus = (typeof monitoredArubaSubmissionStatuses)[number];

export type ArubaReadbackStatus = ArubaRemoteStatus;

export type ArubaSubmissionTransition = "SAME" | "ADVANCE" | "STALE" | "CONFLICT";

const terminalStatuses = new Set<ArubaReadbackStatus>(["DELIVERED", "NOT_DELIVERED", "REJECTED"]);

export function arubaSubmissionTransition(
  current: MonitoredArubaSubmissionStatus | ArubaReadbackStatus,
  observed: ArubaReadbackStatus,
): ArubaSubmissionTransition {
  if (current === observed) return "SAME";
  if (current === "ARUBA_ACCEPTED" || current === "UNKNOWN_REMOTE_STATE") return "ADVANCE";
  const transition = remoteStatusTransition(current as ArubaRemoteStatus, observed);
  if (transition === "APPLY") return "ADVANCE";
  return transition === "CONFLICT" ? "CONFLICT" : "STALE";
}

export function arubaSubmissionIsTerminal(status: string) {
  return terminalStatuses.has(status as ArubaReadbackStatus);
}

export function arubaSubmissionJobPriority(status: string, manual = false) {
  if (status === "UNKNOWN_REMOTE_STATE") return 10;
  if (status === "ARUBA_ACCEPTED") return 20;
  if (["SDI_PROCESSING", "SUBMITTED", "UNKNOWN"].includes(status)) return 30;
  return manual ? 40 : 50;
}
