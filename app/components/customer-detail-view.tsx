import {
  ArrowRight,
  CircleAlert,
  CircleCheck,
  FileText,
  ShoppingBag,
  UsersRound,
} from "lucide-react";
import { Link } from "react-router";

import {
  billingCaseStatusLabels,
  customerKindLabels,
  customerMatchLabels,
  copy,
  orderStatusLabels,
  taxIdentifierLabels,
} from "../copy.it";
import { address, date, dateTime, euros, isoDateTime } from "../format";
import { fiscalNumberLabel } from "../../src/fiscal-number.ts";
import type { CustomerDetail } from "../../src/db/customers.server.ts";

function providerLabel(provider: string) {
  return provider === "SHOPIFY" ? "Shopify" : provider === "EBAY" ? "eBay" : provider;
}

function LinkedPanel({
  children,
  count,
  help,
  icon: Icon,
  id,
  title,
}: {
  children: React.ReactNode;
  count: number;
  help: string;
  icon: typeof ShoppingBag;
  id: string;
  title: string;
}) {
  return (
    <section className="dashboard-panel customer-detail-panel" aria-labelledby={id}>
      <header className="customer-detail-panel__header">
        <span className="dashboard-icon dashboard-icon--accent" aria-hidden="true">
          <Icon size={22} strokeWidth={1.8} />
        </span>
        <span>
          <h2 id={id}>{title}</h2>
          <p>{help}</p>
        </span>
        <strong className="customer-detail-panel__count">{count}</strong>
      </header>
      {children}
    </section>
  );
}

function CustomerOverview({ customer }: { customer: CustomerDetail }) {
  const reviewTarget =
    customer.preparations.find((preparation) => preparation.status === "NEEDS_REVIEW") ??
    customer.orders.find((order) =>
      ["NEEDS_REVIEW", "LEGACY_BILLING_REVIEW"].includes(order.trigger_status),
    );
  return (
    <section
      aria-label={copy.customers.statusLabel}
      className="dashboard-panel customer-detail-overview"
    >
      <div className="customer-detail-overview__lead">
        <span
          className={`dashboard-icon dashboard-icon--${customer.review_required ? "warning" : "success"}`}
          aria-hidden="true"
        >
          {customer.review_required ? (
            <CircleAlert size={24} strokeWidth={1.9} />
          ) : (
            <CircleCheck size={24} strokeWidth={1.9} />
          )}
        </span>
        <span>
          <strong>
            {customer.review_required ? copy.customers.needsReview : copy.customers.reliable}
          </strong>
          <span>
            {customer.review_required ? copy.customers.reviewHelp : copy.customers.overviewHelp}
          </span>
        </span>
        {customer.review_required && reviewTarget ? (
          <Link
            className="dashboard-row-link"
            to={
              "public_number" in reviewTarget
                ? `/ordini/preparazione/${reviewTarget.id}`
                : `/ordini/${reviewTarget.id}`
            }
          >
            <span>{copy.customers.activity}</span>
            <ArrowRight aria-hidden="true" size={17} strokeWidth={1.8} />
          </Link>
        ) : null}
      </div>
      <dl className="customer-detail-overview__counts">
        <div>
          <dt>{copy.customers.ordersTitle}</dt>
          <dd>{customer.order_count}</dd>
        </div>
        <div>
          <dt>{copy.customers.preparationsTitle}</dt>
          <dd>{customer.preparation_count}</dd>
        </div>
        <div>
          <dt>{copy.customers.documentsTitle}</dt>
          <dd>{customer.document_count}</dd>
        </div>
      </dl>
    </section>
  );
}

function CustomerRecord({ customer }: { customer: CustomerDetail }) {
  return (
    <section className="card" aria-labelledby="customer-record-title">
      <h2 id="customer-record-title">{copy.customers.currentRecord}</h2>
      <p className="section-intro">{copy.customers.currentRecordHelp}</p>
      <dl className="facts customer-record-facts">
        <div>
          <dt>{copy.customers.customerType}</dt>
          <dd>{customerKindLabels[customer.kind] ?? copy.common.unknownType}</dd>
        </div>
        <div>
          <dt>{copy.customers.name}</dt>
          <dd>{customer.display_name}</dd>
        </div>
        <div>
          <dt>{copy.customers.email}</dt>
          <dd>{customer.email ?? copy.common.unavailable}</dd>
        </div>
        <div>
          <dt>{copy.customers.phone}</dt>
          <dd>{customer.phone ?? copy.common.unavailable}</dd>
        </div>
        <div>
          <dt>{copy.customers.taxData}</dt>
          <dd>
            {customer.tax_id_type && customer.tax_id_normalized
              ? `${taxIdentifierLabels[customer.tax_id_type] ?? copy.customers.taxData} · ${customer.tax_id_normalized}`
              : copy.common.unavailable}
          </dd>
        </div>
        <div>
          <dt>{copy.customers.address}</dt>
          <dd>{address(customer.billing_address_json) || copy.common.unavailable}</dd>
        </div>
        <div>
          <dt>{copy.customers.recognizedBy}</dt>
          <dd>{customerMatchLabels[customer.source_confidence] ?? copy.common.unknownStatus}</dd>
        </div>
        <div>
          <dt>{copy.customers.updated}</dt>
          <dd>{dateTime(customer.updated_at)}</dd>
        </div>
      </dl>
    </section>
  );
}

function CustomerSources({ customer }: { customer: CustomerDetail }) {
  return (
    <section className="card" aria-labelledby="customer-source-title">
      <h2 id="customer-source-title">{copy.customers.sourceTitle}</h2>
      <p className="section-intro">{copy.customers.sourceHelp}</p>
      {customer.sources.length ? (
        <ul className="customer-source-list">
          {customer.sources.map((source) => (
            <li key={source.id}>
              <span>
                <strong>{providerLabel(source.provider)}</strong>
                <small>{copy.customers.sourceReference}</small>
                <span>{source.external_customer_id}</span>
              </span>
              <span>
                <small>{copy.customers.sourceUpdated}</small>
                <time dateTime={isoDateTime(source.imported_at)}>
                  {dateTime(source.imported_at)}
                </time>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted-copy">{copy.customers.noSources}</p>
      )}
    </section>
  );
}

function CustomerOrders({ customer }: { customer: CustomerDetail }) {
  return (
    <LinkedPanel
      count={customer.order_count}
      help={copy.customers.linkedItemsHelp}
      icon={ShoppingBag}
      id="customer-orders-title"
      title={copy.customers.ordersTitle}
    >
      {customer.orders.length ? (
        <ul className="customer-linked-list">
          {customer.orders.map((order) => (
            <li key={order.id}>
              <span className="customer-linked-list__main">
                <small>{providerLabel(order.provider)}</small>
                <Link to={`/ordini/${order.id}`}>{order.display_number}</Link>
              </span>
              <span className="customer-linked-list__facts">
                <span>
                  <small>{copy.customers.date}</small>
                  <strong>{date(order.local_order_date)}</strong>
                </span>
                <span>
                  <small>{copy.customers.total}</small>
                  <strong>{euros(order.gross_amount)}</strong>
                </span>
                <span>
                  <small>{copy.customers.status}</small>
                  <strong>
                    {orderStatusLabels[order.trigger_status] ?? copy.common.unknownStatus}
                  </strong>
                </span>
              </span>
              <Link
                aria-label={`${copy.customers.activity}: ${order.display_number}`}
                className="dashboard-row-link"
                to={`/ordini/${order.id}`}
              >
                <span>{copy.customers.activity}</span>
                <ArrowRight aria-hidden="true" size={17} strokeWidth={1.8} />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="customer-linked-list__empty">{copy.customers.noOrders}</p>
      )}
      {customer.order_count > customer.orders.length ? (
        <p className="customer-linked-list__limit">{copy.customers.latestLimit}</p>
      ) : null}
    </LinkedPanel>
  );
}

function CustomerPreparations({ customer }: { customer: CustomerDetail }) {
  return (
    <LinkedPanel
      count={customer.preparation_count}
      help={copy.customers.linkedItemsHelp}
      icon={UsersRound}
      id="customer-preparations-title"
      title={copy.customers.preparationsTitle}
    >
      {customer.preparations.length ? (
        <ul className="customer-linked-list">
          {customer.preparations.map((preparation) => (
            <li key={preparation.id}>
              <span className="customer-linked-list__main">
                <small>{copy.customers.preparation}</small>
                <Link to={`/ordini/preparazione/${preparation.id}`}>
                  {preparation.public_number}
                </Link>
              </span>
              <span className="customer-linked-list__facts">
                <span>
                  <small>{copy.customers.date}</small>
                  <strong>{date(preparation.local_order_date)}</strong>
                </span>
                <span>
                  <small>{copy.customers.total}</small>
                  <strong>{euros(preparation.total_amount)}</strong>
                </span>
                <span>
                  <small>{copy.customers.status}</small>
                  <strong>
                    {billingCaseStatusLabels[preparation.status] ?? copy.common.unknownStatus}
                  </strong>
                </span>
              </span>
              <Link
                aria-label={`${copy.customers.activity}: ${preparation.public_number}`}
                className="dashboard-row-link"
                to={`/ordini/preparazione/${preparation.id}`}
              >
                <span>{copy.customers.activity}</span>
                <ArrowRight aria-hidden="true" size={17} strokeWidth={1.8} />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="customer-linked-list__empty">{copy.customers.noPreparations}</p>
      )}
      {customer.preparation_count > customer.preparations.length ? (
        <p className="customer-linked-list__limit">{copy.customers.latestLimit}</p>
      ) : null}
    </LinkedPanel>
  );
}

function CustomerDocuments({ customer }: { customer: CustomerDetail }) {
  return (
    <LinkedPanel
      count={customer.document_count}
      help={copy.customers.linkedItemsHelp}
      icon={FileText}
      id="customer-documents-title"
      title={copy.customers.documentsTitle}
    >
      {customer.documents.length ? (
        <ul className="customer-linked-list">
          {customer.documents.map((document) => {
            const approved = document.fiscal_year !== null && document.fiscal_number !== null;
            const label = approved
              ? fiscalNumberLabel(document.series, document.fiscal_year!, document.fiscal_number!)
              : document.kind === "CREDIT_NOTE"
                ? copy.customers.draftCreditNote
                : copy.customers.draftInvoice;
            const target =
              document.kind === "CREDIT_NOTE"
                ? `/documenti/${document.id}/nota`
                : `/ordini/preparazione/${document.billing_case_id}`;
            return (
              <li key={document.id}>
                <span className="customer-linked-list__main">
                  <small>
                    {document.kind === "CREDIT_NOTE"
                      ? copy.customers.creditNote
                      : copy.customers.invoice}
                  </small>
                  <Link to={target}>{label}</Link>
                </span>
                <span className="customer-linked-list__facts">
                  <span>
                    <small>{copy.customers.date}</small>
                    <strong>{date(document.document_date)}</strong>
                  </span>
                  <span>
                    <small>{copy.customers.total}</small>
                    <strong>{euros(document.total_amount)}</strong>
                  </span>
                  <span>
                    <small>{copy.customers.status}</small>
                    <strong>
                      {document.status === "APPROVED"
                        ? copy.documents.approved
                        : copy.documents.draft}
                    </strong>
                  </span>
                </span>
                <Link
                  aria-label={`${copy.customers.activity}: ${label}`}
                  className="dashboard-row-link"
                  to={target}
                >
                  <span>{copy.customers.activity}</span>
                  <ArrowRight aria-hidden="true" size={17} strokeWidth={1.8} />
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="customer-linked-list__empty">{copy.customers.noDocuments}</p>
      )}
      {customer.document_count > customer.documents.length ? (
        <p className="customer-linked-list__limit">{copy.customers.latestLimit}</p>
      ) : null}
    </LinkedPanel>
  );
}

export function CustomerDetailView({ customer }: { customer: CustomerDetail }) {
  return (
    <>
      <CustomerOverview customer={customer} />
      <div className="detail-grid customer-record-grid">
        <CustomerRecord customer={customer} />
        <CustomerSources customer={customer} />
      </div>
      <div className="customer-detail-stack">
        <CustomerOrders customer={customer} />
        <CustomerPreparations customer={customer} />
        <CustomerDocuments customer={customer} />
      </div>
    </>
  );
}
