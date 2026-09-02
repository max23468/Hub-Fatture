import type { Route } from "./+types/order-approval-candidates";

import { arubaInventoryBlocksAllApprovals } from "../../src/aruba-inventory.ts";
import { getArubaInventoryHealth } from "../../src/db/aruba-inventory-health.server.ts";
import { requireSessionUser } from "../../src/db/auth.server.ts";
import { listMassApprovalCandidates } from "../../src/db/document-mass-approval.server.ts";
import { getArubaSettings } from "../../src/db/aruba.server.ts";

export interface MassApprovalData {
  approvalCandidates: Awaited<ReturnType<typeof listMassApprovalCandidates>>;
  arubaMode: string;
  arubaConfiguredMode: string;
  arubaDowngradeRequired: boolean;
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  if (!user.canApprove) {
    return Response.json({
      approvalCandidates: [],
      arubaMode: "DOCUMENT_ONLY",
      arubaConfiguredMode: "DOCUMENT_ONLY",
      arubaDowngradeRequired: false,
    } satisfies MassApprovalData);
  }

  const [arubaInventory, approvalCandidates, arubaSettings] = await Promise.all([
    getArubaInventoryHealth(),
    listMassApprovalCandidates(),
    getArubaSettings(),
  ]);
  const approvalsGloballyBlocked = arubaInventoryBlocksAllApprovals(arubaInventory);
  return Response.json({
    approvalCandidates: approvalsGloballyBlocked ? [] : approvalCandidates,
    arubaMode: arubaSettings.effectiveMode,
    arubaConfiguredMode: arubaSettings.mode.value,
    arubaDowngradeRequired: arubaSettings.mode.value !== arubaSettings.effectiveMode,
  } satisfies MassApprovalData);
}
