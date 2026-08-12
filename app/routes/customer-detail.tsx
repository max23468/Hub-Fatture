import { ArrowRight, FileText, Mail, MapPin, Phone, ReceiptText, ShoppingBag } from "lucide-react";
import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/customer-detail";

import { AppShell } from "../components/app-shell";
import { copy } from "../copy.it";
import { date, euros } from "../format";
import { requireSessionUser } from "../../src/db/auth.server.ts";
import { getCustomer } from "../../src/db/search.server.ts";

export async function loader({ params, request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const customer = await getCustomer(params.customerId ?? "");
  if (!customer) throw new Response("Cliente non trovato", { status: 404 });
  return {
    username: user.username,
    canApprove: user.canApprove,
    csrfToken: user.csrfToken,
    customer,
  };
}

export function meta(_: Route.MetaArgs) {
  return [{ title: "Cliente · Hub Fatture" }];
}

function address(value: Record<string, string | undefined>): string {
  return [
    value.line1,
    value.line2,
    [value.postalCode, value.city].filter(Boolean).join(" "),
    value.province,
    value.countryCode,
  ]
    .filter(Boolean)
    .join(", ");
}

export default function CustomerDetail() {
  const { username, canApprove, csrfToken, customer } = useLoaderData<typeof loader>();
  const customerAddress = address(customer.billing_address_json);
  const kind = copy.customer.kinds[customer.kind] ?? copy.customer.kinds.UNKNOWN;
  return (
    <AppShell username={username} canApprove={canApprove} csrfToken={csrfToken}>
      <div className="title-block customer-title">
        <p className="eyebrow">{copy.customer.eyebrow}</p>
        <h1>{customer.display_name}</h1>
        <p>{copy.customer.intro(Number(customer.order_count), Number(customer.document_count))}</p>
      </div>

      <div className="customer-detail-grid">
        <section
          className="dashboard-panel customer-overview"
          aria-labelledby="customer-data-title"
        >
          <div className="customer-section-heading">
            <span className="dashboard-icon dashboard-icon--accent" aria-hidden="true">
              <ReceiptText size={23} strokeWidth={1.8} />
            </span>
            <span>
              <h2 id="customer-data-title">{copy.customer.data}</h2>
              <p>{kind}</p>
            </span>
          </div>
          <dl className="customer-facts">
            <div>
              <dt>
                <Mail aria-hidden="true" size={17} strokeWidth={1.8} />
                {copy.customer.email}
              </dt>
              <dd>{customer.email ?? copy.common.unavailable}</dd>
            </div>
            <div>
              <dt>
                <Phone aria-hidden="true" size={17} strokeWidth={1.8} />
                {copy.customer.phone}
              </dt>
              <dd>{customer.phone ?? copy.common.unavailable}</dd>
            </div>
            <div>
              <dt>
                <FileText aria-hidden="true" size={17} strokeWidth={1.8} />
                {customer.tax_id_type === "PARTITA_IVA"
                  ? copy.customer.vatNumber
                  : copy.customer.taxCode}
              </dt>
              <dd>{customer.tax_id_normalized ?? copy.common.unavailable}</dd>
            </div>
            <div>
              <dt>
                <MapPin aria-hidden="true" size={17} strokeWidth={1.8} />
                {copy.customer.billingAddress}
              </dt>
              <dd>{customerAddress || copy.common.unavailable}</dd>
            </div>
          </dl>
        </section>

        <section
          className="dashboard-panel customer-history"
          aria-labelledby="customer-orders-title"
        >
          <div className="customer-section-heading">
            <span className="dashboard-icon dashboard-icon--neutral" aria-hidden="true">
              <ShoppingBag size={22} strokeWidth={1.8} />
            </span>
            <span>
              <h2 id="customer-orders-title">{copy.customer.orders}</h2>
              <p>{copy.customer.orderCount(Number(customer.order_count))}</p>
            </span>
          </div>
          {customer.orders.length ? (
            <div className="customer-link-list">
              {customer.orders.map((order) => (
                <Link key={order.id} to={`/ordini/${order.id}`}>
                  <span>
                    <strong>{copy.search.order(order.provider, order.displayNumber)}</strong>
                    <small>{date(order.localOrderDate)}</small>
                  </span>
                  <span className="customer-link-list__value">{euros(order.grossAmount)}</span>
                  <ArrowRight aria-hidden="true" size={17} strokeWidth={1.8} />
                </Link>
              ))}
            </div>
          ) : (
            <p className="customer-empty">{copy.customer.noOrders}</p>
          )}
          {Number(customer.order_count) > customer.orders.length ? (
            <Link
              className="customer-history__all"
              to={`/ordini?q=${encodeURIComponent(customer.display_name)}`}
            >
              {copy.customer.allOrders}
              <ArrowRight aria-hidden="true" size={17} strokeWidth={1.8} />
            </Link>
          ) : null}
        </section>
      </div>

      <section
        className="dashboard-panel customer-documents"
        aria-labelledby="customer-documents-title"
      >
        <div className="customer-section-heading">
          <span className="dashboard-icon dashboard-icon--success" aria-hidden="true">
            <FileText size={22} strokeWidth={1.8} />
          </span>
          <span>
            <h2 id="customer-documents-title">{copy.customer.invoices}</h2>
            <p>{copy.customer.documentCount(Number(customer.document_count))}</p>
          </span>
        </div>
        {customer.documents.length ? (
          <div className="customer-link-list customer-link-list--documents">
            {customer.documents.map((document) => (
              <Link key={document.id} to={`/ordini/preparazione/${document.caseId}`}>
                <span>
                  <strong>
                    {document.fiscalLabel
                      ? copy.search.invoice(document.fiscalLabel)
                      : copy.search.invoicePreparation(document.caseNumber)}
                  </strong>
                  <small>
                    {date(document.documentDate)} ·{" "}
                    {copy.customer.documentStatuses[document.status] ?? copy.common.unknownStatus}
                  </small>
                </span>
                <span className="customer-link-list__value">{euros(document.totalAmount)}</span>
                <ArrowRight aria-hidden="true" size={17} strokeWidth={1.8} />
              </Link>
            ))}
          </div>
        ) : (
          <p className="customer-empty">{copy.customer.noInvoices}</p>
        )}
      </section>
    </AppShell>
  );
}
