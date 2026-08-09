import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/orders";

import fixture from "../../tests/fixtures/orders/normalized.mock.json" with { type: "json" };
import { actionResult } from "../action";
import { AppShell } from "../components/app-shell";
import { Pager } from "../components/pager";
import { billingCaseStatusLabels, orderStatusLabels } from "../copy.it";
import { euros, date } from "../format";
import { assertCsrf, requestId, requireSessionUser } from "../../src/db/auth.server.ts";
import { getConfig } from "../../src/config.server.ts";
import { importOrders, listBillingCases, listOrders } from "../../src/db/orders.server.ts";
import { readForm } from "../../src/http.server.ts";
import { pageNumber, postgresDateSchema } from "../../src/orders.ts";

const caseStatusByView: Record<string, string[]> = {
  fatturare: ["READY"],
  verificare: ["NEEDS_REVIEW"],
  annullati: ["DO_NOT_TRANSMIT"],
};

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const url = new URL(request.url);
  const requestedView = url.searchParams.get("vista") ?? "tutti";
  const view = ["tutti", "fatturare", "verificare", "attesa", "annullati"].includes(requestedView)
    ? requestedView
    : "tutti";
  const requestedStatus = url.searchParams.get("stato") ?? "";
  const requestedProvider = url.searchParams.get("provider") ?? "";
  const requestedPayment = url.searchParams.get("pagamento") ?? "";
  const requestedDate = url.searchParams.get("data") ?? "";
  const parsedDate = postgresDateSchema.safeParse(requestedDate);
  const statusByView: Record<string, string | undefined> = {
    tutti: Object.hasOwn(orderStatusLabels, requestedStatus) ? requestedStatus : undefined,
    attesa: "WAITING_FOR_TRIGGER",
    annullati: "NO_DOCUMENT",
  };
  const filters = {
    query: url.searchParams.get("q") ?? "",
    provider: ["SHOPIFY", "EBAY"].includes(requestedProvider) ? requestedProvider : "",
    status: statusByView[view] ?? "",
    localDate: parsedDate.success ? parsedDate.data : "",
    paymentStatus: ["PAID", "PENDING", "REFUNDED"].includes(requestedPayment)
      ? requestedPayment
      : "",
  };
  const page = pageNumber(url.searchParams.get("pagina") ?? 1);
  const showsPreparations = view === "fatturare" || view === "verificare";
  const emptyPage = { rows: [], hasNext: false };
  const [orders, cases] = await Promise.all([
    showsPreparations
      ? Promise.resolve(emptyPage)
      : listOrders({
          query: filters.query || undefined,
          provider: filters.provider || undefined,
          status: filters.status || (view === "tutti" && !filters.query ? "ACTIVE" : undefined),
          localDate: filters.localDate || undefined,
          paymentStatus: filters.paymentStatus || undefined,
          page,
        }),
    caseStatusByView[view]
      ? listBillingCases({ statuses: caseStatusByView[view], page })
      : Promise.resolve(emptyPage),
  ]);
  return {
    username: user.username,
    csrfToken: user.csrfToken,
    orders,
    cases,
    view,
    page,
    fixtureEnabled: getConfig().APP_ENV !== "production",
    imported: url.searchParams.get("importati"),
    updated: url.searchParams.get("aggiornati"),
    ignored: url.searchParams.get("ignorati"),
    filters,
  };
}

export async function action({ request }: Route.ActionArgs) {
  return actionResult(async () => {
    const user = await requireSessionUser(request);
    const form = await readForm(request);
    assertCsrf(user, form.get("csrf") ?? "");
    if (form.get("intent") !== "import-fixture" || getConfig().APP_ENV === "production") {
      throw new Response("Azione non riconosciuta", { status: 400 });
    }
    const result = await importOrders(fixture, { id: user.id, requestId: requestId(request) });
    return redirect(
      `/ordini?importati=${result.imported}&aggiornati=${result.updated}&ignorati=${result.ignored}`,
    );
  });
}

export default function Orders() {
  const {
    username,
    csrfToken,
    orders,
    cases,
    view,
    page,
    fixtureEnabled,
    imported,
    updated,
    ignored,
    filters,
  } = useLoaderData<typeof loader>();
  const error = useActionData<typeof action>();
  const showsPreparations = view === "fatturare" || view === "verificare";
  const showsPreparationArchive = showsPreparations || view === "annullati";
  const orderFilters = (
    <Form method="get" className="filters" role="search" aria-label="Filtra gli ordini">
      {view !== "tutti" ? <input type="hidden" name="vista" value={view} /> : null}
      <label>
        Cerca
        <input name="q" defaultValue={filters.query} placeholder="Numero ordine o cliente" />
      </label>
      <label>
        Piattaforma
        <select name="provider" defaultValue={filters.provider}>
          <option value="">Tutte</option>
          <option value="SHOPIFY">Shopify</option>
          <option value="EBAY">eBay</option>
        </select>
      </label>
      <label>
        Data ordine
        <input name="data" type="date" defaultValue={filters.localDate} />
      </label>
      <label>
        Pagamento
        <select name="pagamento" defaultValue={filters.paymentStatus}>
          <option value="">Tutti</option>
          <option value="PAID">Pagato</option>
          <option value="PENDING">In attesa</option>
          <option value="REFUNDED">Rimborsato</option>
        </select>
      </label>
      {view === "tutti" ? (
        <label>
          Stato di preparazione
          <select name="stato" defaultValue={filters.status}>
            <option value="">Tutti</option>
            {Object.entries(orderStatusLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <button className="button button--secondary" type="submit">
        Filtra
      </button>
    </Form>
  );
  return (
    <AppShell username={username} csrfToken={csrfToken}>
      <div className="title-block">
        <p className="eyebrow">Dati sorgente</p>
        <h1>Ordini</h1>
        <p>Dall’ordine sorgente alla preparazione della fattura, in un unico spazio di lavoro.</p>
      </div>

      <nav className="view-nav" aria-label="Viste ordini">
        {[
          ["tutti", "Tutti"],
          ["fatturare", "Da fatturare"],
          ["verificare", "Da verificare"],
          ["attesa", "In attesa"],
          ["annullati", "Annullati"],
        ].map(([value, label]) => (
          <Link
            aria-current={view === value ? "page" : undefined}
            className="view-nav__item"
            key={value}
            to={value === "tutti" ? "/ordini" : `/ordini?vista=${value}`}
          >
            {label}
          </Link>
        ))}
      </nav>

      {imported !== null ? (
        <p className="notice" role="status">
          Fixture elaborata: {imported} nuovi ordini, {updated ?? 0} aggiornati
          {Number(ignored) ? `, ${ignored} aggiornamenti meno recenti ignorati` : ""}.
        </p>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error.message}
        </p>
      ) : null}

      {fixtureEnabled ? (
        <section className="toolbar" aria-label="Dati sintetici">
          <Form method="post">
            <input type="hidden" name="csrf" value={csrfToken} />
            <input type="hidden" name="intent" value="import-fixture" />
            <button className="button" type="submit">
              Importa dati sintetici
            </button>
          </Form>
        </section>
      ) : null}

      {!showsPreparations && view !== "annullati" ? orderFilters : null}

      {showsPreparationArchive && cases.rows.length ? (
        <section className="section-gap">
          {view === "annullati" ? <h2>Preparazioni non trasmesse</h2> : null}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Preparazione</th>
                  <th>Cliente</th>
                  <th>Data</th>
                  <th>Ordini</th>
                  <th>Totale</th>
                  <th>Stato</th>
                </tr>
              </thead>
              <tbody>
                {cases.rows.map((billingCase) => (
                  <tr key={billingCase.id}>
                    <td data-label="Preparazione">
                      <Link to={`/ordini/preparazione/${billingCase.id}`}>
                        {billingCase.public_number}
                      </Link>
                    </td>
                    <td data-label="Cliente">{billingCase.customer_name}</td>
                    <td data-label="Data">{date(billingCase.local_order_date)}</td>
                    <td data-label="Ordini">{billingCase.order_count}</td>
                    <td data-label="Totale">{euros(billingCase.total_amount)}</td>
                    <td data-label="Stato">
                      <span className="status">
                        {billingCaseStatusLabels[billingCase.status] ?? "Stato non riconosciuto"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : showsPreparations ? (
        <section className="empty-state">
          <h2>{view === "verificare" ? "Nessuna verifica richiesta" : "Niente da fatturare"}</h2>
          <p>Le preparazioni compaiono qui quando gli ordini soddisfano il trigger globale.</p>
        </section>
      ) : null}

      {!showsPreparations ? (
        <section className="section-gap">
          {view === "annullati" ? <h2>Ordini annullati o rimborsati</h2> : null}
          {view === "annullati" ? orderFilters : null}
          {orders.rows.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Ordine</th>
                    <th>Cliente</th>
                    <th>Data</th>
                    <th>Totale</th>
                    <th>Stato</th>
                    <th>Preparazione</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.rows.map((order) => (
                    <tr key={order.id}>
                      <td data-label="Ordine">
                        <Link to={`/ordini/${order.id}`}>
                          {order.provider === "SHOPIFY" ? "Shopify" : "eBay"} {order.display_number}
                        </Link>
                      </td>
                      <td data-label="Cliente">{order.customer_name}</td>
                      <td data-label="Data">{date(order.local_order_date)}</td>
                      <td data-label="Totale">{euros(order.gross_amount)}</td>
                      <td data-label="Stato">
                        <span className="status">
                          {orderStatusLabels[order.trigger_status] ?? "Stato non riconosciuto"}
                        </span>
                      </td>
                      <td data-label="Preparazione">
                        {order.billing_case_id ? (
                          <Link to={`/ordini/preparazione/${order.billing_case_id}`}>
                            {order.case_number}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">
              <h2>{view === "annullati" ? "Nessun ordine annullato" : "Nessun ordine"}</h2>
              <p>Importa la fixture sintetica oppure modifica i filtri.</p>
            </div>
          )}
        </section>
      ) : null}
      <Pager
        basePath="/ordini"
        hasNext={showsPreparations ? cases.hasNext : orders.hasNext || cases.hasNext}
        page={page}
      />
    </AppShell>
  );
}
