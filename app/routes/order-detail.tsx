import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/order-detail";

import { actionResult } from "../action";
import { AppShell } from "../components/app-shell";
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
import { assertCsrf, requestId, requireSessionUser } from "../../src/db/auth.server.ts";
import { readForm } from "../../src/http.server.ts";
import { forcePrepareOrder, getOrder } from "../../src/db/orders.server.ts";

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
    const form = await readForm(request);
    assertCsrf(user, form.get("csrf") ?? "");
    const caseId = await forcePrepareOrder(params.orderId, {
      id: user.id,
      requestId: requestId(request),
    });
    if (!caseId) throw new Response("Ordine non trovato", { status: 404 });
    return redirect(`/ordini/preparazione/${caseId}`);
  });
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
      <div className="title-block">
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
      <div className="detail-stack">
        <section className="card">
          <h2>{copy.orderDetail.orderStatus}</h2>
          <dl className="facts facts--columns">
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
          {!order.billing_case_id &&
          !["CANCELLED_NO_DOCUMENT", "REFUNDED_BEFORE_ISSUE"].includes(order.trigger_status) ? (
            <Form method="post" className="section-gap">
              <input type="hidden" name="csrf" value={csrfToken} />
              <button className="button" type="submit">
                {copy.orderDetail.prepareNow}
              </button>
            </Form>
          ) : null}
          <div className="detail-subsection">
            <h3>{copy.orderDetail.payments}</h3>
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
            <h3>{copy.orderDetail.refunds}</h3>
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
        <section className="card">
          <h2>{copy.orderDetail.customerData}</h2>
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
      <section className="card section-gap">
        <h2>{copy.orderDetail.purchasedItems}</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{copy.orderDetail.description}</th>
                <th>{copy.orderDetail.quantity}</th>
                <th>{copy.orderDetail.amount}</th>
                <th>{copy.orderDetail.discount}</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((line) => (
                <tr key={line.id}>
                  <td data-label={copy.orderDetail.description}>{line.description}</td>
                  <td data-label={copy.orderDetail.quantity}>{line.quantity}</td>
                  <td data-label={copy.orderDetail.amount}>{euros(line.gross_amount)}</td>
                  <td data-label={copy.orderDetail.discount}>{euros(line.discount_amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  );
}
