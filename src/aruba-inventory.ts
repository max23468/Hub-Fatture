export interface ArubaApprovalInventoryState {
  blockingReason: "NEVER" | "STALE" | "FAILURE" | "CONFLICT" | null;
  uncertainRemoteStates: number;
}

/**
 * I match riferibili a preparazioni precise bloccano soltanto le candidate. Restano
 * globali l'assenza o l'obsolescenza dell'inventario, i fallimenti e gli stati remoti incerti.
 */
export function arubaInventoryBlocksAllApprovals(health: ArubaApprovalInventoryState) {
  return (
    health.blockingReason === "NEVER" ||
    health.blockingReason === "STALE" ||
    health.blockingReason === "FAILURE" ||
    health.uncertainRemoteStates > 0
  );
}
