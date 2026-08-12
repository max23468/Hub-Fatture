import { data } from "react-router";
import type { Route } from "./+types/search";

import { requireSessionUser } from "../../src/db/auth.server.ts";
import { emptyGlobalSearch, searchGlobal } from "../../src/db/search.server.ts";

export async function loader({ request }: Route.LoaderArgs) {
  await requireSessionUser(request);
  const query = new URL(request.url).searchParams.get("q") ?? "";
  try {
    return data(
      { ...(await searchGlobal(query)), failed: false },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return data(
      { ...emptyGlobalSearch(query.trim().slice(0, 100)), failed: true },
      { status: 500, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
