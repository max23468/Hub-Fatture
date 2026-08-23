import type { Route } from "./+types/aruba-sync-manifest";
import { arubaSyncResponse } from "../aruba-sync-response";

import { getConfig } from "../../src/config.server.ts";
import { arubaInventoryManifest } from "../../src/db/aruba-inventory-cycle.server.ts";
import { arubaReadBearer } from "../../src/db/aruba-read-session.server.ts";

export async function loader({ request }: Route.LoaderArgs) {
  return arubaSyncResponse(
    async () => ({
      ...(await arubaInventoryManifest(arubaReadBearer(request))),
      accountIdentity: getConfig().ARUBA_ACCOUNT_IDENTITY,
    }),
    { "Cache-Control": "no-store" },
  );
}
