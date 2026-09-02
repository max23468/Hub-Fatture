import { data } from "react-router";
import type { Route } from "./+types/controls-summary";

import { requireSessionUser } from "../../src/db/auth.server.ts";
import { readOperationalControlSummary } from "../../src/db/operational-controls.server.ts";

export async function loader({ request }: Route.LoaderArgs) {
  await requireSessionUser(request);
  return data(await readOperationalControlSummary(), {
    headers: { "Cache-Control": "private, no-store" },
  });
}
