import { data, Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/orders";

import fixture from "../../tests/fixtures/orders/normalized.mock.json" with { type: "json" };
import { AppShell } from "../components/app-shell";
import { billingCaseStatusLabels, orderStatusLabels } from "../copy.it";
import { euros, date } from "../format";
import { assertCsrf, requestId, requireSessionUser } from "../../src/auth.server.ts";
import { getConfig } from "../../src/config.server.ts";
import { publicError } from "../../src/errors.ts";
import {
  getDraftTrigger,
  importOrders,
  listBillingCases,
  listOrders,
  setDraftTrigger,
} from "../../src/orders.server.ts";
import { readForm } from "../../src/http.server.ts";

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
  const parsedDate = new Date(`${requestedDate}T00:00:00Z`);
  const statusByView: Record<string, string | undefined> = {
    tutti: Object.hasOwn(orderStatusLabels, requestedStatus) ? requestedStatus : undefined,
    attesa: "WAITING_FOR_TRIGGER",
    annullati: "NO_DOCUMENT",
  };
  const filters = {
    query: url.searchParams.get("q") ?? "",
    provider: ["SHOPIFY", "EBAY"].includes(requestedProvider) ? requestedProvider : "",
    status: statusByView[view] ?? "",
    localDate:
      /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) &&
      !Number.isNaN(parsedDate.valueOf()) &&
      parsedDate.toISOString().startsWith(requestedDate)
        ? requestedDate
        : "",
    paymentStatus: ["PAID", "PENDING", "REFUNDED"].includes(requestedPayment)
      ? requestedPayment
      : "",
  };
  const [orders, cases, trigger] = await Promise.all([
    listOrders({
      query: filters.query || undefined,
      provider: filters.provider || undefined,
      status: filters.status || (view === "tutti" && !filters.query ? "ACTIVE" : undefined),
      localDate: filters.localDate || undefined,
      paymentStatus: filters.paymentStatus || undefined,
    }),
    listBillingCases(),
    getDraftTrigger(),
  ]);
  return {
    username: user.username,
    csrfToken: user.csrfToken,
    orders,
    cases,
    trigger,
    view,
    fixtureEnabled: getConfig().APP_ENV !== "production",
    imported: url.searchParams.get("importati"),
    ignored: url.searchParams.get("ignorati"),
    triggerSaved: url.searchParams.get("trigger") === "salvato",
    filters,
  };
}

export async function action({ request }: Route.ActionArgs) {
  try {
    const user = await requireSessionUser(request);
    const form = await readForm(request);
    assertCsrf(user, form.get("csrf") ?? "");
    const actor = { id: user.id, requestId: requestId(request) };
    if (form.get("intent") === "import-fixture" && getConfig().APP_ENV !== "production") {
      const result = await importOrders(fixture, actor);
      return redirect(
        `/ordini?importati=${result.imported}&aggiornati=${result.updated}&ignorati=${result.ignored}`,
      );
    }
    if (form.get("intent") === "change-trigger") {
      await setDraftTrigger(form.get("trigger"), Number(form.get("version") ?? Number.NaN), actor);
      return redirect("/ordini?trigger=salvato");
    }
    return data(
      { code: "UNKNOWN", message: "Azione non riconosciuta.", status: 400 },
      { status: 400 },
    );
  } catch (error) {
    const result = publicError(error);
    return data(result, { status: result.status });
  }
}

export default function Orders() {
  const {
    username,
    csrfToken,
    orders,
    cases,
    trigger,
    view,
    fixtureEnabled,
    imported,
    ignored,
    triggerSaved,
    filters,
  } = useLoaderData<typeof loader>();
  const error = useActionData<typeof action>();
  const preparationCases = cases.filter((billingCase) =>
    view === "verificare"
      ? billingCase.status === "NEEDS_REVIEW"
      : view === "annullati"
        ? billingCase.status === "DO_NOT_TRANSMIT"
        : billingCase.status === "READY",
  );
  const showsPreparations = view === "fatturare" || view === "verificare";
  const showsPreparationArchive =
    showsPreparations || (view === "annullati" && preparationCases.length > 0);
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
          Fixture elaborata: {imported} nuovi ordini
          {Number(ignored) ? `; ${ignored} aggiornamenti meno recenti ignorati` : ""}.
        </p>
      ) : null}
      {triggerSaved ? (
        <p className="notice" role="status">
          Trigger aggiornato. Gli ordini in attesa sono stati rivalutati.
        </p>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error.message}
        </p>
      ) : null}

      <section className="toolbar" aria-label="Configurazione del trigger">
        <Form method="post" className="inline-form">
          <input type="hidden" name="csrf" value={csrfToken} />
          <input type="hidden" name="intent" value="change-trigger" />
          <input type="hidden" name="version" value={trigger.version} />
          <label>
            Prepara la fattura
            <select name="trigger" defaultValue={trigger.value}>
              <option value="PAID">Alla conferma del pagamento</option>
              <option value="FULFILLED">Alla completa evasione</option>
            </select>
          </label>
          <button className="button button--secondary" type="submit">
            Salva trigger
          </button>
        </Form>
        {fixtureEnabled ? (
          <Form method="post">
            <input type="hidden" name="csrf" value={csrfToken} />
            <input type="hidden" name="intent" value="import-fixture" />
            <button className="button" type="submit">
              Importa dati sintetici
            </button>
          </Form>
        ) : null}
      </section>

      {!showsPreparations && view !== "annullati" ? orderFilters : null}

      {showsPreparationArchive && preparationCases.length ? (
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
                {preparationCases.map((billingCase) => (
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
          {orders.length ? (
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
                  {orders.map((order) => (
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
    </AppShell>
  );
}
