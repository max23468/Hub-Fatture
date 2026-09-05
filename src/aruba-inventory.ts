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
 */
export function arubaInventoryBlocksAllApprovals(health: ArubaApprovalInventoryState) {
  return (
    health.activeSession ||
    health.blockingReason === "NEVER" ||
    health.blockingReason === "STALE" ||
    health.blockingReason === "FAILURE" ||
    (health.ageMinutes ?? Infinity) > 5 ||
    health.uncertainRemoteStates > 0
  );
}
