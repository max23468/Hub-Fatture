import { data, Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/order-detail";

import { AppShell } from "../components/app-shell";
import {
  customerKindLabels,
  customerMatchLabels,
  fulfillmentStatusLabels,
  orderStatusLabels,
  paymentStatusLabels,
  taxIdentifierLabels,
} from "../copy.it";
import { date, dateTime, euros } from "../format";
import { assertCsrf, requestId, requireSessionUser } from "../../src/auth.server.ts";
import { publicError } from "../../src/errors.ts";
import { readForm } from "../../src/http.server.ts";
import { forcePrepareOrder, getOrder } from "../../src/orders.server.ts";

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const order = await getOrder(params.orderId);
  if (!order) throw new Response("Ordine non trovato", { status: 404 });
  return { username: user.username, csrfToken: user.csrfToken, order };
}

export async function action({ request, params }: Route.ActionArgs) {
  try {
    const user = await requireSessionUser(request);
    const form = await readForm(request);
    assertCsrf(user, form.get("csrf") ?? "");
    const caseId = await forcePrepareOrder(params.orderId, {
      id: user.id,
      requestId: requestId(request),
    });
    if (!caseId) {
      return data(
        { code: "UNKNOWN", message: "Ordine non trovato.", status: 404 },
        { status: 404 },
      );
    }
    return redirect(`/ordini/preparazione/${caseId}`);
  } catch (error) {
    const result = publicError(error);
    return data(result, { status: result.status });
  }
}

export default function OrderDetail() {
  const { username, csrfToken, order } = useLoaderData<typeof loader>();
  const error = useActionData<typeof action>();
  const sourceSnapshot = order.raw_snapshot_json as {
    customer?: {
      kind?: string;
      displayName?: string;
      firstName?: string;
      lastName?: string;
      companyName?: string;
      email?: string;
      billingAddress?: Record<string, string | undefined>;
      taxIdentifiers?: Array<{ type?: string; value?: string; sourceField?: string }>;
    };
  };
  const sourceCustomer = sourceSnapshot.customer ?? {};
  const sourceAddress = sourceCustomer.billingAddress ?? {};
  const sourceName =
    sourceCustomer.displayName ||
    sourceCustomer.companyName ||
    [sourceCustomer.firstName, sourceCustomer.lastName].filter(Boolean).join(" ");
  const sourceAddressText = [
    sourceAddress.line1,
    sourceAddress.line2,
    [sourceAddress.postalCode, sourceAddress.city].filter(Boolean).join(" "),
    sourceAddress.province,
    sourceAddress.countryCode,
  ]
    .filter(Boolean)
    .join(", ");
  const address = order.billing_address_json as Record<string, string | undefined>;
  const addressText = [
    address.line1,
    address.line2,
    [address.postalCode, address.city].filter(Boolean).join(" "),
    address.province,
    address.countryCode,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <AppShell username={username} csrfToken={csrfToken}>
      <div className="title-block">
        <p className="eyebrow">{order.provider === "SHOPIFY" ? "Shopify" : "eBay"}</p>
        <h1>Ordine {order.display_number}</h1>
        <p>
          {order.customer_name} · {date(order.local_order_date)} · {euros(order.gross_amount)}
        </p>
      </div>
      {error ? (
        <p className="error" role="alert">
          {error.message}
        </p>
      ) : null}
      <div className="detail-grid">
        <section className="card">
          <h2>Stato sorgente</h2>
          <dl className="facts">
            <div>
              <dt>Pagamento</dt>
              <dd>{paymentStatusLabels[order.payment_status] ?? "Stato non riconosciuto"}</dd>
            </div>
            <div>
              <dt>Evasione</dt>
              <dd>
                {fulfillmentStatusLabels[order.fulfillment_status] ?? "Stato non riconosciuto"}
              </dd>
            </div>
            <div>
              <dt>Trigger</dt>
              <dd>{orderStatusLabels[order.trigger_status] ?? "Stato non riconosciuto"}</dd>
            </div>
            <div>
              <dt>Preparazione fattura</dt>
              <dd>
                {order.billing_case_id ? (
                  <Link to={`/ordini/preparazione/${order.billing_case_id}`}>
                    {order.case_number}
                  </Link>
                ) : (
                  "Non avviata"
                )}
              </dd>
            </div>
          </dl>
          {!order.billing_case_id &&
          !["CANCELLED_NO_DOCUMENT", "REFUNDED_BEFORE_ISSUE"].includes(order.trigger_status) ? (
            <Form method="post" className="section-gap">
              <input type="hidden" name="csrf" value={csrfToken} />
              <button className="button" type="submit">
                Prepara ora
              </button>
            </Form>
          ) : null}
        </section>
        <section className="card">
          <h2>Cliente normalizzato</h2>
          <dl className="facts">
            <div>
              <dt>Tipo</dt>
              <dd>{customerKindLabels[order.customer_kind] ?? "Tipo non riconosciuto"}</dd>
            </div>
            <div>
              <dt>E-mail</dt>
              <dd>{order.customer_email ?? "Non disponibile"}</dd>
            </div>
            <div>
              <dt>Indirizzo</dt>
              <dd>{addressText || "Non disponibile"}</dd>
            </div>
            <div>
              <dt>Corrispondenza</dt>
              <dd>
                {customerMatchLabels[order.source_confidence] ?? "Corrispondenza non riconosciuta"}
              </dd>
            </div>
            <div>
              <dt>Verifica</dt>
              <dd>{order.review_required ? "Richiesta" : "Non richiesta"}</dd>
            </div>
          </dl>
          <h3>Identificativi fiscali</h3>
          {order.taxIdentifiers.length ? (
            <ul>
              {order.taxIdentifiers.map((identifier: Record<string, unknown>) => (
                <li key={String(identifier.id)}>
                  {taxIdentifierLabels[String(identifier.type)] ?? "Identificativo"}
                  {identifier.country_code ? ` (${String(identifier.country_code)})` : ""}:{" "}
                  {String(identifier.raw_value)}
                </li>
              ))}
            </ul>
          ) : (
            <p>Non disponibili.</p>
          )}
        </section>
        <section className="card">
          <h2>Cliente dalla sorgente</h2>
          <dl className="facts">
            <div>
              <dt>Tipo</dt>
              <dd>{customerKindLabels[sourceCustomer.kind ?? ""] ?? "Tipo non riconosciuto"}</dd>
            </div>
            <div>
              <dt>Nome</dt>
              <dd>{sourceName || "Non disponibile"}</dd>
            </div>
            <div>
              <dt>E-mail</dt>
              <dd>{sourceCustomer.email || "Non disponibile"}</dd>
            </div>
            <div>
              <dt>Indirizzo</dt>
              <dd>{sourceAddressText || "Non disponibile"}</dd>
            </div>
          </dl>
          <h3>Identificativi fiscali originali</h3>
          {sourceCustomer.taxIdentifiers?.length ? (
            <ul>
              {sourceCustomer.taxIdentifiers.map((identifier) => (
                <li key={`${identifier.sourceField ?? "sorgente"}:${identifier.value ?? ""}`}>
                  {taxIdentifierLabels[identifier.type ?? ""] ?? "Identificativo"}:{" "}
                  {identifier.value}
                </li>
              ))}
            </ul>
          ) : (
            <p>Non disponibili.</p>
          )}
        </section>
        <section className="card">
          <h2>Pagamenti</h2>
          {order.payments.length ? (
            <ul className="plain-list">
              {order.payments.map((payment: Record<string, unknown>) => (
                <li key={String(payment.id)}>
                  <span>
                    {String(payment.method)} ·{" "}
                    {paymentStatusLabels[String(payment.status)] ?? "Stato non riconosciuto"}
                    {payment.recorded_manually ? " · registrato manualmente" : ""}
                  </span>
                  <span>
                    {euros(String(payment.amount))}
                    {payment.paid_at ? ` · ${dateTime(String(payment.paid_at))}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p>Nessun pagamento registrato.</p>
          )}
        </section>
      </div>
      <section className="card section-gap">
        <h2>Righe sorgente</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Descrizione</th>
                <th>Quantità</th>
                <th>Importo</th>
                <th>Sconto</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((line: Record<string, unknown>) => (
                <tr key={String(line.id)}>
                  <td data-label="Descrizione">{String(line.description)}</td>
                  <td data-label="Quantità">{String(line.quantity)}</td>
                  <td data-label="Importo">{euros(String(line.gross_amount))}</td>
                  <td data-label="Sconto">{euros(String(line.discount_amount))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  );
}
