import { ArrowRight, CircleAlert, UsersRound } from "lucide-react";
import { Form, Link, useLoaderData } from "react-router";
import type { Route } from "./+types/customers";

import { AppShell } from "../components/app-shell";
import { Pager } from "../components/pager";
import { SortableHeaderLink, SortControlLink } from "../components/sortable-table";
import { ViewNavigation } from "../components/view-navigation";
import { customerKindLabels, copy } from "../copy.it";
import { date } from "../format";
import { requireSessionUser } from "../../src/db/auth.server.ts";
import {
  customerDirectorySummary,
  listCustomers,
  type CustomerListSortKey,
} from "../../src/db/customers.server.ts";
import { pageNumber } from "../../src/orders.ts";
import { parseSort } from "../table-sort";

const customerSortKeys = [
  "cliente",
  "email",
  "fiscale",
  "canale",
  "ultimoOrdine",
  "ordini",
  "documenti",
] as const;

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const url = new URL(request.url);
  const view = url.searchParams.get("vista") === "verificare" ? "verificare" : "tutti";
  const query = url.searchParams.get("q") ?? "";
  const page = pageNumber(url.searchParams.get("pagina") ?? 1);
  const sort = parseSort(
    url.searchParams.get("ordina"),
    url.searchParams.get("direzione"),
    customerSortKeys,
    { key: "ultimoOrdine" as CustomerListSortKey, direction: "desc" },
  );
  const [summary, customers] = await Promise.all([
    customerDirectorySummary(),
    listCustomers({
      query: query || undefined,
      needsReview: view === "verificare" ? true : undefined,
      page,
      sort,
    }),
  ]);
  return {
    username: user.username,
    canApprove: user.canApprove,
    csrfToken: user.csrfToken,
    summary,
    customers,
    view,
    query,
    page,
    sort,
  };
}

function channelLabel(providers: string[]) {
  return providers
    .map((provider) =>
      provider === "SHOPIFY" ? "Shopify" : provider === "EBAY" ? "eBay" : provider,
    )
    .join(" · ");
}

function activityAriaSort(sort: { key: CustomerListSortKey; direction: "asc" | "desc" }) {
  if (sort.key !== "ordini" && sort.key !== "documenti") return "none" as const;
  return sort.direction === "asc" ? ("ascending" as const) : ("descending" as const);
}

export default function Customers() {
  const { username, canApprove, csrfToken, summary, customers, view, query, page, sort } =
    useLoaderData<typeof loader>();
  const resetTo = view === "verificare" ? "/clienti?vista=verificare" : "/clienti";

  return (
    <AppShell username={username} canApprove={canApprove} csrfToken={csrfToken}>
      <div className="title-block dashboard-title customers-title">
        <p className="eyebrow">{copy.customers.eyebrow}</p>
        <h1>{copy.customers.title}</h1>
        <p>{copy.customers.intro}</p>
      </div>

      <ViewNavigation
        active={view}
        label={copy.customers.viewsLabel}
        items={[
          { value: "tutti", label: copy.customers.views.all, to: "/clienti" },
          {
            value: "verificare",
            label: copy.customers.views.needsReview,
            to: "/clienti?vista=verificare",
          },
        ]}
      />

      <section
        aria-label={copy.customers.overviewLabel}
        className="dashboard-panel customers-overview"
      >
        <div className="customers-overview__lead">
          <span className="dashboard-icon dashboard-icon--accent" aria-hidden="true">
            <UsersRound size={24} strokeWidth={1.9} />
          </span>
          <span>
            <strong>{copy.customers.totalCount(summary.total)}</strong>
            <span>{copy.customers.overviewHelp}</span>
          </span>
        </div>
        <dl className="customers-overview__counts">
          <div>
            <dt>{copy.customers.needsReviewCount}</dt>
            <dd>{summary.needs_review}</dd>
          </div>
          <div>
            <dt>{copy.customers.shopifyCount}</dt>
            <dd>{summary.shopify}</dd>
          </div>
          <div>
            <dt>{copy.customers.ebayCount}</dt>
            <dd>{summary.ebay}</dd>
          </div>
        </dl>
      </section>

      <section
        className="dashboard-panel customer-directory"
        aria-labelledby="customers-list-title"
      >
        <header className="customer-directory__header">
          <span>
            <h2 id="customers-list-title">{copy.customers.directoryTitle}</h2>
            <p>{copy.customers.directoryHelp}</p>
          </span>
          <Form
            aria-label={copy.customers.filterLabel}
            className="customer-search"
            method="get"
            role="search"
          >
            {view === "verificare" ? <input type="hidden" name="vista" value={view} /> : null}
            <label>
              <span>{copy.customers.search}</span>
              <input defaultValue={query} name="q" placeholder={copy.customers.searchPlaceholder} />
            </label>
            <button className="button button--secondary" type="submit">
              {copy.customers.filter}
            </button>
          </Form>
        </header>
        <div className="customer-directory__summary" aria-live="polite">
          <span>{copy.customers.resultsOnPage(customers.rows.length)}</span>
          {query ? <span>{copy.customers.activeFilter}</span> : null}
          {query ? <Link to={resetTo}>{copy.customers.resetFilters}</Link> : null}
        </div>

        {customers.rows.length ? (
          <div className="customer-table-wrap table-wrap">
            <table className="customer-table data-table">
              <colgroup>
                <col className="customer-table__customer-column" />
                <col className="customer-table__email-column" />
                <col className="customer-table__tax-column" />
                <col className="customer-table__channel-column" />
                <col className="customer-table__date-column" />
                <col className="customer-table__activity-column" />
                <col className="customer-table__action-column" />
              </colgroup>
              <thead>
                <tr>
                  <SortableHeaderLink
                    directionParam="direzione"
                    keyParam="ordina"
                    label={copy.customers.customer}
                    sort={sort}
                    sortKey="cliente"
                  />
                  <SortableHeaderLink
                    directionParam="direzione"
                    keyParam="ordina"
                    label={copy.customers.email}
                    sort={sort}
                    sortKey="email"
                  />
                  <SortableHeaderLink
                    directionParam="direzione"
                    keyParam="ordina"
                    label={copy.customers.taxIdentifier}
                    sort={sort}
                    sortKey="fiscale"
                  />
                  <SortableHeaderLink
                    directionParam="direzione"
                    keyParam="ordina"
                    label={copy.customers.channels}
                    sort={sort}
                    sortKey="canale"
                  />
                  <SortableHeaderLink
                    directionParam="direzione"
                    keyParam="ordina"
                    label={copy.customers.lastOrder}
                    sort={sort}
                    sortKey="ultimoOrdine"
                  />
                  <th aria-sort={activityAriaSort(sort)} scope="col">
                    <span
                      aria-label={copy.customers.activity}
                      className="customer-table__activity-sorters"
                      role="group"
                    >
                      <SortControlLink
                        directionParam="direzione"
                        keyParam="ordina"
                        label={copy.customers.orders}
                        sort={sort}
                        sortKey="ordini"
                      />
                      <SortControlLink
                        directionParam="direzione"
                        keyParam="ordina"
                        label={copy.customers.documents}
                        sort={sort}
                        sortKey="documenti"
                      />
                    </span>
                  </th>
                  <th>{copy.customers.actions}</th>
                </tr>
              </thead>
              <tbody>
                {customers.rows.map((customer) => {
                  const email = customer.email ?? copy.common.unavailable;
                  const taxIdentifier = customer.tax_id_normalized ?? copy.common.unavailable;
                  const channels = channelLabel(customer.providers) || copy.common.unavailable;
                  return (
                    <tr key={customer.id}>
                      <td data-label={copy.customers.customer}>
                        <span className="customer-table__primary">
                          <Link to={`/clienti/${customer.id}`}>{customer.display_name}</Link>
                          <small
                            className={
                              customer.review_required ? "customer-table__state--warning" : ""
                            }
                          >
                            {customer.review_required
                              ? copy.customers.needsReview
                              : (customerKindLabels[customer.kind] ?? copy.common.unknownType)}
                          </small>
                          {customer.review_required ? (
                            <span>
                              {customerKindLabels[customer.kind] ?? copy.common.unknownType}
                            </span>
                          ) : null}
                        </span>
                      </td>
                      <td data-label={copy.customers.email}>
                        <strong className="customer-table__clamp" title={email}>
                          {email}
                        </strong>
                      </td>
                      <td data-label={copy.customers.taxIdentifier}>
                        <strong className="customer-table__truncate" title={taxIdentifier}>
                          {taxIdentifier}
                        </strong>
                      </td>
                      <td data-label={copy.customers.channels}>
                        <strong>{channels}</strong>
                      </td>
                      <td data-label={copy.customers.lastOrder}>
                        {customer.last_order_date ? (
                          <time dateTime={customer.last_order_date}>
                            {date(customer.last_order_date)}
                          </time>
                        ) : (
                          copy.common.unavailable
                        )}
                      </td>
                      <td className="customer-table__activity" data-label={copy.customers.activity}>
                        <span className="customer-table__activity-stack">
                          <span>{copy.customers.orderCount(customer.order_count)}</span>
                          <span>{copy.customers.documentCount(customer.document_count)}</span>
                        </span>
                      </td>
                      <td className="customer-table__action" data-label={copy.customers.actions}>
                        <Link
                          aria-label={copy.customers.openCustomer(customer.display_name)}
                          className="dashboard-row-link"
                          to={`/clienti/${customer.id}`}
                        >
                          <span>{copy.customers.openDetail}</span>
                          <ArrowRight aria-hidden="true" size={17} strokeWidth={1.8} />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="customer-directory__empty">
            <span className="dashboard-icon dashboard-icon--warning" aria-hidden="true">
              <CircleAlert size={22} strokeWidth={1.8} />
            </span>
            <span>
              <h2>{query ? copy.customers.noResults : copy.customers.noCustomers}</h2>
              <p>{query ? copy.customers.noResultsHelp : copy.customers.noCustomersHelp}</p>
            </span>
          </div>
        )}
      </section>

      <Pager basePath="/clienti" hasNext={customers.hasNext} page={page} />
    </AppShell>
  );
}
