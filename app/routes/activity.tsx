import { useLoaderData } from "react-router";
import type { Route } from "./+types/activity";

import { AppShell } from "../components/app-shell";
import { ActivityHistoryView } from "../components/activity-view";
import { Pager } from "../components/pager";
import { copy } from "../copy.it";
import { privateRouteMeta } from "../metadata";
import { parseSort } from "../table-sort";
import { requireSessionUser } from "../../src/db/auth.server.ts";
import { listAuditHistory, type AuditHistorySortKey } from "../../src/db/order-queries.server.ts";
import { pageNumber } from "../../src/orders.ts";

export function meta({ error }: Route.MetaArgs) {
  return privateRouteMeta("activity", { error });
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const url = new URL(request.url);
  const page = pageNumber(url.searchParams.get("pagina") ?? 1);
  const query = url.searchParams.get("q") ?? "";
  const action = url.searchParams.get("azione") ?? "";
  const sort = parseSort(
    url.searchParams.get("ordina"),
    url.searchParams.get("direzione"),
    ["attivita", "elemento", "autore", "quando"] as const,
    { key: "quando" as AuditHistorySortKey, direction: "desc" },
  );
  const history = await listAuditHistory({
    query: query || undefined,
    action: action || undefined,
    page,
    sort,
  });
  return {
    username: user.username,
    canApprove: user.canApprove,
    csrfToken: user.csrfToken,
    page,
    query,
    action,
    sort,
    history,
  };
}

export default function Activity() {
  const { username, canApprove, csrfToken, page, query, action, sort, history } =
    useLoaderData<typeof loader>();
  return (
    <AppShell username={username} canApprove={canApprove} csrfToken={csrfToken}>
      <div className="title-block dashboard-title activity-title">
        <p className="eyebrow">{copy.activity.eyebrow}</p>
        <h1>{copy.activity.title}</h1>
        <p>{copy.activity.intro}</p>
      </div>
      <ActivityHistoryView action={action} events={history.rows} query={query} sort={sort} />
      <Pager basePath="/attivita" hasNext={history.hasNext} page={page} />
    </AppShell>
  );
}
