import type { Route } from "./+types/aruba-sync-complete";
import { arubaSyncResponse } from "../aruba-sync-response";

import { completeStableArubaInventory } from "../../src/db/aruba-inventory-cycle.server.ts";
import { arubaReadBearer } from "../../src/db/aruba-read-session.server.ts";
import { readJson } from "../../src/http.server.ts";

export async function action({ request }: Route.ActionArgs) {
  return arubaSyncResponse(async () => {
    const body = (await readJson(request)) as {
      streams?: unknown;
      scanOrdinal?: unknown;
      fullScan?: unknown;
    };
    return completeStableArubaInventory(
      arubaReadBearer(request),
      body.streams,
      body.scanOrdinal,
      body.fullScan,
    );
  });
}
