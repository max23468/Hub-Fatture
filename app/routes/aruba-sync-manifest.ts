import type { Route } from "./+types/aruba-sync-manifest";
import { arubaSyncResponse } from "../aruba-sync-response";

import { getConfig } from "../../src/config.server.ts";
import { arubaReadBearer, arubaReadManifest } from "../../src/db/aruba-inbound.server.ts";

export async function loader({ request }: Route.LoaderArgs) {
  return arubaSyncResponse(
    async () => ({
      ...(await arubaReadManifest(arubaReadBearer(request))),
      accountIdentity: getConfig().ARUBA_ACCOUNT_IDENTITY,
    }),
    { "Cache-Control": "no-store" },
  );
}
