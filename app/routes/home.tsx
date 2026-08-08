import { useLoaderData } from "react-router";
import type { Route } from "./+types/home";

import { AppShell } from "../components/app-shell";
import { copy } from "../copy.it";
import { requireSessionUser } from "../../src/auth.server.ts";
import { dashboardSummary } from "../../src/orders.server.ts";

export async function loader({ request }: Route.LoaderArgs) {
  const [user, summary] = await Promise.all([requireSessionUser(request), dashboardSummary()]);
  return { username: user.username, csrfToken: user.csrfToken, summary };
}

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Hub Fatture" },
    { name: "description", content: "Gestione privata del flusso di fatturazione" },
  ];
}

export default function Home() {
  const { username, csrfToken, summary } = useLoaderData<typeof loader>();
  return (
    <AppShell username={username} csrfToken={csrfToken}>
      <div className="title-block">
        <p className="eyebrow">Situazione operativa</p>
        <h1>{copy.dashboardTitle}</h1>
      </div>
      <section className="summary-grid" aria-label="Riepilogo ordini e fatturazione">
        <article className="summary-card">
          <strong>{summary.orders}</strong>
          <span>Ordini importati</span>
        </article>
        <article className="summary-card">
          <strong>{summary.ready_cases}</strong>
          <span>Pronte da approvare</span>
        </article>
        <article className="summary-card">
          <strong>{summary.review_cases}</strong>
          <span>Da verificare</span>
        </article>
        <article className="summary-card">
          <strong>{summary.waiting_orders}</strong>
          <span>In attesa del trigger</span>
        </article>
        <article className="summary-card">
          <strong>{summary.pending_payments}</strong>
          <span>Pagamenti pendenti</span>
        </article>
      </section>
    </AppShell>
  );
}
