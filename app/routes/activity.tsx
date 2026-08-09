import { Form, Link, useLoaderData } from "react-router";
import type { Route } from "./+types/activity";

import { AppShell } from "../components/app-shell";
import { Pager } from "../components/pager";
import { auditActionLabel, auditActionLabels, copy } from "../copy.it";
import { dateTime } from "../format";
import { requireSessionUser } from "../../src/db/auth.server.ts";
import { listAuditHistory, listOpenActivities } from "../../src/db/orders.server.ts";
import { pageNumber } from "../../src/orders.ts";

const emptyPage = { rows: [], hasNext: false };

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const url = new URL(request.url);
  const view = url.searchParams.get("vista") === "cronologia" ? "cronologia" : "gestire";
  const page = pageNumber(url.searchParams.get("pagina") ?? 1);
  const query = url.searchParams.get("q") ?? "";
  const action = url.searchParams.get("azione") ?? "";
  const [open, history] = await Promise.all([
    view === "gestire" ? listOpenActivities(page) : Promise.resolve(emptyPage),
    view === "cronologia"
      ? listAuditHistory({ query: query || undefined, action: action || undefined, page })
      : Promise.resolve(emptyPage),
  ]);
  return {
    username: user.username,
    csrfToken: user.csrfToken,
    view,
    page,
    query,
    action,
    open,
    history,
  };
}

export default function Activity() {
  const { username, csrfToken, view, page, query, action, open, history } =
    useLoaderData<typeof loader>();
  return (
    <AppShell username={username} csrfToken={csrfToken}>
      <div className="title-block">
        <p className="eyebrow">{copy.activity.eyebrow}</p>
        <h1>{copy.activity.title}</h1>
        <p>{copy.activity.intro}</p>
      </div>

      <nav className="view-nav" aria-label={copy.activity.viewsLabel}>
        {[
          ["gestire", copy.activity.toManage],
          ["cronologia", copy.activity.history],
        ].map(([value, label]) => (
          <Link
            aria-current={view === value ? "page" : undefined}
            className="view-nav__item"
            key={value}
            to={value === "gestire" ? "/attivita" : `/attivita?vista=${value}`}
          >
            {label}
          </Link>
        ))}
      </nav>

      {view === "gestire" ? (
        open.rows.length ? (
          <section className="card section-gap">
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
          </section>
        ) : (
          <section className="empty-state">
            <h2>{copy.activity.nothingToManage}</h2>
            <p>{copy.activity.nothingToManageHelp}</p>
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
            <div className="table-wrap">
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
