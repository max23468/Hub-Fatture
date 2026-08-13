import type { Route } from "./+types/aruba-sync-heartbeat";
import { arubaSyncResponse } from "../aruba-sync-response";

import { arubaReadBearer, heartbeatArubaReadSession } from "../../src/db/aruba-inbound.server.ts";
import { readJson } from "../../src/http.server.ts";

export async function action({ request }: Route.ActionArgs) {
  return arubaSyncResponse(async () => {
    const body = (await readJson(request)) as { helperVersion?: unknown; browser?: unknown };
    await heartbeatArubaReadSession(arubaReadBearer(request), body);
    return { ok: true };
  });
}
