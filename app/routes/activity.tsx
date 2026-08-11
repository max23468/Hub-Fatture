import { data, Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/activity";

import { AppShell } from "../components/app-shell";
import { Pager } from "../components/pager";
import { ViewNavigation } from "../components/view-navigation";
import { auditActionLabel, auditActionLabels, copy } from "../copy.it";
import { dateTime } from "../format";
import { assertCsrf, requestId, requireSessionUser } from "../../src/db/auth.server.ts";
import {
  completeShopifyDataRequest,
  failedConnectorJobs,
  pendingShopifyDataRequests,
  retryFailedJob,
} from "../../src/db/connectors.server.ts";
import { readForm } from "../../src/http.server.ts";
import { listAuditHistory, listOpenActivities } from "../../src/db/orders.server.ts";
import { pageNumber } from "../../src/orders.ts";
import { publicError } from "../../src/errors.ts";

const emptyPage = { rows: [], hasNext: false };

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const url = new URL(request.url);
  const view = url.searchParams.get("vista") === "cronologia" ? "cronologia" : "gestire";
  const page = pageNumber(url.searchParams.get("pagina") ?? 1);
  const query = url.searchParams.get("q") ?? "";
  const action = url.searchParams.get("azione") ?? "";
  const [open, history, shopifyDataRequests, failedJobs] = await Promise.all([
    view === "gestire" ? listOpenActivities(page) : Promise.resolve(emptyPage),
    view === "cronologia"
      ? listAuditHistory({ query: query || undefined, action: action || undefined, page })
      : Promise.resolve(emptyPage),
    view === "gestire" ? pendingShopifyDataRequests() : Promise.resolve([]),
    view === "gestire" ? failedConnectorJobs() : Promise.resolve([]),
  ]);
  return {
    username: user.username,
    canApprove: user.canApprove,
    csrfToken: user.csrfToken,
    view,
    page,
    query,
    action,
    open,
    history,
    shopifyDataRequests,
    failedJobs,
    privacyCompleted: url.searchParams.get("privacy") === "chiusa",
    jobRetried: url.searchParams.get("job") === "riavviato",
  };
}

export async function action({ request }: Route.ActionArgs) {
  try {
    const user = await requireSessionUser(request);
    const form = await readForm(request);
    assertCsrf(user, form.get("csrf") ?? "");
    if (form.get("intent") === "complete-shopify-data-request") {
      await completeShopifyDataRequest(form.get("eventId"), {
        id: user.id,
        requestId: requestId(request),
      });
      return redirect("/attivita?privacy=chiusa");
    }
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
    open,
    history,
    shopifyDataRequests,
    failedJobs,
    privacyCompleted,
    jobRetried,
  } = useLoaderData<typeof loader>();
  const actionError = useActionData() as { message: string } | undefined;
  return (
    <AppShell username={username} canApprove={canApprove} csrfToken={csrfToken}>
      <div className="title-block">
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

      {privacyCompleted ? (
        <p className="notice" role="status">
          {copy.activity.dataRequestCompleted}
        </p>
      ) : null}
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
        open.rows.length || shopifyDataRequests.length || failedJobs.length ? (
          <section className="card section-gap">
            {shopifyDataRequests.length ? (
              <div className="activity-group">
                <h2>{copy.activity.dataRequestsTitle}</h2>
                <ul className="plain-list">
                  {shopifyDataRequests.map((dataRequest) => (
                    <li key={dataRequest.externalEventId}>
                      <span>
                        <strong>{copy.activity.shopifyDataRequest}</strong>
                        <small>
                          {copy.activity.dataRequestDetail(
                            dataRequest.customerIds.length,
                            dataRequest.orderIds.length,
                          )}{" "}
                          · {dateTime(dataRequest.receivedAt)}
                        </small>
                      </span>
                      <Form method="post">
                        <input type="hidden" name="csrf" value={csrfToken} />
                        <input type="hidden" name="intent" value="complete-shopify-data-request" />
                        <input type="hidden" name="eventId" value={dataRequest.externalEventId} />
                        <button className="button button--secondary" type="submit">
                          {copy.activity.dataRequestComplete}
                        </button>
                      </Form>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {failedJobs.length ? (
              <div className="activity-group">
                <h2>{copy.activity.failedJobsTitle}</h2>
                <ul className="plain-list">
                  {failedJobs.map((job) => (
                    <li key={job.id}>
                      <span>
                        <strong>{copy.activity.failedJobTitle(job.type)}</strong>
                        <small>{copy.activity.failedJob(job.errorCode, job.attempts)}</small>
                      </span>
                      <Form method="post">
                        <input type="hidden" name="csrf" value={csrfToken} />
                        <input type="hidden" name="intent" value="retry-connector-job" />
                        <input type="hidden" name="jobId" value={job.id} />
                        <button className="button button--secondary" type="submit">
                          {copy.activity.retryJob}
                        </button>
                      </Form>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {open.rows.length ? (
              <div className="activity-group">
                <h2>{copy.activity.reviewTitle}</h2>
                <ul className="plain-list">
                  {open.rows.map((activity) => (
                    <li key={`${activity.kind}:${activity.id}`}>
                      <Link to={activity.href}>{activity.label}</Link>
                      <span>
                        {activity.detail} · {dateTime(activity.created_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        ) : (
          <section className="empty-state">
            <h2>{copy.activity.nothingToManage}</h2>
            <p>{copy.activity.nothingToManageHelp}</p>
            <div className="empty-state__actions">
              <Link className="button button--secondary" to="/attivita?vista=cronologia">
                {copy.activity.openHistory}
              </Link>
              <Link className="button button--secondary" to="/impostazioni#connessioni">
                {copy.activity.openConnections}
              </Link>
            </div>
          </section>
        )
      ) : (
        <section className="section-gap">
          <Form
            method="get"
            className="filters"
            role="search"
            aria-label={copy.activity.searchLabel}
          >
            <input type="hidden" name="vista" value="cronologia" />
            <label>
              {copy.activity.search}
              <input name="q" defaultValue={query} placeholder={copy.activity.searchPlaceholder} />
            </label>
            <label>
              {copy.activity.type}
              <select name="azione" defaultValue={action}>
                <option value="">{copy.activity.all}</option>
                {Object.entries(auditActionLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button className="button button--secondary" type="submit">
              {copy.activity.filter}
            </button>
          </Form>
          {history.rows.length ? (
            <div className="table-wrap table-wrap--history">
              <table>
                <thead>
                  <tr>
                    <th>{copy.activity.activity}</th>
                    <th>{copy.activity.subject}</th>
                    <th>{copy.activity.author}</th>
                    <th>{copy.activity.when}</th>
                  </tr>
                </thead>
                <tbody>
                  {history.rows.map((event) => (
                    <tr key={event.id}>
                      <td data-label={copy.activity.activity}>
                        {auditActionLabel(event.action) ?? copy.activity.recorded}
                      </td>
                      <td data-label={copy.activity.subject}>
                        {event.entity_type === "BILLING_CASE" &&
                        event.entity_id &&
                        event.case_number ? (
                          <Link to={`/ordini/preparazione/${event.entity_id}`}>
                            {copy.activity.preparation(event.case_number)}
                          </Link>
                        ) : event.entity_type === "ORDER" &&
                          event.entity_id &&
                          event.order_number ? (
                          <Link to={`/ordini/${event.entity_id}`}>
                            {copy.activity.order(
                              event.order_provider === "SHOPIFY" ? "Shopify" : "eBay",
                              event.order_number,
                            )}
                          </Link>
                        ) : event.entity_type === "SETTING" ? (
                          copy.activity.settings
                        ) : event.entity_type === "REFUND" && event.refund_order_id ? (
                          <Link to={`/ordini/${event.refund_order_id}`}>
                            {copy.activity.order(
                              event.order_provider === "SHOPIFY" ? "Shopify" : "eBay",
                              event.order_number ?? event.refund_order_id,
                            )}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td data-label={copy.activity.author}>
                        {event.actor_type === "SYSTEM"
                          ? copy.activity.system
                          : (event.actor_username ?? "—")}
                      </td>
                      <td data-label={copy.activity.when}>{dateTime(event.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">
              <h2>{copy.activity.noHistory}</h2>
              <p>{copy.activity.noHistoryHelp}</p>
            </div>
          )}
        </section>
      )}

      <Pager
        basePath="/attivita"
        hasNext={view === "gestire" ? open.hasNext : history.hasNext}
        page={page}
      />
    </AppShell>
  );
}
