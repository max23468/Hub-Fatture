import type { Route } from "./+types/aruba-sync-finish";
import { arubaSyncResponse } from "../aruba-sync-response";

import { finishStableArubaInventory } from "../../src/db/aruba-inventory-cycle.server.ts";
import { arubaReadBearer } from "../../src/db/aruba-read-session.server.ts";

export async function action({ request }: Route.ActionArgs) {
  return arubaSyncResponse(() => finishStableArubaInventory(arubaReadBearer(request)));
}
