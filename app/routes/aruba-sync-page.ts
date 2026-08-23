import type { Route } from "./+types/aruba-sync-page";
import { arubaSyncResponse } from "../aruba-sync-response";

import { ingestArubaInventoryPage } from "../../src/db/aruba-inbound.server.ts";
import { arubaReadBearer } from "../../src/db/aruba-read-session.server.ts";
import { readArubaInventoryJson } from "../../src/http.server.ts";

export async function action({ request }: Route.ActionArgs) {
  return arubaSyncResponse(async () =>
    ingestArubaInventoryPage(arubaReadBearer(request), await readArubaInventoryJson(request)),
  );
}
