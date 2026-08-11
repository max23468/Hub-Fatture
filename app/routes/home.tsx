import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/home";

import { AppShell } from "../components/app-shell";
import { copy } from "../copy.it";
import { dateTime } from "../format";
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
    [summary.ready_cases, copy.dashboard.readyPreparations, "/ordini?vista=fatturare"],
    [summary.review_cases, copy.dashboard.reviews, "/ordini?vista=verificare"],
    [summary.pending_payments, copy.dashboard.pendingPayments, "/ordini?pagamento=PENDING"],
    [summary.credit_notes_to_approve, copy.dashboard.creditNotesToApprove, "/attivita"],
    [summary.failed_uploads, copy.dashboard.failedUploads, "/documenti"],
    [summary.rejected_by_sdi, copy.dashboard.rejectedBySdi, "/documenti"],
    [summary.sync_errors, copy.dashboard.syncErrors, "/attivita"],
    [
      summary.last_shopify_sync ? dateTime(summary.last_shopify_sync) : copy.settings.never,
      copy.dashboard.lastShopifySync,
      "/impostazioni#connessioni",
      true,
    ],
    [
      summary.last_ebay_sync ? dateTime(summary.last_ebay_sync) : copy.settings.never,
      copy.dashboard.lastEbaySync,
      "/impostazioni#connessioni",
      true,
    ],
    [
      summary.last_aruba_readback ? dateTime(summary.last_aruba_readback) : copy.settings.never,
      copy.dashboard.lastArubaReadback,
      "/impostazioni#aruba-helper",
      true,
    ],
    [summary.documents_today, copy.dashboard.documentsToday, "/documenti"],
    [summary.documents_this_month, copy.dashboard.documentsThisMonth, "/documenti"],
  ] as const;
  return (
    <AppShell username={username} canApprove={canApprove} csrfToken={csrfToken}>
      <div className="title-block">
        <p className="eyebrow">{copy.dashboard.eyebrow}</p>
        <h1>{copy.dashboard.title}</h1>
      </div>
      <section className="summary-grid" aria-label={copy.dashboard.summaryLabel}>
        {cards.map(([value, label, to, compact]) => (
          <Link className="summary-card" key={label} to={to}>
            <strong className={compact ? "summary-card__value--compact" : undefined}>
              {value}
            </strong>
            <span>{label}</span>
          </Link>
        ))}
      </section>
    </AppShell>
  );
}
