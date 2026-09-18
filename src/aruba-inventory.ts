import { ARUBA_API_POLICY } from "./aruba-api-policy.ts";

export interface ArubaApprovalInventoryState {
  blockingReason: "NEVER" | "STALE" | "FAILURE" | "CONFLICT" | null;
  ageMinutes: number | null;
  activeSession: boolean;
  uncertainRemoteStates: number;
}

/**
 * I match riferibili a preparazioni precise bloccano soltanto le candidate. Restano
 * Una collisione fra ID noti e confrontati mantiene il blocco sulle sole candidate.
 * Restano globali l'assenza o l'obsolescenza dell'inventario, i fallimenti e gli stati remoti incerti.
 * Per approvare o inviare, l'inventario canonico deve inoltre avere al massimo cinque minuti:
 * la stessa regola alimenta proiezione UI, transazione di approvazione e pre-invio.
 * Un giro in corso non invalida un inventario completo e fresco: ogni pagina viene salvata
 * sotto il lock letto dal gate e un conflitto emerso a metà giro blocca subito.
 */
export function arubaInventoryApprovalState(
  health: ArubaApprovalInventoryState,
): "CHECKING" | "BLOCKED" | "REFRESH_REQUIRED" | "READY" {
  const problem = health.blockingReason === "FAILURE" || health.uncertainRemoteStates > 0;
  const fresh = (health.ageMinutes ?? Infinity) * 60_000 <= ARUBA_API_POLICY.approvalFreshnessMs;
  if (fresh && !problem) return "READY";
  if (health.activeSession) return "CHECKING";
  return problem ? "BLOCKED" : "REFRESH_REQUIRED";
}

export function arubaInventoryBlocksAllApprovals(health: ArubaApprovalInventoryState) {
  return arubaInventoryApprovalState(health) !== "READY";
}
