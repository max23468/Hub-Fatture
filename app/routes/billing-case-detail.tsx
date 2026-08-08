import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/billing-case-detail";

import { AppShell } from "../components/app-shell";
import { auditActionLabels } from "../copy.it";
import { date, dateTime, euros } from "../format";
import { requireSessionUser } from "../../src/auth.server.ts";
import { getBillingCase } from "../../src/orders.server.ts";

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const billingCase = await getBillingCase(params.caseId);
  if (!billingCase) throw new Response("Preparazione non trovata", { status: 404 });
  return { username: user.username, csrfToken: user.csrfToken, billingCase };
}

export default function BillingCaseDetail() {
  const { username, csrfToken, billingCase } = useLoaderData<typeof loader>();
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
      {billingCase.status === "NEEDS_REVIEW" ? (
        <p className="warning" role="status">
          Dati incompleti o modificati richiedono una verifica prima di proseguire.
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
                <span>{euros(String(order.gross_amount))}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="card">
          <h2>Stato</h2>
          <dl className="facts">
            <div>
              <dt>Stato corrente</dt>
              <dd>{billingCase.status === "NEEDS_REVIEW" ? "Da verificare" : "Pronta"}</dd>
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
        </section>
      </div>
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
