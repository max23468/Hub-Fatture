import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/home";

import { AppShell } from "../components/app-shell";
import { copy } from "../copy.it";
import { requireSessionUser } from "../../src/db/auth.server.ts";
import { dashboardSummary } from "../../src/db/orders.server.ts";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const summary = await dashboardSummary();
  return {
    username: user.username,
    canApprove: user.canApprove,
    csrfToken: user.csrfToken,
    summary,
  };
}

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Hub Fatture" },
    { name: "description", content: "Gestione privata del flusso di fatturazione" },
  ];
}

export default function Home() {
  const { username, canApprove, csrfToken, summary } = useLoaderData<typeof loader>();
  const cards = [
    [summary.orders, copy.dashboard.importedOrders, "/ordini"],
    [summary.ready_cases, copy.dashboard.readyPreparations, "/ordini?vista=fatturare"],
    [summary.review_cases, copy.dashboard.reviews, "/ordini?vista=verificare"],
    [summary.waiting_orders, copy.dashboard.waitingOrders, "/ordini?vista=attesa"],
    [summary.pending_payments, copy.dashboard.pendingPayments, "/ordini?pagamento=PENDING"],
  ] as const;
  return (
    <AppShell username={username} canApprove={canApprove} csrfToken={csrfToken}>
      <div className="title-block">
        <p className="eyebrow">{copy.dashboard.eyebrow}</p>
        <h1>{copy.dashboard.title}</h1>
      </div>
      <section className="summary-grid" aria-label={copy.dashboard.summaryLabel}>
        {cards.map(([value, label, to]) => (
          <Link className="summary-card" key={label} to={to}>
            <strong>{value}</strong>
            <span>{label}</span>
          </Link>
        ))}
      </section>
    </AppShell>
  );
}
