import { CreditCard, PackageCheck, ReceiptText, UserRound } from "lucide-react";
import { useState } from "react";
import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/order-detail";

import { actionResult } from "../action";
import { AppShell } from "../components/app-shell";
import { DetailSectionHeader } from "../components/detail-section-header";
import { SortableHeader, useSortableRows } from "../components/sortable-table";
import {
  customerKindLabels,
  customerMatchLabels,
  copy,
  fulfillmentStatusLabels,
  orderStatusLabels,
  paymentStatusLabels,
  refundStatusLabels,
  taxIdentifierLabels,
} from "../copy.it";
import { address, date, dateTime, euros } from "../format";
import type { SortValue } from "../table-sort";
import { ARUBA_UPLOAD_MAX_BYTES } from "../../src/aruba.ts";
import { assertCsrf, requestId, requireSessionUser } from "../../src/db/auth.server.ts";
import { readForm, readMultipartForm } from "../../src/http.server.ts";
import {
  forcePrepareOrder,
  getOrder,
  reconcileHistoricalOrder,
} from "../../src/db/orders.server.ts";

type OrderLine = NonNullable<Awaited<ReturnType<typeof getOrder>>>["lines"][number];
type OrderLineSortKey = "description" | "quantity" | "gross_amount" | "discount_amount";

function orderLineValue(line: OrderLine, key: OrderLineSortKey): SortValue {
  return line[key];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const order = await getOrder(params.orderId);
  if (!order) throw new Response("Ordine non trovato", { status: 404 });
  return {
    username: user.username,
    canApprove: user.canApprove,
    csrfToken: user.csrfToken,
    order,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  return actionResult(async () => {
    const user = await requireSessionUser(request);
    const multipart = request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("multipart/form-data;");
    const form = multipart
      ? await readMultipartForm(request, { maxBytes: ARUBA_UPLOAD_MAX_BYTES + 64 * 1024 })
      : await readForm(request);
    assertCsrf(user, String(form.get("csrf") ?? ""));
    if (form.get("intent") === "reconcile-history") {
      const file = form.get("invoiceXml");
      const result = await reconcileHistoricalOrder(
        params.orderId,
        {
          outcome: form.get("outcome"),
          reference: form.get("reference"),
          invoiceXml:
            file instanceof File && file.size ? Buffer.from(await file.arrayBuffer()) : undefined,
          manualReviewApproved: form.get("manualReviewApproved") === "on",
        },
        { id: user.id, canApprove: user.canApprove, requestId: requestId(request) },
      );
      if (!result) throw new Response("Ordine non trovato", { status: 404 });
      return redirect(
        result.caseId
          ? `/ordini/preparazione/${result.caseId}`
          : `/ordini/${params.orderId}?riconciliazione=completata`,
      );
    }
    const caseId = await forcePrepareOrder(params.orderId, {
      id: user.id,
      requestId: requestId(request),
    });
    if (!caseId) throw new Response("Ordine non trovato", { status: 404 });
    return redirect(`/ordini/preparazione/${caseId}`);
  });
}

function OrderStatusActions({
  order,
  canApprove,
  csrfToken,
}: {
  order: NonNullable<Awaited<ReturnType<typeof getOrder>>>;
  canApprove: boolean;
  csrfToken: string;
}) {
  const [historicalOutcome, setHistoricalOutcome] = useState("");
  const needsInvoiceAttachment =
    order.historical_reconciliation_outcome === "ALREADY_INVOICED" && !order.historical_invoice_id;
  return (
    <>
      {!order.billing_case_id &&
      (order.trigger_status === "LEGACY_BILLING_REVIEW" || needsInvoiceAttachment) ? (
        canApprove ? (
          <Form method="post" encType="multipart/form-data" className="section-gap">
            <input type="hidden" name="csrf" value={csrfToken} />
            <input type="hidden" name="intent" value="reconcile-history" />
            <div className="notice">
              <strong>{copy.orderDetail.historyTitle}</strong>
              <p>{copy.orderDetail.historyHelp}</p>
            </div>
            {needsInvoiceAttachment ? (
              <input type="hidden" name="outcome" value="ALREADY_INVOICED" />
            ) : (
              <label>
                {copy.orderDetail.historyOutcome}
                <select
                  name="outcome"
                  required
                  value={historicalOutcome}
                  onChange={(event) => setHistoricalOutcome(event.currentTarget.value)}
                >
                  <option value="" disabled>
                    Seleziona un esito
                  </option>
                  <option value="ALREADY_INVOICED">{copy.orderDetail.alreadyInvoiced}</option>
                  <option value="NOT_INVOICED">{copy.orderDetail.notInvoiced}</option>
                </select>
              </label>
            )}
            <label>
              {copy.orderDetail.historyReference}
              <textarea
                name="reference"
                required
                minLength={10}
                maxLength={500}
                defaultValue={
                  needsInvoiceAttachment ? (order.historical_reconciliation_reference ?? "") : ""
                }
              />
            </label>
            <label>
              {copy.orderDetail.historyInvoiceXml}
              <input
                name="invoiceXml"
                type="file"
                accept="application/xml,text/xml,.xml"
                required={needsInvoiceAttachment || historicalOutcome === "ALREADY_INVOICED"}
              />
            </label>
            {order.provider === "EBAY" &&
            (needsInvoiceAttachment || historicalOutcome === "ALREADY_INVOICED") ? (
              <label className="checkbox-row">
                <input name="manualReviewApproved" type="checkbox" />
                <span>{copy.orderDetail.manualReviewApproved}</span>
              </label>
            ) : null}
            <button className="button" type="submit">
              {copy.orderDetail.reconcileHistory}
            </button>
          </Form>
        ) : null
      ) : !order.billing_case_id &&
        !["CANCELLED_NO_DOCUMENT", "REFUNDED_BEFORE_ISSUE", "INVOICED"].includes(
          order.trigger_status,
        ) ? (
        <Form method="post" className="section-gap">
          <input type="hidden" name="csrf" value={csrfToken} />
          <input type="hidden" name="intent" value="prepare" />
          <button className="button" type="submit">
            {copy.orderDetail.prepareNow}
          </button>
        </Form>
      ) : null}
      {order.historical_reconciliation_outcome ? (
        <div className="notice section-gap">
          <strong>{copy.orderDetail.historyCompleted}</strong>
          <p>
            {order.historical_reconciliation_outcome === "ALREADY_INVOICED"
              ? copy.orderDetail.alreadyInvoiced
              : copy.orderDetail.notInvoiced}
            {order.historical_reconciled_at ? ` · ${dateTime(order.historical_reconciled_at)}` : ""}
          </p>
          <p>{order.historical_reconciliation_reference}</p>
        </div>
      ) : null}
    </>
  );
}

function OrderItemsPanel({ lines }: { lines: OrderLine[] }) {
  const {
    onSort: sortOrderLines,
    rows: orderLines,
    sort: orderLinesSort,
  } = useSortableRows<OrderLine, OrderLineSortKey>(
    lines,
    { key: "description", direction: "asc" },
    orderLineValue,
  );

  return (
    <section className="dashboard-panel order-detail-panel order-items-panel section-gap">
      <DetailSectionHeader
        description={copy.orderDetail.purchasedItemsHelp}
        icon={<ReceiptText size={22} strokeWidth={1.8} />}
        title={copy.orderDetail.purchasedItems}
      />
      <div className="table-wrap">
        <table className="data-table order-items-table">
          <colgroup>
            <col className="order-items-table__description" />
            <col className="order-items-table__quantity" />
            <col className="order-items-table__amount" />
            <col className="order-items-table__discount" />
          </colgroup>
          <thead>
            <tr>
              <SortableHeader
                label={copy.orderDetail.description}
                onSort={sortOrderLines}
                sort={orderLinesSort}
                sortKey="description"
              />
              <SortableHeader
                className="table-heading--numeric"
                label={copy.orderDetail.quantity}
                onSort={sortOrderLines}
                sort={orderLinesSort}
                sortKey="quantity"
              />
              <SortableHeader
                className="table-heading--numeric"
                label={copy.orderDetail.amount}
                onSort={sortOrderLines}
                sort={orderLinesSort}
                sortKey="gross_amount"
              />
              <SortableHeader
                className="table-heading--numeric"
                label={copy.orderDetail.discount}
                onSort={sortOrderLines}
                sort={orderLinesSort}
                sortKey="discount_amount"
              />
            </tr>
          </thead>
          <tbody>
            {orderLines.map((line) => (
              <tr key={line.id}>
                <td data-label={copy.orderDetail.description} title={line.description}>
                  <span className="table-cell__clamp">{line.description}</span>
                </td>
                <td className="table-cell--numeric" data-label={copy.orderDetail.quantity}>
                  {line.quantity}
                </td>
                <td className="table-cell--numeric" data-label={copy.orderDetail.amount}>
                  {euros(line.gross_amount)}
                </td>
                <td className="table-cell--numeric" data-label={copy.orderDetail.discount}>
                  {euros(line.discount_amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function OrderDetail() {
  const { username, canApprove, csrfToken, order } = useLoaderData<typeof loader>();
  const error = useActionData<typeof action>();
  const sourceSnapshot = order.raw_snapshot_json;
  const sourceCustomer = sourceSnapshot.customer ?? {};
  const sourceAddress = sourceCustomer.billingAddress ?? {};
  const sourceShippingAddress = sourceCustomer.shippingAddress ?? {};
  const sourceName =
    sourceCustomer.displayName ||
    sourceCustomer.companyName ||
    [sourceCustomer.firstName, sourceCustomer.lastName].filter(Boolean).join(" ");
  const sourceAddressText = address(sourceAddress);
  const sourceShippingAddressText = address(sourceShippingAddress);
  const addressText = address(order.billing_address_json);
  const provider = order.provider === "SHOPIFY" ? "Shopify" : "eBay";
  return (
    <AppShell username={username} canApprove={canApprove} csrfToken={csrfToken}>
      <div className="title-block dashboard-title detail-page-title">
        <p className="eyebrow">{provider}</p>
        <h1>{copy.orderDetail.order(order.display_number)}</h1>
        <p>
          {order.customer_name} · {date(order.local_order_date)} · {euros(order.gross_amount)}
        </p>
      </div>
      {error ? (
        <p className="error" role="alert">
          {error.message}
        </p>
      ) : null}
      <div className="order-detail-grid">
        <section className="dashboard-panel order-detail-panel order-status-panel">
          <DetailSectionHeader
            description={copy.orderDetail.orderStatusHelp}
            icon={<PackageCheck size={22} strokeWidth={1.8} />}
            title={copy.orderDetail.orderStatus}
          />
          <dl className="facts order-status-facts">
            <div>
              <dt>{copy.orderDetail.payment}</dt>
              <dd>{paymentStatusLabels[order.payment_status] ?? copy.common.unknownStatus}</dd>
            </div>
            <div>
              <dt>{copy.orderDetail.shipping}</dt>
              <dd>
                {fulfillmentStatusLabels[order.fulfillment_status] ?? copy.common.unknownStatus}
              </dd>
            </div>
            <div>
              <dt>{copy.orderDetail.invoicing}</dt>
              <dd>{orderStatusLabels[order.trigger_status] ?? copy.common.unknownStatus}</dd>
            </div>
            <div>
              <dt>{copy.orderDetail.orderTotal}</dt>
              <dd>{euros(order.gross_amount)}</dd>
            </div>
            <div>
              <dt>{copy.orderDetail.shopifyPaymentsFee}</dt>
              <dd>{euros(order.deducted_shopify_payments_fee_amount)}</dd>
            </div>
            <div>
              <dt>{copy.orderDetail.billableTotal}</dt>
              <dd>{euros(order.billable_amount)}</dd>
            </div>
            <div>
              <dt>{copy.orderDetail.preparation}</dt>
              <dd>
                {order.billing_case_id ? (
                  <Link
                    aria-label={copy.orders.openPreparation(order.case_number!)}
                    to={`/ordini/preparazione/${order.billing_case_id}`}
                  >
                    {order.case_number}
                  </Link>
                ) : (
                  copy.orderDetail.notStarted
                )}
              </dd>
            </div>
          </dl>
          <OrderStatusActions order={order} canApprove={canApprove} csrfToken={csrfToken} />
          <div className="detail-subsection">
            <h3 className="detail-subsection__title">
              <CreditCard aria-hidden="true" size={19} strokeWidth={1.8} />
              {copy.orderDetail.payments}
            </h3>
            {order.payments.length ? (
              <ul className="plain-list">
                {order.payments.map((payment) => (
                  <li key={payment.id}>
                    <span>
                      {payment.method} ·{" "}
                      {paymentStatusLabels[payment.status] ?? copy.common.unknownStatus}
                      {payment.recorded_manually ? ` · ${copy.orderDetail.manuallyRecorded}` : ""}
                    </span>
                    <span>
                      {euros(payment.amount)}
                      {payment.shopify_payments_fee_amount > 0
                        ? ` · commissione Shopify Payments ${euros(payment.shopify_payments_fee_amount)}`
                        : ""}
                      {payment.paid_at ? ` · ${dateTime(payment.paid_at)}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>{copy.orderDetail.noPayments}</p>
            )}
          </div>
          <div className="detail-subsection">
            <h3 className="detail-subsection__title">
              <ReceiptText aria-hidden="true" size={19} strokeWidth={1.8} />
              {copy.orderDetail.refunds}
            </h3>
            {order.refunds.length ? (
              <ul className="plain-list">
                {order.refunds.map((refund) => (
                  <li key={refund.id}>
                    <span>
                      {refund.provider === "SHOPIFY" ? "Shopify" : "eBay"} · profilo{" "}
                      {refund.external_account_id}
                      {` · ordine ${refund.external_order_id} · rimborso ${refund.external_refund_id}`}
                    </span>
                    <span>
                      {refund.amount === null
                        ? copy.orderDetail.refundNeedsReview
                        : euros(refund.amount)}
                      {` · ${refundStatusLabels[refund.status] ?? copy.common.unknownStatus}`}
                      {refund.completed_at ? ` · ${dateTime(refund.completed_at)}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>{copy.orderDetail.noRefunds}</p>
            )}
          </div>
        </section>
        <section className="dashboard-panel order-detail-panel order-customer-panel">
          <DetailSectionHeader
            description={copy.orderDetail.customerDataHelp}
            icon={<UserRound size={22} strokeWidth={1.8} />}
            title={copy.orderDetail.customerData}
          />
          <div className="customer-comparison">
            <div className="customer-comparison__section">
              <h3>{copy.orderDetail.hubCustomerData}</h3>
              <dl className="facts">
                <div>
                  <dt>{copy.orderDetail.customerType}</dt>
                  <dd>{customerKindLabels[order.customer_kind] ?? copy.common.unknownType}</dd>
                </div>
                <div>
                  <dt>{copy.orderDetail.email}</dt>
                  <dd>{order.customer_email ?? copy.common.unavailable}</dd>
                </div>
                <div>
                  <dt>{copy.orderDetail.address}</dt>
                  <dd>{addressText || copy.common.unavailable}</dd>
                </div>
                <div>
                  <dt>{copy.orderDetail.recognizedBy}</dt>
                  <dd>
                    {customerMatchLabels[order.source_confidence] ?? copy.common.unknownStatus}
                  </dd>
                </div>
                <div>
                  <dt>{copy.orderDetail.manualCheck}</dt>
                  <dd>
                    {order.review_required
                      ? copy.orderDetail.required
                      : copy.orderDetail.notRequired}
                  </dd>
                </div>
              </dl>
              <h4>{copy.orderDetail.taxData}</h4>
              {order.taxIdentifiers.length ? (
                <ul>
                  {order.taxIdentifiers.map((identifier) => (
                    <li key={identifier.id}>
                      {taxIdentifierLabels[identifier.type] ?? copy.orderDetail.taxData}
                      {identifier.country_code ? ` (${identifier.country_code})` : ""}:{" "}
                      {identifier.raw_value}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>{copy.common.unavailablePlural}.</p>
              )}
            </div>
            <div className="customer-comparison__section">
              <h3>{copy.orderDetail.receivedCustomerData(provider)}</h3>
              <dl className="facts">
                <div>
                  <dt>{copy.orderDetail.customerType}</dt>
                  <dd>
                    {customerKindLabels[sourceCustomer.kind ?? ""] ?? copy.common.unknownType}
                  </dd>
                </div>
                <div>
                  <dt>{copy.orderDetail.name}</dt>
                  <dd>{sourceName || copy.common.unavailable}</dd>
                </div>
                <div>
                  <dt>{copy.orderDetail.email}</dt>
                  <dd>{sourceCustomer.email || copy.common.unavailable}</dd>
                </div>
                <div>
                  <dt>{copy.orderDetail.certifiedEmail}</dt>
                  <dd>{sourceCustomer.certifiedEmail || copy.common.unavailable}</dd>
                </div>
                <div>
                  <dt>{copy.orderDetail.address}</dt>
                  <dd>{sourceAddressText || copy.common.unavailable}</dd>
                </div>
                <div>
                  <dt>{copy.orderDetail.shippingAddress}</dt>
                  <dd>{sourceShippingAddressText || copy.common.unavailable}</dd>
                </div>
              </dl>
              <h4>{copy.orderDetail.receivedTaxData}</h4>
              {sourceCustomer.taxIdentifiers?.length ? (
                <ul>
                  {sourceCustomer.taxIdentifiers.map((identifier) => (
                    <li key={`${identifier.sourceField ?? "origine"}:${identifier.value ?? ""}`}>
                      {taxIdentifierLabels[identifier.type ?? ""] ?? copy.orderDetail.taxData}:{" "}
                      {identifier.value}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>{copy.common.unavailablePlural}.</p>
              )}
            </div>
          </div>
          {order.possibleMatches.length ? (
            <div className="notice section-gap">
              <strong>{copy.orderDetail.possibleMatchTitle}</strong>
              <p>{copy.orderDetail.possibleMatchHelp}</p>
              <ul>
                {order.possibleMatches.map((candidate) => (
                  <li key={candidate.id}>
                    {candidate.display_name}
                    {candidate.email ? ` · ${candidate.email}` : ""}
                    {candidate.tax_id_normalized
                      ? ` · ${taxIdentifierLabels[candidate.tax_id_type ?? ""] ?? copy.orderDetail.taxIdentifier} ${candidate.tax_id_normalized}`
                      : ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      </div>
      <OrderItemsPanel lines={order.lines} />
    </AppShell>
  );
}
