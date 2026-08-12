import { data, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/activity";

import { AppShell } from "../components/app-shell";
import { ActivityHistoryView, ManageActivityView } from "../components/activity-view";
import { Pager } from "../components/pager";
import { ViewNavigation } from "../components/view-navigation";
import { copy } from "../copy.it";
import { assertCsrf, requestId, requireSessionUser } from "../../src/db/auth.server.ts";
import { failedConnectorJobs, retryFailedJob } from "../../src/db/connectors.server.ts";
import { readForm } from "../../src/http.server.ts";
import { listAuditHistory, listOpenActivities } from "../../src/db/orders.server.ts";
import { pageNumber } from "../../src/orders.ts";
import { publicError } from "../../src/errors.ts";

const emptyPage = { rows: [], hasNext: false, total: 0 };

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const url = new URL(request.url);
  const view = url.searchParams.get("vista") === "cronologia" ? "cronologia" : "gestire";
  const page = pageNumber(url.searchParams.get("pagina") ?? 1);
  const query = url.searchParams.get("q") ?? "";
  const action = url.searchParams.get("azione") ?? "";
  const activityKind = url.searchParams.get("tipo") === "note-credito" ? "CREDIT_NOTE" : undefined;
  const [open, history, failedJobs] = await Promise.all([
    view === "gestire" ? listOpenActivities(page, activityKind) : Promise.resolve(emptyPage),
    view === "cronologia"
      ? listAuditHistory({ query: query || undefined, action: action || undefined, page })
      : Promise.resolve(emptyPage),
    view === "gestire" && !activityKind ? failedConnectorJobs() : Promise.resolve([]),
  ]);
  return {
    username: user.username,
    canApprove: user.canApprove,
    csrfToken: user.csrfToken,
    view,
    page,
    query,
    action,
    activityKind,
    open,
    history,
    failedJobs,
    jobRetried: url.searchParams.get("job") === "riavviato",
  };
}

export async function action({ request }: Route.ActionArgs) {
  try {
    const user = await requireSessionUser(request);
    const form = await readForm(request);
    assertCsrf(user, form.get("csrf") ?? "");
    if (form.get("intent") === "retry-connector-job") {
      await retryFailedJob(form.get("jobId"), {
        type: "ADMIN",
        id: user.id,
        requestId: requestId(request),
      });
      return redirect("/attivita?job=riavviato");
    }
    throw new Response("Azione non supportata", { status: 400 });
  } catch (error) {
    if (error instanceof Response) throw error;
    const result = publicError(error);
    return data(result, { status: result.status });
  }
}

export default function Activity() {
  const {
    username,
    canApprove,
    csrfToken,
    view,
    page,
    query,
    action,
    activityKind,
    open,
    history,
    failedJobs,
    jobRetried,
  } = useLoaderData<typeof loader>();
  const actionError = useActionData() as { message: string } | undefined;
  return (
    <AppShell username={username} canApprove={canApprove} csrfToken={csrfToken}>
      <div className="title-block dashboard-title activity-title">
        <p className="eyebrow">{copy.activity.eyebrow}</p>
        <h1>{copy.activity.title}</h1>
        <p>{copy.activity.intro}</p>
      </div>

      <ViewNavigation
        active={view}
        label={copy.activity.viewsLabel}
        items={[
          { value: "gestire", label: copy.activity.toManage, to: "/attivita" },
          {
            value: "cronologia",
            label: copy.activity.history,
            to: "/attivita?vista=cronologia",
          },
        ]}
      />

      {jobRetried ? (
        <p className="notice" role="status">
          {copy.activity.jobRetried}
        </p>
      ) : null}
      {actionError ? (
        <p className="error" role="alert">
          {actionError.message}
        </p>
      ) : null}

      {view === "gestire" ? (
        <>
          {activityKind ? (
            <p className="filter-summary section-gap">
              <span>{copy.activity.creditNotesFilter(open.total)}</span>
              <Link to="/attivita">{copy.activity.clearFilters}</Link>
            </p>
          ) : null}
          <ManageActivityView csrfToken={csrfToken} failedJobs={failedJobs} open={open} />
        </>
      ) : (
        <ActivityHistoryView action={action} events={history.rows} query={query} />
      )}

      <Pager
        basePath="/attivita"
        hasNext={view === "gestire" ? open.hasNext : history.hasNext}
        page={page}
      />
    </AppShell>
  );
}
