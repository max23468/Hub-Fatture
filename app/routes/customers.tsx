import { ArrowRight, CircleAlert, UsersRound } from "lucide-react";
import { Form, Link, useLoaderData } from "react-router";
import type { Route } from "./+types/customers";

import { AppShell } from "../components/app-shell";
import { Pager } from "../components/pager";
import { ViewNavigation } from "../components/view-navigation";
import { customerKindLabels, copy } from "../copy.it";
import { date } from "../format";
import { requireSessionUser } from "../../src/db/auth.server.ts";
import { customerDirectorySummary, listCustomers } from "../../src/db/customers.server.ts";
import { pageNumber } from "../../src/orders.ts";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const url = new URL(request.url);
  const view = url.searchParams.get("vista") === "verificare" ? "verificare" : "tutti";
  const query = url.searchParams.get("q") ?? "";
  const page = pageNumber(url.searchParams.get("pagina") ?? 1);
  const [summary, customers] = await Promise.all([
    customerDirectorySummary(),
    listCustomers({
      query: query || undefined,
      needsReview: view === "verificare" ? true : undefined,
      page,
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
  };
}

function channelLabel(providers: string[]) {
  return providers
    .map((provider) =>
      provider === "SHOPIFY" ? "Shopify" : provider === "EBAY" ? "eBay" : provider,
    )
    .join(" · ");
}

export default function Customers() {
  const { username, canApprove, csrfToken, summary, customers, view, query, page } =
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
          <ul className="customer-list">
            {customers.rows.map((customer) => (
              <li className="customer-row" key={customer.id}>
                <span className="customer-row__main">
                  <small className={customer.review_required ? "customer-row__state--warning" : ""}>
                    {customer.review_required
                      ? copy.customers.needsReview
                      : (customerKindLabels[customer.kind] ?? copy.common.unknownType)}
                  </small>
                  <Link to={`/clienti/${customer.id}`}>{customer.display_name}</Link>
                  {customer.review_required ? (
                    <span>{customerKindLabels[customer.kind] ?? copy.common.unknownType}</span>
                  ) : null}
                </span>
                <span className="customer-row__facts">
                  <span className="customer-row__fact--email">
                    <small>{copy.customers.email}</small>
                    <strong>{customer.email ?? copy.common.unavailable}</strong>
                  </span>
                  <span>
                    <small>{copy.customers.channels}</small>
                    <strong>{channelLabel(customer.providers) || copy.common.unavailable}</strong>
                  </span>
                  <span>
                    <small>{copy.customers.lastOrder}</small>
                    <strong>
                      {customer.last_order_date
                        ? date(customer.last_order_date)
                        : copy.common.unavailable}
                    </strong>
                  </span>
                </span>
                <span className="customer-row__activity">
                  <span>{copy.customers.orderCount(customer.order_count)}</span>
                  <span>{copy.customers.documentCount(customer.document_count)}</span>
                </span>
                <Link
                  aria-label={copy.customers.openCustomer(customer.display_name)}
                  className="dashboard-row-link"
                  to={`/clienti/${customer.id}`}
                >
                  <span>{copy.customers.activity}</span>
                  <ArrowRight aria-hidden="true" size={17} strokeWidth={1.8} />
                </Link>
              </li>
            ))}
          </ul>
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
