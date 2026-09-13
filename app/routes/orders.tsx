import { useEffect, useState } from "react";
import { ArrowRight, FileText, ShoppingBag } from "lucide-react";
import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/orders";

import fixture from "../../tests/fixtures/orders/normalized.mock.json" with { type: "json" };
import { actionResult } from "../action";
import { InventoryApprovalForm } from "../components/inventory-approval-form";
import { AppShell } from "../components/app-shell";
import { CustomerEmailApprovalFields } from "../components/customer-email-approval";
import { Pager } from "../components/pager";
import { SortableHeaderLink } from "../components/sortable-table";
import { ViewNavigation } from "../components/view-navigation";
import {
  billingCaseStatusLabels,
  anomalyLabels,
  copy,
  orderListStatusLabels,
  orderStatusLabels,
} from "../copy.it";
import { compactDate, compactDateTime, euros } from "../format";
import { privateRouteMeta } from "../metadata";
import { assertCsrf, requestId, requireSessionUser } from "../../src/db/auth.server.ts";
import { getConfig } from "../../src/config.server.ts";
import { arubaInventoryApprovalState } from "../../src/aruba-inventory.ts";
import { getArubaInventoryHealth } from "../../src/db/aruba-inventory-health.server.ts";
import {
  listBillingCases,
  type OpenBillingCasePool,
  type BillingCaseListSortKey,
} from "../../src/db/billing-cases.server.ts";
import { importOrders } from "../../src/db/order-import.server.ts";
import { listOrders, type OrderListSortKey } from "../../src/db/order-queries.server.ts";
import { readForm } from "../../src/http.server.ts";
import { pageNumber, postgresDateSchema } from "../../src/orders.ts";
import { approveInvoices } from "../../src/db/document-mass-approval.server.ts";
import { parseSort, type SortState } from "../table-sort";
import type { MassApprovalData } from "./order-approval-candidates";

const preparationPoolByView: Record<string, OpenBillingCasePool> = {
  fatturare: "APPROVABLE",
  attesa: "PENDING_PAYMENT",
};

const orderSortKeys = ["ordine", "cliente", "data", "totale", "stato", "preparazione"] as const;
const preparationSortKeys = [
  "preparazione",
  "cliente",
  "data",
  "ordini",
  "totale",
  "stato",
] as const;

export function meta({ error }: Route.MetaArgs) {
  return privateRouteMeta("orders", { error });
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const url = new URL(request.url);
  const requestedView = url.searchParams.get("vista") ?? "tutti";
  const view = ["tutti", "fatturare", "attesa", "annullati"].includes(requestedView)
    ? requestedView
    : "tutti";
  const requestedStatus = url.searchParams.get("stato") ?? "";
  const requestedProvider = url.searchParams.get("provider") ?? "";
  const requestedPayment = url.searchParams.get("pagamento") ?? "";
  const requestedDate = url.searchParams.get("data") ?? "";
  const parsedDate = postgresDateSchema.safeParse(requestedDate);
  const statusByView: Record<string, string | undefined> = {
    tutti: Object.hasOwn(orderStatusLabels, requestedStatus) ? requestedStatus : undefined,
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
  const orderSort = parseSort(
    url.searchParams.get("ordiniOrdina"),
    url.searchParams.get("ordiniDirezione"),
    orderSortKeys,
    { key: "data", direction: "desc" },
  );
  const preparationSort = parseSort(
    url.searchParams.get("preparazioniOrdina"),
    url.searchParams.get("preparazioniDirezione"),
    preparationSortKeys,
    { key: "data", direction: "desc" },
  );
  const emptyPage = { rows: [], hasNext: false };
  const ordersPromise =
    view === "fatturare"
      ? Promise.resolve(emptyPage)
      : listOrders({
          query: filters.query || undefined,
          provider: filters.provider || undefined,
          status: filters.status || (view === "tutti" && !filters.query ? "ACTIVE" : undefined),
          localDate: filters.localDate || undefined,
          paymentStatus: filters.paymentStatus || undefined,
          unpreparedPendingPayments: view === "attesa",
          page,
          sort: orderSort,
        });
  const arubaInventoryPromise =
    view === "fatturare" ? getArubaInventoryHealth() : Promise.resolve(null);
  const arubaInventory = await arubaInventoryPromise;
  const inventoryApprovalState = arubaInventory
    ? arubaInventoryApprovalState(arubaInventory)
    : null;
  const [orders, cases] = await Promise.all([
    ordersPromise,
    preparationPoolByView[view]
      ? listBillingCases({
          operationalPool: preparationPoolByView[view],
          page,
          sort: preparationSort,
        })
      : view === "annullati"
        ? listBillingCases({ statuses: ["DO_NOT_TRANSMIT"], page, sort: preparationSort })
        : Promise.resolve(emptyPage),
  ]);
  return {
    username: user.username,
    canApprove: user.canApprove,
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
    orderSort,
    preparationSort,
    inventoryApprovalState,
    approved: url.searchParams.get("approvati"),
    approvalErrors: url.searchParams.get("errori"),
    storagePending: url.searchParams.get("archiviazione"),
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
      const result = await approveInvoices(
        form.getAll("approval"),
        {
          id: user.id,
          canApprove: user.canApprove,
          requestId: requestId(request),
        },
        true,
        form.get("arubaMode"),
        Object.fromEntries(
          form.getAll("approval").map((value) => {
            const caseId = String(value).split(":", 1)[0]!;
            return [caseId, form.get(`emailChoice:${caseId}`)];
          }),
        ),
        form.get("emailModeVersion"),
        form.get("confirmArubaDowngrade") === "yes",
      );
      return redirect(
        `/ordini?vista=fatturare&approvati=${result.approved}&errori=${result.failed}&archiviazione=${result.storagePending}`,
      );
    }
    if (form.get("intent") !== "import-fixture" || getConfig().APP_ENV === "production") {
      throw new Response("Azione non riconosciuta", { status: 400 });
    }
    const result = await importOrders(fixture, {
      id: user.id,
      requestId: requestId(request),
    });
    return redirect(
      `/ordini?importati=${result.imported}&aggiornati=${result.updated}&ignorati=${result.ignored}`,
    );
  });
}

type ApprovalCandidates = MassApprovalData["approvalCandidates"];
type OrderFiltersValue = Awaited<ReturnType<typeof loader>>["filters"];

function OrderFilters({
  count,
  filters,
  view,
}: {
  count: number;
  filters: OrderFiltersValue;
  view: string;
}) {
  const [localDate, setLocalDate] = useState(filters.localDate);

  useEffect(() => setLocalDate(filters.localDate), [filters.localDate]);

  const activeFilters = [
    filters.query,
    filters.provider,
    filters.localDate,
    filters.paymentStatus,
    view === "tutti" ? filters.status : "",
  ].filter(Boolean).length;
  const resetTo = view === "tutti" ? "/ordini" : `/ordini?vista=${view}`;

  return (
    <div className="orders-filter-area">
      <div className="orders-filter-area__heading">
        <strong>{copy.orders.filterTitle}</strong>
        <span>{copy.orders.filterHelp}</span>
      </div>
      <Form
        method="get"
        className={`filters orders-filters orders-filters--${view === "tutti" ? "all" : "compact"}`}
        role="search"
        aria-label={copy.orders.filterLabel}
      >
        {view !== "tutti" ? <input type="hidden" name="vista" value={view} /> : null}
        <label>
          {copy.orders.search}
          <input
            name="q"
            defaultValue={filters.query}
            placeholder={copy.orders.searchPlaceholder}
          />
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
          <input
            autoComplete="off"
            name="data"
            onChange={(event) => setLocalDate(event.currentTarget.value)}
            type="date"
            value={localDate}
          />
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
      <div className="filter-summary" aria-live="polite">
        <span>{copy.orders.resultsOnPage(count)}</span>
        {activeFilters ? <span>{copy.orders.activeFilters(activeFilters)}</span> : null}
        {activeFilters ? <Link to={resetTo}>{copy.orders.resetFilters}</Link> : null}
      </div>
    </div>
  );
}

function orderStatusTone(status: string) {
  if (["WAITING_FOR_TRIGGER", "NEEDS_REVIEW", "LEGACY_BILLING_REVIEW"].includes(status)) {
    return "warning";
  }
  if (status === "INVOICED") return "success";
  if (["CANCELLED_NO_DOCUMENT", "REFUNDED_BEFORE_ISSUE"].includes(status)) return "neutral";
  return "accent";
}

function caseStatusTone(status: string) {
  if (["PENDING_PAYMENT", "REQUIRES_ACTION", "NEEDS_REVIEW", "DO_NOT_TRANSMIT"].includes(status)) {
    return "warning";
  }
  if (["APPROVABLE", "APPROVED", "CLOSED"].includes(status)) return "success";
  return "accent";
}

function MassApprovalPanel({
  approvalCandidates,
  arubaMode,
  arubaConfiguredMode,
  arubaDowngradeRequired,
  csrfToken,
}: {
  approvalCandidates: ApprovalCandidates;
  arubaMode: string;
  arubaConfiguredMode: string;
  arubaDowngradeRequired: boolean;
  csrfToken: string;
}) {
  return (
    <section className="card section-gap">
      <h2>{copy.orders.massApprovalTitle}</h2>
      <p>
        {copy.orders.massApprovalSummary(
          approvalCandidates.length,
          approvalCandidates.reduce((sum, item) => sum + item.total_amount, 0),
        )}
      </p>
      <InventoryApprovalForm>
        <input type="hidden" name="csrf" value={csrfToken} />
        <input type="hidden" name="intent" value="approve-documents" />
        <input type="hidden" name="arubaMode" value={arubaMode} />
        <input
          type="hidden"
          name="emailModeVersion"
          value={approvalCandidates[0]!.customerEmail.version}
        />
        <div className="detail-stack">
          {approvalCandidates.map((candidate) => (
            <fieldset className="status-panel" key={candidate.billing_case_id}>
              <legend>
                <Link to={`/ordini/preparazione/${candidate.billing_case_id}`}>
                  {copy.preparation.title(candidate.public_number)}
                </Link>
              </legend>
              <p>{`${candidate.customer_name} · ${euros(candidate.total_amount)} · profilo fiscale v${candidate.fiscal_profile_version} · pagamento registrato`}</p>
              <CustomerEmailApprovalFields
                choiceName={`emailChoice:${candidate.billing_case_id}`}
                email={candidate.customerEmail}
                required
              />
            </fieldset>
          ))}
        </div>
        <p>
          <strong>Percorso Aruba:</strong>{" "}
          {arubaMode === "AUTOMATIC_AFTER_APPROVAL"
            ? copy.document.automaticApiMode
            : arubaMode === "CONTEXTUAL_CONFIRMATION"
              ? copy.document.contextualTransmissionMode
              : copy.document.documentOnlyMode}
        </p>
        <p className="warning">{copy.orders.massApprovalConsequence}</p>
        {arubaDowngradeRequired ? (
          <label className="checkbox-row">
            <input name="confirmArubaDowngrade" required type="checkbox" value="yes" />
            {copy.document.confirmArubaDowngrade(arubaConfiguredMode)}
          </label>
        ) : null}
        {approvalCandidates.map((candidate) => (
          <input
            key={`approval-${candidate.billing_case_id}`}
            type="hidden"
            name="approval"
            value={`${candidate.billing_case_id}:${candidate.case_revision}:${candidate.draft_version}:${candidate.projection_sha256}`}
          />
        ))}
        <label className="checkbox-row">
          <input name="confirm" required type="checkbox" value="yes" />
          {copy.orders.massApprovalConfirm}
        </label>
        <button className="button" type="submit">
          {copy.orders.massApprovalAction}
        </button>
      </InventoryApprovalForm>
    </section>
  );
}

function MassApprovalSection({ csrfToken }: { csrfToken: string }) {
  const [data, setData] = useState<MassApprovalData>();

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/ordini/candidati-approvazione", {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("MASS_APPROVAL_LOAD_FAILED");
        return (await response.json()) as MassApprovalData;
      })
      .then(setData)
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setData(undefined);
      });
    return () => controller.abort();
  }, []);

  if (!data || data.approvalCandidates.length <= 1) return null;
  return (
    <MassApprovalPanel
      approvalCandidates={data.approvalCandidates}
      arubaMode={data.arubaMode}
      arubaConfiguredMode={data.arubaConfiguredMode}
      arubaDowngradeRequired={data.arubaDowngradeRequired}
      csrfToken={csrfToken}
    />
  );
}

type OrdersPageData = Awaited<ReturnType<typeof loader>>;

function PreparationList({
  cases,
  ordersEmpty,
  showsPreparations,
  sort,
  view,
}: {
  cases: OrdersPageData["cases"];
  ordersEmpty: boolean;
  showsPreparations: boolean;
  sort: SortState<BillingCaseListSortKey>;
  view: string;
}) {
  if (!cases.rows.length) {
    return showsPreparations && ordersEmpty ? (
      <section className="empty-state">
        <h2>
          {view === "attesa" ? copy.orders.noPendingPreparations : copy.orders.nothingToInvoice}
        </h2>
        <p>
          {view === "attesa"
            ? copy.orders.pendingPreparationEmptyHelp
            : copy.orders.preparationEmptyHelp}
        </p>
      </section>
    ) : null;
  }

  return (
    <section
      className="dashboard-panel orders-panel section-gap"
      aria-labelledby="orders-preparations-title"
    >
      <header className="orders-panel__header">
        <span className="dashboard-icon dashboard-icon--accent" aria-hidden="true">
          <FileText size={22} strokeWidth={1.8} />
        </span>
        <span>
          <h2 id="orders-preparations-title">
            {view === "annullati"
              ? copy.orders.noTransmittedPreparations
              : view === "attesa"
                ? copy.orders.pendingPreparationListTitle
                : copy.orders.approvablePreparationListTitle}
          </h2>
          <p>
            {view === "attesa"
              ? copy.orders.pendingPreparationListHelp
              : copy.orders.preparationListHelp}
          </p>
        </span>
        <strong className="orders-panel__count">{copy.orders.pageItems(cases.rows.length)}</strong>
      </header>
      <div className="table-wrap orders-table-wrap">
        <table className="orders-table orders-table--preparations data-table">
          <colgroup>
            <col className="orders-table__preparation-column" />
            <col className="orders-table__customer-column" />
            <col className="orders-table__date-column" />
            <col className="orders-table__orders-column" />
            <col className="orders-table__total-column" />
            <col className="orders-table__status-column" />
            <col className="orders-table__action-column" />
          </colgroup>
          <thead>
            <tr>
              <SortableHeaderLink
                directionParam="preparazioniDirezione"
                keyParam="preparazioniOrdina"
                label={copy.orders.preparation}
                sort={sort}
                sortKey="preparazione"
              />
              <SortableHeaderLink
                directionParam="preparazioniDirezione"
                keyParam="preparazioniOrdina"
                label={copy.orders.customer}
                sort={sort}
                sortKey="cliente"
              />
              <SortableHeaderLink
                directionParam="preparazioniDirezione"
                keyParam="preparazioniOrdina"
                label={copy.orders.date}
                sort={sort}
                sortKey="data"
              />
              <SortableHeaderLink
                className="table-heading--numeric"
                directionParam="preparazioniDirezione"
                keyParam="preparazioniOrdina"
                label={copy.orders.orders}
                sort={sort}
                sortKey="ordini"
              />
              <SortableHeaderLink
                className="table-heading--numeric"
                directionParam="preparazioniDirezione"
                keyParam="preparazioniOrdina"
                label={copy.orders.total}
                sort={sort}
                sortKey="totale"
              />
              <SortableHeaderLink
                directionParam="preparazioniDirezione"
                keyParam="preparazioniOrdina"
                label={copy.orders.status}
                sort={sort}
                sortKey="stato"
              />
              <th>
                <span className="orders-table__action-label">{copy.orders.actions}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {cases.rows.map((billingCase) => (
              <tr key={billingCase.id}>
                <td data-label={copy.orders.preparation}>
                  <span className="orders-table__primary">
                    <Link
                      aria-label={copy.orders.openPreparation(billingCase.public_number)}
                      to={`/ordini/preparazione/${billingCase.id}`}
                    >
                      {billingCase.public_number}
                    </Link>
                    <small>{billingCase.order_references ?? copy.orders.preparationContext}</small>
                  </span>
                </td>
                <td data-label={copy.orders.customer}>
                  <strong className="orders-table__truncate" title={billingCase.customer_name}>
                    {billingCase.customer_name}
                  </strong>
                </td>
                <td data-label={copy.orders.date}>
                  <time
                    dateTime={
                      view === "fatturare" && billingCase.first_order_created_at
                        ? billingCase.first_order_created_at
                        : billingCase.local_order_date
                    }
                  >
                    {view === "fatturare" && billingCase.first_order_created_at
                      ? compactDateTime(billingCase.first_order_created_at)
                      : compactDate(billingCase.local_order_date)}
                  </time>
                </td>
                <td className="table-cell--numeric" data-label={copy.orders.orders}>
                  <strong>{billingCase.order_count}</strong>
                </td>
                <td className="table-cell--numeric" data-label={copy.orders.total}>
                  <strong>{euros(billingCase.total_amount)}</strong>
                </td>
                <td data-label={copy.orders.status}>
                  <span
                    className={`orders-status orders-status--${caseStatusTone(
                      view === "annullati" ? billingCase.status : billingCase.operational_pool,
                    )}`}
                  >
                    {view === "annullati"
                      ? (billingCaseStatusLabels[billingCase.status] ?? copy.common.unknownStatus)
                      : (copy.orders.preparationPoolLabels[billingCase.operational_pool] ??
                        copy.common.unknownStatus)}
                  </span>
                  {view !== "annullati" && billingCase.reasonCodes[0] ? (
                    <small className="orders-table__status-reason">
                      {anomalyLabels[billingCase.reasonCodes[0]]?.title ??
                        copy.orders.preparationPoolLabels[billingCase.operational_pool]}
                    </small>
                  ) : null}
                </td>
                <td data-label={copy.orders.actions} className="orders-table__action">
                  <Link
                    aria-label={copy.orders.openPreparationDetail(billingCase.public_number)}
                    className="dashboard-row-link"
                    to={`/ordini/preparazione/${billingCase.id}`}
                  >
                    <span>{copy.orders.openPreparationAction}</span>
                    <ArrowRight aria-hidden="true" size={17} strokeWidth={1.8} />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function OrderList({
  csrfToken,
  filters,
  fixtureEnabled,
  orders,
  showsPreparations,
  sort,
  view,
}: {
  csrfToken: string;
  filters: OrdersPageData["filters"];
  fixtureEnabled: boolean;
  orders: OrdersPageData["orders"];
  showsPreparations: boolean;
  sort: SortState<OrderListSortKey>;
  view: string;
}) {
  return (
    <section
      className="dashboard-panel orders-panel section-gap"
      aria-labelledby="orders-list-title"
    >
      <header className="orders-panel__header">
        <span className="dashboard-icon dashboard-icon--accent" aria-hidden="true">
          <ShoppingBag size={22} strokeWidth={1.8} />
        </span>
        <span>
          <h2 id="orders-list-title">
            {view === "annullati"
              ? copy.orders.cancelledOrders
              : view === "attesa"
                ? copy.orders.pendingOrderListTitle
                : copy.orders.orderListTitle}
          </h2>
          {view !== "attesa" ? <p>{copy.orders.orderListHelp}</p> : null}
        </span>
        <strong className="orders-panel__count">{copy.orders.pageItems(orders.rows.length)}</strong>
      </header>
      {!showsPreparations ? (
        <OrderFilters
          count={orders.rows.length}
          filters={filters}
          key={`${view}:${JSON.stringify(filters)}`}
          view={view}
        />
      ) : null}
      {orders.rows.length ? (
        <div className="table-wrap orders-table-wrap">
          <table className="orders-table data-table">
            <colgroup>
              <col className="orders-table__order-column" />
              <col className="orders-table__customer-column" />
              <col className="orders-table__date-column" />
              <col className="orders-table__total-column" />
              <col className="orders-table__status-column" />
              <col className="orders-table__preparation-column" />
              <col className="orders-table__action-column" />
            </colgroup>
            <thead>
              <tr>
                <SortableHeaderLink
                  directionParam="ordiniDirezione"
                  keyParam="ordiniOrdina"
                  label={copy.orders.order}
                  sort={sort}
                  sortKey="ordine"
                />
                <SortableHeaderLink
                  directionParam="ordiniDirezione"
                  keyParam="ordiniOrdina"
                  label={copy.orders.customer}
                  sort={sort}
                  sortKey="cliente"
                />
                <SortableHeaderLink
                  directionParam="ordiniDirezione"
                  keyParam="ordiniOrdina"
                  label={copy.orders.date}
                  sort={sort}
                  sortKey="data"
                />
                <SortableHeaderLink
                  className="table-heading--numeric"
                  directionParam="ordiniDirezione"
                  keyParam="ordiniOrdina"
                  label={copy.orders.total}
                  sort={sort}
                  sortKey="totale"
                />
                <SortableHeaderLink
                  directionParam="ordiniDirezione"
                  keyParam="ordiniOrdina"
                  label={copy.orders.status}
                  sort={sort}
                  sortKey="stato"
                />
                <SortableHeaderLink
                  directionParam="ordiniDirezione"
                  keyParam="ordiniOrdina"
                  label={copy.orders.preparation}
                  sort={sort}
                  sortKey="preparazione"
                />
                <th>
                  <span className="orders-table__action-label">{copy.orders.actions}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {orders.rows.map((order) => (
                <tr key={order.id}>
                  <td data-label={copy.orders.order}>
                    <span className="orders-table__primary">
                      <Link
                        aria-label={`${order.provider === "SHOPIFY" ? "Shopify" : "eBay"} ${order.display_number}`}
                        to={`/ordini/${order.id}`}
                      >
                        {order.display_number}
                      </Link>
                      <small>{order.provider === "SHOPIFY" ? "Shopify" : "eBay"}</small>
                    </span>
                  </td>
                  <td data-label={copy.orders.customer}>
                    <strong className="orders-table__truncate" title={order.customer_name}>
                      {order.customer_name}
                    </strong>
                  </td>
                  <td data-label={copy.orders.date}>
                    <time dateTime={order.local_order_date}>
                      {compactDate(order.local_order_date)}
                    </time>
                  </td>
                  <td className="table-cell--numeric" data-label={copy.orders.total}>
                    <strong>{euros(order.gross_amount)}</strong>
                  </td>
                  <td data-label={copy.orders.status}>
                    <span
                      className={`orders-status orders-status--${orderStatusTone(order.trigger_status)}`}
                      title={orderStatusLabels[order.trigger_status] ?? copy.common.unknownStatus}
                    >
                      {view === "attesa"
                        ? copy.orders.preparationPoolLabels.PENDING_PAYMENT
                        : (orderListStatusLabels[order.trigger_status] ??
                          copy.common.unknownStatus)}
                    </span>
                  </td>
                  <td data-label={copy.orders.preparation}>
                    {order.billing_case_id ? (
                      <span className="orders-table__primary">
                        <Link
                          aria-label={copy.orders.openPreparation(String(order.case_number))}
                          to={`/ordini/preparazione/${order.billing_case_id}`}
                        >
                          {order.case_number}
                        </Link>
                        <small>{copy.orders.preparationContext}</small>
                      </span>
                    ) : (
                      <span className="orders-table__muted">{copy.orders.noPreparation}</span>
                    )}
                  </td>
                  <td data-label={copy.orders.actions} className="orders-table__action">
                    <Link
                      aria-label={copy.orders.openOrder(
                        order.provider === "SHOPIFY" ? "Shopify" : "eBay",
                        order.display_number,
                      )}
                      className="dashboard-row-link"
                      to={`/ordini/${order.id}`}
                    >
                      <span>{copy.orders.openOrderAction}</span>
                      <ArrowRight aria-hidden="true" size={17} strokeWidth={1.8} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state orders-panel__empty">
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
  );
}

function OrdersNotices({ data }: { data: OrdersPageData }) {
  const error = useActionData<typeof action>();
  const {
    imported,
    updated,
    ignored,
    approved,
    approvalErrors,
    storagePending,
    view,
    inventoryApprovalState,
  } = data;
  return (
    <>
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
          {copy.orders.massApprovalResult(approved, approvalErrors ?? "0", storagePending ?? "0")}
        </p>
      ) : null}
      {view === "fatturare" && inventoryApprovalState ? (
        <p className={inventoryApprovalState === "BLOCKED" ? "warning" : "notice"} role="status">
          {copy.document.inventoryApprovalStates[inventoryApprovalState]}
        </p>
      ) : null}
    </>
  );
}

function OrdersResults({ data }: { data: OrdersPageData }) {
  const {
    canApprove,
    cases,
    csrfToken,
    filters,
    fixtureEnabled,
    orderSort,
    orders,
    page,
    preparationSort,
    view,
  } = data;
  const showsPreparations = view === "fatturare" || view === "attesa";
  const showsPreparationArchive = showsPreparations || view === "annullati";
  return (
    <>
      {showsPreparationArchive ? (
        <PreparationList
          cases={cases}
          ordersEmpty={!orders.rows.length}
          showsPreparations={showsPreparations}
          sort={preparationSort}
          view={view}
        />
      ) : null}

      {view === "fatturare" && canApprove ? <MassApprovalSection csrfToken={csrfToken} /> : null}

      {!showsPreparationArchive || (view === "attesa" && orders.rows.length) ? (
        <OrderList
          csrfToken={csrfToken}
          filters={filters}
          fixtureEnabled={fixtureEnabled}
          orders={orders}
          showsPreparations={showsPreparations}
          sort={orderSort}
          view={view}
        />
      ) : null}
      <Pager basePath="/ordini" hasNext={orders.hasNext || cases.hasNext} page={page} />
    </>
  );
}

export default function Orders() {
  const data = useLoaderData<typeof loader>();
  return (
    <AppShell username={data.username} canApprove={data.canApprove} csrfToken={data.csrfToken}>
      <div className="title-block">
        <p className="eyebrow">{copy.orders.eyebrow}</p>
        <h1>{copy.orders.title}</h1>
        <p>{copy.orders.intro}</p>
      </div>

      <ViewNavigation
        active={data.view}
        label={copy.orders.viewsLabel}
        items={[
          { value: "tutti", label: copy.orders.views.all, to: "/ordini" },
          {
            value: "fatturare",
            label: copy.orders.views.toInvoice,
            to: "/ordini?vista=fatturare",
          },
          {
            value: "attesa",
            label: copy.orders.views.waiting,
            to: "/ordini?vista=attesa",
          },
          {
            value: "annullati",
            label: copy.orders.views.cancelled,
            to: "/ordini?vista=annullati",
          },
        ]}
      />

      <OrdersNotices data={data} />
      <OrdersResults data={data} />
    </AppShell>
  );
}
