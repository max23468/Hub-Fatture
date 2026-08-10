import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/orders";

import fixture from "../../tests/fixtures/orders/normalized.mock.json" with { type: "json" };
import { actionResult } from "../action";
import { AppShell } from "../components/app-shell";
import { Pager } from "../components/pager";
import { billingCaseStatusLabels, copy, orderStatusLabels } from "../copy.it";
import { euros, date } from "../format";
import { assertCsrf, requestId, requireSessionUser } from "../../src/db/auth.server.ts";
import { getConfig } from "../../src/config.server.ts";
import { importOrders, listBillingCases, listOrders } from "../../src/db/orders.server.ts";
import { readForm } from "../../src/http.server.ts";
import { pageNumber, postgresDateSchema } from "../../src/orders.ts";
import { approveInvoices, listMassApprovalCandidates } from "../../src/db/documents.server.ts";

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
  const approvalCandidates =
    view === "fatturare" && user.canApprove ? await listMassApprovalCandidates() : [];
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
    approvalCandidates,
    approved: url.searchParams.get("approvati"),
    approvalErrors: url.searchParams.get("errori"),
  };
}

export async function action({ request }: Route.ActionArgs) {
  return actionResult(async () => {
    const user = await requireSessionUser(request);
    const form = await readForm(request);
    assertCsrf(user, form.get("csrf") ?? "");
    if (form.get("intent") === "approve-documents") {
      if (form.get("confirm") !== "yes") {
        throw new Response("Conferma mancante", { status: 400 });
      }
      const result = await approveInvoices(form.getAll("caseId"), {
        id: user.id,
        canApprove: user.canApprove,
        requestId: requestId(request),
      });
      return redirect(
        `/ordini?vista=fatturare&approvati=${result.approved}&errori=${result.failed}`,
      );
    }
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
    approvalCandidates,
    approved,
    approvalErrors,
  } = useLoaderData<typeof loader>();
  const error = useActionData<typeof action>();
  const showsPreparations = view === "fatturare" || view === "verificare";
  const showsPreparationArchive = showsPreparations || view === "annullati";
  const orderFilters = (
    <Form method="get" className="filters" role="search" aria-label={copy.orders.filterLabel}>
      {view !== "tutti" ? <input type="hidden" name="vista" value={view} /> : null}
      <label>
        {copy.orders.search}
        <input name="q" defaultValue={filters.query} placeholder={copy.orders.searchPlaceholder} />
      </label>
      <label>
        {copy.orders.salesChannel}
        <select name="provider" defaultValue={filters.provider}>
          <option value="">{copy.orders.allFeminine}</option>
          <option value="SHOPIFY">Shopify</option>
          <option value="EBAY">eBay</option>
        </select>
      </label>
      <label>
        {copy.orders.orderDate}
        <input name="data" type="date" defaultValue={filters.localDate} />
      </label>
      <label>
        {copy.orders.payment}
        <select name="pagamento" defaultValue={filters.paymentStatus}>
          <option value="">{copy.orders.allMasculine}</option>
          <option value="PAID">Pagato</option>
          <option value="PENDING">In attesa</option>
          <option value="REFUNDED">Rimborsato</option>
        </select>
      </label>
      {view === "tutti" ? (
        <label>
          {copy.orders.invoicingStatus}
          <select name="stato" defaultValue={filters.status}>
            <option value="">{copy.orders.allMasculine}</option>
            {Object.entries(orderStatusLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <button className="button button--secondary" type="submit">
        {copy.orders.filter}
      </button>
    </Form>
  );
  return (
    <AppShell username={username} csrfToken={csrfToken}>
      <div className="title-block">
        <p className="eyebrow">{copy.orders.eyebrow}</p>
        <h1>{copy.orders.title}</h1>
        <p>{copy.orders.intro}</p>
      </div>

      <nav className="view-nav" aria-label={copy.orders.viewsLabel}>
        {[
          ["tutti", copy.orders.views.all],
          ["fatturare", copy.orders.views.toInvoice],
          ["verificare", copy.orders.views.toReview],
          ["attesa", copy.orders.views.waiting],
          ["annullati", copy.orders.views.cancelled],
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
          {copy.orders.examplesLoaded(imported, updated, ignored)}
        </p>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error.message}
        </p>
      ) : null}
      {approved !== null ? (
        <p className="notice" role="status">
          {copy.orders.massApprovalResult(approved, approvalErrors ?? "0")}
        </p>
      ) : null}

      {showsPreparations && approvalCandidates.length > 1 ? (
        <section className="card section-gap">
          <h2>{copy.orders.massApprovalTitle}</h2>
          <p>
            {copy.orders.massApprovalSummary(
              approvalCandidates.length,
              approvalCandidates.reduce((sum, item) => sum + item.total_amount, 0),
            )}
          </p>
          <Form method="post">
            <input type="hidden" name="csrf" value={csrfToken} />
            <input type="hidden" name="intent" value="approve-documents" />
            {approvalCandidates.map((candidate) => (
              <input
                key={candidate.billing_case_id}
                type="hidden"
                name="caseId"
                value={candidate.billing_case_id}
              />
            ))}
            <label className="checkbox-row">
              <input name="confirm" required type="checkbox" value="yes" />
              {copy.orders.massApprovalConfirm}
            </label>
            <button className="button" type="submit">
              {copy.orders.massApprovalAction}
            </button>
          </Form>
        </section>
      ) : null}

      {!showsPreparations && view !== "annullati" ? orderFilters : null}

      {showsPreparationArchive && cases.rows.length ? (
        <section className="section-gap">
          {view === "annullati" ? <h2>{copy.orders.noTransmittedPreparations}</h2> : null}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{copy.orders.preparation}</th>
                  <th>{copy.orders.customer}</th>
                  <th>{copy.orders.date}</th>
                  <th>{copy.orders.orders}</th>
                  <th>{copy.orders.total}</th>
                  <th>{copy.orders.status}</th>
                </tr>
              </thead>
              <tbody>
                {cases.rows.map((billingCase) => (
                  <tr key={billingCase.id}>
                    <td data-label={copy.orders.preparation}>
                      <Link
                        aria-label={copy.orders.openPreparation(billingCase.public_number)}
                        to={`/ordini/preparazione/${billingCase.id}`}
                      >
                        {billingCase.public_number}
                      </Link>
                    </td>
                    <td data-label={copy.orders.customer}>{billingCase.customer_name}</td>
                    <td data-label={copy.orders.date}>{date(billingCase.local_order_date)}</td>
                    <td data-label={copy.orders.orders}>{billingCase.order_count}</td>
                    <td data-label={copy.orders.total}>{euros(billingCase.total_amount)}</td>
                    <td data-label={copy.orders.status}>
                      <span className="status">
                        {billingCaseStatusLabels[billingCase.status] ?? copy.common.unknownStatus}
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
          <h2>{view === "verificare" ? copy.orders.noReviews : copy.orders.nothingToInvoice}</h2>
          <p>{copy.orders.preparationEmptyHelp}</p>
        </section>
      ) : null}

      {!showsPreparations ? (
        <section className="section-gap">
          {view === "annullati" ? <h2>{copy.orders.cancelledOrders}</h2> : null}
          {view === "annullati" ? orderFilters : null}
          {orders.rows.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{copy.orders.order}</th>
                    <th>{copy.orders.customer}</th>
                    <th>{copy.orders.date}</th>
                    <th>{copy.orders.total}</th>
                    <th>{copy.orders.status}</th>
                    <th>{copy.orders.preparation}</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.rows.map((order) => (
                    <tr key={order.id}>
                      <td data-label={copy.orders.order}>
                        <Link to={`/ordini/${order.id}`}>
                          {order.provider === "SHOPIFY" ? "Shopify" : "eBay"} {order.display_number}
                        </Link>
                      </td>
                      <td data-label={copy.orders.customer}>{order.customer_name}</td>
                      <td data-label={copy.orders.date}>{date(order.local_order_date)}</td>
                      <td data-label={copy.orders.total}>{euros(order.gross_amount)}</td>
                      <td data-label={copy.orders.status}>
                        <span className="status">
                          {orderStatusLabels[order.trigger_status] ?? copy.common.unknownStatus}
                        </span>
                      </td>
                      <td data-label={copy.orders.preparation}>
                        {order.billing_case_id ? (
                          <Link
                            aria-label={copy.orders.openPreparation(String(order.case_number))}
                            to={`/ordini/preparazione/${order.billing_case_id}`}
                          >
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
              <h2>{view === "annullati" ? copy.orders.noCancelledOrders : copy.orders.noOrders}</h2>
              <p>
                {fixtureEnabled
                  ? copy.orders.noOrdersHelpDevelopment
                  : copy.orders.noOrdersHelpProduction}
              </p>
              {fixtureEnabled ? (
                <Form method="post">
                  <input type="hidden" name="csrf" value={csrfToken} />
                  <input type="hidden" name="intent" value="import-fixture" />
                  <button className="button" type="submit">
                    {copy.orders.loadExamples}
                  </button>
                </Form>
              ) : null}
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
