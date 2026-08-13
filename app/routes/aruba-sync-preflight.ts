import type { Route } from "./+types/aruba-sync-preflight";
import { arubaSyncResponse } from "../aruba-sync-response";

import {
  arubaReadBearer,
  completeArubaPreflight,
  listArubaPreflightWork,
} from "../../src/db/aruba-inbound.server.ts";
import { readJson } from "../../src/http.server.ts";

export async function loader({ request }: Route.LoaderArgs) {
  return arubaSyncResponse(() => listArubaPreflightWork(arubaReadBearer(request)), {
    "Cache-Control": "no-store",
  });
}

export async function action({ request }: Route.ActionArgs) {
  return arubaSyncResponse(async () => {
    const body = (await readJson(request)) as Parameters<typeof completeArubaPreflight>[1];
    return completeArubaPreflight(arubaReadBearer(request), body);
  });
}
