import { data, Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/billing-case-detail";

import { AppShell } from "../components/app-shell";
import { auditActionLabels, billingCaseStatusLabels, paymentStatusLabels } from "../copy.it";
import { date, dateTime, euros } from "../format";
import { assertCsrf, requestId, requireSessionUser } from "../../src/auth.server.ts";
import { publicError } from "../../src/errors.ts";
import { readForm } from "../../src/http.server.ts";
import { getBillingCase, updateBillingCaseTransmission } from "../../src/orders.server.ts";

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const billingCase = await getBillingCase(params.caseId);
  if (!billingCase) throw new Response("Preparazione non trovata", { status: 404 });
  return { username: user.username, csrfToken: user.csrfToken, billingCase };
}

export async function action({ request, params }: Route.ActionArgs) {
  try {
    const user = await requireSessionUser(request);
    const form = await readForm(request);
    assertCsrf(user, form.get("csrf") ?? "");
    const intent = form.get("intent");
    if (intent !== "do-not-transmit" && intent !== "reactivate") {
      return data(
        { code: "UNKNOWN", message: "Azione non riconosciuta.", status: 400 },
        { status: 400 },
      );
    }
    const status = await updateBillingCaseTransmission(
      params.caseId,
      intent === "reactivate" ? null : (form.get("reason") ?? ""),
      { id: user.id, requestId: requestId(request) },
    );
    if (!status) {
      return data(
        { code: "UNKNOWN", message: "Preparazione non trovata.", status: 404 },
        { status: 404 },
      );
    }
    return redirect(`/ordini/preparazione/${params.caseId}`);
  } catch (error) {
    const result = publicError(error);
    return data(result, { status: result.status });
  }
}

export default function BillingCaseDetail() {
  const { username, csrfToken, billingCase } = useLoaderData<typeof loader>();
  const error = useActionData<typeof action>();
  const total = billingCase.orders.reduce(
    (sum: number, order: Record<string, unknown>) => sum + Number(order.gross_amount),
    0,
  );
  return (
    <AppShell username={username} csrfToken={csrfToken}>
      <div className="title-block">
        <p className="eyebrow">Da fatturare</p>
        <h1>Preparazione fattura {billingCase.public_number}</h1>
        <p>
          {billingCase.customer_name} · {date(billingCase.local_order_date)} · {euros(total)}
        </p>
      </div>
      {error ? (
        <p className="error" role="alert">
          {error.message}
        </p>
      ) : null}
      {billingCase.status === "NEEDS_REVIEW" ? (
        <p className="warning" role="status">
          Dati incompleti o modificati richiedono una verifica prima di proseguire.
        </p>
      ) : null}
      {billingCase.status === "DO_NOT_TRANSMIT" ? (
        <p className="warning" role="status">
          {billingCase.do_not_transmit_reason ?? "Questa preparazione non deve essere trasmessa."}
        </p>
      ) : null}
      <div className="detail-grid">
        <section className="card">
          <h2>Ordini inclusi</h2>
          <ul className="plain-list">
            {billingCase.orders.map((order: Record<string, unknown>) => (
              <li key={String(order.id)}>
                <Link to={`/ordini/${String(order.id)}`}>
                  {String(order.provider) === "SHOPIFY" ? "Shopify" : "eBay"}{" "}
                  {String(order.display_number)}
                </Link>
                <span>
                  {paymentStatusLabels[String(order.payment_status)] ?? "Pagamento da verificare"} ·{" "}
                  {euros(String(order.gross_amount))}
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section className="card">
          <h2>Stato</h2>
          <dl className="facts">
            <div>
              <dt>Stato corrente</dt>
              <dd>{billingCaseStatusLabels[billingCase.status] ?? "Stato non riconosciuto"}</dd>
            </div>
            <div>
              <dt>Valuta</dt>
              <dd>{billingCase.currency}</dd>
            </div>
            <div>
              <dt>Ordini</dt>
              <dd>{billingCase.orders.length}</dd>
            </div>
          </dl>
          {billingCase.status === "DO_NOT_TRANSMIT" ? (
            <Form method="post" className="section-gap">
              <input type="hidden" name="csrf" value={csrfToken} />
              <input type="hidden" name="intent" value="reactivate" />
              <button className="button button--secondary" type="submit">
                Riattiva preparazione
              </button>
            </Form>
          ) : ["DRAFT", "READY", "NEEDS_REVIEW"].includes(billingCase.status) ? (
            <Form method="post" className="section-gap">
              <input type="hidden" name="csrf" value={csrfToken} />
              <input type="hidden" name="intent" value="do-not-transmit" />
              <label>
                Motivo
                <input name="reason" required maxLength={500} />
              </label>
              <button className="button button--secondary" type="submit">
                Non trasmettere
              </button>
            </Form>
          ) : null}
        </section>
      </div>
      {billingCase.revisions.length ? (
        <section className="card section-gap">
          <h2>Modifiche dalla sorgente</h2>
          <p>Le versioni precedenti sono conservate per consentire la verifica.</p>
          <ol className="timeline">
            {billingCase.revisions.map(
              (revision: {
                id: string;
                display_number: string;
                created_at: string;
                changedFields: string[];
              }) => (
                <li key={revision.id}>
                  <strong>Ordine {revision.display_number}</strong>
                  <span>
                    {dateTime(revision.created_at)} · Campi modificati:{" "}
                    {revision.changedFields.join(", ")}
                  </span>
                </li>
              ),
            )}
          </ol>
        </section>
      ) : null}
      <section className="card section-gap">
        <h2>Registro attività</h2>
        {billingCase.audit.length ? (
          <ol className="timeline">
            {billingCase.audit.map((event: Record<string, unknown>) => (
              <li key={String(event.id)}>
                <strong>{auditActionLabels[String(event.action)] ?? "Attività registrata"}</strong>
                <span>{dateTime(String(event.created_at))}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p>Nessuna attività registrata.</p>
        )}
      </section>
    </AppShell>
  );
}
