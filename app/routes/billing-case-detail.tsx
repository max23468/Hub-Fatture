import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/billing-case-detail";

import { actionResult } from "../action";
import { AppShell } from "../components/app-shell";
import { CustomerEditor } from "../components/customer-editor";
import {
  anomalyLabels,
  auditActionLabels,
  billingCaseStatusLabels,
  paymentStatusLabels,
} from "../copy.it";
import { date, dateTime, euros } from "../format";
import { assertCsrf, requestId, requireSessionUser } from "../../src/db/auth.server.ts";
import { readForm } from "../../src/http.server.ts";
import {
  addOrderToBillingCase,
  correctBillingCaseCustomer,
  getBillingCase,
  separateOrderFromBillingCase,
  updateBillingCaseTransmission,
} from "../../src/db/orders.server.ts";

interface Actor {
  id: number;
  requestId: string;
}

function runIntent(
  intent: string | null,
  caseId: string,
  form: URLSearchParams,
  revision: string | null,
  actor: Actor,
) {
  if (intent === "do-not-transmit") {
    return updateBillingCaseTransmission(caseId, form.get("reason") ?? "", revision, actor);
  }
  if (intent === "reactivate") {
    return updateBillingCaseTransmission(caseId, null, revision, actor);
  }
  if (intent === "separate-order") {
    return separateOrderFromBillingCase(caseId, form.get("orderId") ?? "", revision, actor);
  }
  if (intent === "add-order") {
    return addOrderToBillingCase(caseId, form.get("orderId") ?? "", revision, actor);
  }
  if (intent !== "correct-customer") return Promise.resolve("unknown" as const);
  const types = form.getAll("taxType");
  const countries = form.getAll("taxCountryCode");
  return correctBillingCaseCustomer(
    caseId,
    {
      kind: form.get("kind"),
      displayName: form.get("displayName"),
      firstName: form.get("firstName"),
      lastName: form.get("lastName"),
      companyName: form.get("companyName"),
      email: form.get("email"),
      phone: form.get("phone"),
      billingAddress: {
        line1: form.get("line1"),
        line2: form.get("line2"),
        postalCode: form.get("postalCode"),
        city: form.get("city"),
        province: form.get("province"),
        countryCode: form.get("countryCode"),
      },
      // Un valore vuoto rimuove la riga; tutte le altre sopravvivono alla correzione.
      taxIdentifiers: form.getAll("taxValue").flatMap((value, index) =>
        value.trim()
          ? [
              {
                type: types[index],
                value: value.trim(),
                countryCode: countries[index],
                sourceField: "correzione-manuale",
              },
            ]
          : [],
      ),
    },
    revision,
    form.get("reason"),
    actor,
  );
}

const reactivationBlockerMessages: Record<string, string> = {
  EMPTY:
    "Questa preparazione storica non contiene più ordini e resta consultabile soltanto in archivio.",
  INCOMPATIBLE_ORDERS:
    "Gli ordini sono ancora annullati o rimborsati. La preparazione resta in archivio finché la sorgente non viene rettificata.",
  OTHER_OPEN_CASE:
    "Esiste già un’altra preparazione aperta per lo stesso cliente e giorno. Questa resta in archivio.",
};

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const billingCase = await getBillingCase(params.caseId);
  if (!billingCase) throw new Response("Preparazione non trovata", { status: 404 });
  return { username: user.username, csrfToken: user.csrfToken, billingCase };
}

export async function action({ request, params }: Route.ActionArgs) {
  return actionResult(async () => {
    const user = await requireSessionUser(request);
    const form = await readForm(request);
    assertCsrf(user, form.get("csrf") ?? "");
    const outcome = await runIntent(form.get("intent"), params.caseId, form, form.get("revision"), {
      id: user.id,
      requestId: requestId(request),
    });
    if (outcome === "unknown") throw new Response("Azione non riconosciuta", { status: 400 });
    if (outcome === null) throw new Response("Preparazione non trovata", { status: 404 });
    return redirect(`/ordini/preparazione/${params.caseId}`);
  });
}

export default function BillingCaseDetail() {
  const { username, csrfToken, billingCase } = useLoaderData<typeof loader>();
  const error = useActionData<typeof action>();
  const total = billingCase.orders.reduce((sum, order) => sum + order.gross_amount, 0);
  const editable = ["DRAFT", "READY", "NEEDS_REVIEW"].includes(billingCase.status);
  const revisionField = <input type="hidden" name="revision" value={billingCase.revision} />;
  const csrfField = <input type="hidden" name="csrf" value={csrfToken} />;
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
      {billingCase.status === "DO_NOT_TRANSMIT" ? (
        <p className="warning" role="status">
          {billingCase.do_not_transmit_reason ?? "Questa preparazione non deve essere trasmessa."}
        </p>
      ) : null}
      {billingCase.anomalies.length ? (
        <section className="card section-gap" aria-labelledby="anomalie">
          <h2 id="anomalie">Anomalie da risolvere</h2>
          <ul className="plain-list">
            {billingCase.anomalies.map((code) => (
              <li key={code}>
                <strong>{anomalyLabels[code]?.title ?? "Verifica richiesta"}</strong>
                <span>
                  {anomalyLabels[code]?.action ??
                    "Controlla i dati della preparazione prima di proseguire."}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="detail-grid">
        <section className="card">
          <h2>Ordini inclusi</h2>
          <ul className="plain-list">
            {billingCase.orders.map((order) => (
              <li key={order.id}>
                <Link to={`/ordini/${order.id}`}>
                  {order.provider === "SHOPIFY" ? "Shopify" : "eBay"} {order.display_number}
                </Link>
                <span>
                  {paymentStatusLabels[order.payment_status] ?? "Pagamento da verificare"} ·{" "}
                  {euros(order.gross_amount)}
                </span>
                {editable && billingCase.orders.length > 1 ? (
                  <Form method="post">
                    {csrfField}
                    {revisionField}
                    <input type="hidden" name="intent" value="separate-order" />
                    <input type="hidden" name="orderId" value={order.id} />
                    <button className="button button--secondary" type="submit">
                      Separa dalla preparazione
                    </button>
                  </Form>
                ) : null}
              </li>
            ))}
          </ul>
          {editable && billingCase.addableOrders.length ? (
            <Form method="post" className="inline-form section-gap">
              {csrfField}
              {revisionField}
              <input type="hidden" name="intent" value="add-order" />
              <label>
                Aggiungi un ordine compatibile
                <select name="orderId">
                  {billingCase.addableOrders.map((order) => (
                    <option key={order.id} value={order.id}>
                      {order.provider === "SHOPIFY" ? "Shopify" : "eBay"} {order.display_number} ·{" "}
                      {euros(order.gross_amount)}
                    </option>
                  ))}
                </select>
              </label>
              <button className="button button--secondary" type="submit">
                Aggiungi
              </button>
            </Form>
          ) : null}
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
            <div>
              <dt>Anagrafica</dt>
              <dd>
                {billingCase.customer_corrected_at
                  ? `Corretta il ${dateTime(billingCase.customer_corrected_at)}`
                  : "Come importata dalla sorgente"}
              </dd>
            </div>
          </dl>
          {billingCase.status === "DO_NOT_TRANSMIT" && !billingCase.reactivation_blocker ? (
            <Form method="post" className="section-gap">
              {csrfField}
              {revisionField}
              <input type="hidden" name="intent" value="reactivate" />
              <button className="button button--secondary" type="submit">
                Riattiva preparazione
              </button>
            </Form>
          ) : billingCase.status === "DO_NOT_TRANSMIT" ? (
            <p className="notice section-gap">
              {reactivationBlockerMessages[billingCase.reactivation_blocker ?? ""] ??
                "Questa preparazione resta consultabile in archivio e non può essere riattivata."}
            </p>
          ) : editable ? (
            <Form method="post" className="section-gap">
              {csrfField}
              {revisionField}
              <input type="hidden" name="intent" value="do-not-transmit" />
              <label>
                Motivo
                <input
                  aria-describedby={error ? "case-error" : undefined}
                  aria-invalid={error ? true : undefined}
                  maxLength={500}
                  name="reason"
                  required
                />
              </label>
              {error ? (
                <p className="error" id="case-error">
                  {error.message}
                </p>
              ) : null}
              <button className="button button--secondary" type="submit">
                Non trasmettere
              </button>
            </Form>
          ) : null}
        </section>
      </div>

      {editable ? (
        <CustomerEditor
          csrfToken={csrfToken}
          customer={billingCase.customer_snapshot_json}
          revision={billingCase.revision}
        />
      ) : null}
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
            {billingCase.audit.map((event) => (
              <li key={event.id}>
                <strong>{auditActionLabels[event.action] ?? "Attività registrata"}</strong>
                <span>{dateTime(event.created_at)}</span>
                {event.reason ? <span>{event.reason}</span> : null}
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
