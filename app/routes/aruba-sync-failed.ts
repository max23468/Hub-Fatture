import type { Route } from "./+types/aruba-sync-failed";
import { arubaSyncResponse } from "../aruba-sync-response";

import { failArubaInventory } from "../../src/db/aruba-inbound.server.ts";
import { arubaReadBearer } from "../../src/db/aruba-read-session.server.ts";
import { readJson } from "../../src/http.server.ts";

export async function action({ request }: Route.ActionArgs) {
  return arubaSyncResponse(async () => {
    const body = (await readJson(request)) as { code?: unknown };
    await failArubaInventory(arubaReadBearer(request), body.code);
    return { ok: true };
  });
}
