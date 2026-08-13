import type { Route } from "./+types/aruba-sync-manifest";
import { arubaSyncResponse } from "../aruba-sync-response";

import { arubaReadBearer, arubaReadManifest } from "../../src/db/aruba-inbound.server.ts";

export async function loader({ request }: Route.LoaderArgs) {
  return arubaSyncResponse(() => arubaReadManifest(arubaReadBearer(request)), {
    "Cache-Control": "no-store",
  });
}
