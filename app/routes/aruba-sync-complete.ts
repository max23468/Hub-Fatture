import type { Route } from "./+types/aruba-sync-complete";
import { arubaSyncResponse } from "../aruba-sync-response";

import { arubaReadBearer, completeArubaInventory } from "../../src/db/aruba-inbound.server.ts";
import { markArubaInventoryIncomplete } from "../../src/db/aruba-session-state.server.ts";
import { AppError } from "../../src/errors.ts";
import { readJson } from "../../src/http.server.ts";

export async function action({ request }: Route.ActionArgs) {
  return arubaSyncResponse(async () => {
    const body = (await readJson(request)) as {
      streams?: unknown;
      scanOrdinal?: unknown;
      fullScan?: unknown;
    };
    const token = arubaReadBearer(request);
    try {
      return await completeArubaInventory(
        token,
        body.streams,
        body.scanOrdinal,
        body.fullScan,
      );
    } catch (error) {
      if (error instanceof AppError && error.code === "ARUBA_INVENTORY_INCOMPLETE") {
        await markArubaInventoryIncomplete(token);
      }
      throw error;
    }
  });
}
