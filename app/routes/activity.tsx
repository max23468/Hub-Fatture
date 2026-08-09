import { Form, Link, useLoaderData } from "react-router";
import type { Route } from "./+types/activity";

import { AppShell } from "../components/app-shell";
import { Pager } from "../components/pager";
import { auditActionLabels, copy } from "../copy.it";
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
        <p className="eyebrow">Superficie operativa</p>
        <h1>{copy.activityTitle}</h1>
        <p>Cosa richiede un intervento adesso e cosa è già stato registrato.</p>
      </div>

      <nav className="view-nav" aria-label="Viste attività">
        {[
          ["gestire", "Da gestire"],
          ["cronologia", "Cronologia"],
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
          <section className="section-gap">
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
            <h2>Niente da gestire</h2>
            <p>Nessuna preparazione o ordine richiede una verifica.</p>
          </section>
        )
      ) : (
        <section className="section-gap">
          <Form method="get" className="filters" role="search" aria-label="Cerca nel registro">
            <input type="hidden" name="vista" value="cronologia" />
            <label>
              Cerca
              <input name="q" defaultValue={query} placeholder="Identificativo o richiesta" />
            </label>
            <label>
              Tipo di attività
              <select name="azione" defaultValue={action}>
                <option value="">Tutte</option>
                {Object.entries(auditActionLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button className="button button--secondary" type="submit">
              Filtra
            </button>
          </Form>
          {history.rows.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Attività</th>
                    <th>Oggetto</th>
                    <th>Autore</th>
                    <th>Quando</th>
                  </tr>
                </thead>
                <tbody>
                  {history.rows.map((event) => (
                    <tr key={event.id}>
                      <td data-label="Attività">
                        {auditActionLabels[event.action] ?? "Attività registrata"}
                      </td>
                      <td data-label="Oggetto">
                        {event.entity_type === "BILLING_CASE" && event.entity_id ? (
                          <Link to={`/ordini/preparazione/${event.entity_id}`}>
                            Preparazione {event.entity_id}
                          </Link>
                        ) : event.entity_type === "ORDER" && event.entity_id ? (
                          <Link to={`/ordini/${event.entity_id}`}>Ordine {event.entity_id}</Link>
                        ) : (
                          (event.entity_id ?? "—")
                        )}
                      </td>
                      <td data-label="Autore">
                        {event.actor_type === "SYSTEM" ? "Sistema" : (event.actor_username ?? "—")}
                      </td>
                      <td data-label="Quando">{dateTime(event.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">
              <h2>Nessuna attività registrata</h2>
              <p>Modifica i filtri oppure attendi la prossima operazione.</p>
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
