import {
  ArrowRight,
  BadgeEuro,
  CircleAlert,
  CircleCheck,
  ClipboardCheck,
  CreditCard,
  RefreshCw,
} from "lucide-react";
import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/home";

import { AppShell } from "../components/app-shell";
import {
  createDashboardConnections,
  DashboardConnections,
} from "../components/dashboard-connections";
import { copy } from "../copy.it";
import { privateRouteMeta } from "../metadata";
import { requireSessionUser } from "../../src/db/auth.server.ts";
import { getArubaApiConnectionStatus } from "../../src/db/aruba-api-settings.server.ts";
import { getArubaInventoryHealth } from "../../src/db/aruba-inventory-health.server.ts";
import { getArubaMonthlyTransmissionUsage } from "../../src/db/aruba-api-outbound.server.ts";
import { dashboardSummary } from "../../src/db/order-queries.server.ts";

const chartDateFormatter = new Intl.DateTimeFormat("it-IT", {
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
  timeZone: "Europe/Rome",
});

function chartDate(value: string) {
  return chartDateFormatter.format(new Date(`${value}T12:00:00Z`));
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const [summary, arubaConnection, arubaInventory, arubaMonthlyUsage] = await Promise.all([
    dashboardSummary(),
    getArubaApiConnectionStatus(),
    getArubaInventoryHealth(),
    getArubaMonthlyTransmissionUsage(),
  ]);
  return {
    username: user.username,
    canApprove: user.canApprove,
    csrfToken: user.csrfToken,
    currentTime: new Date().toISOString(),
    summary,
    arubaConnection,
    arubaInventory,
    arubaMonthlyUsage,
  };
}

export function meta({ error }: Route.MetaArgs) {
  return privateRouteMeta("dashboard", { error });
}

export default function Home() {
  const {
    username,
    canApprove,
    csrfToken,
    currentTime,
    summary,
    arubaConnection,
    arubaInventory,
    arubaMonthlyUsage,
  } = useLoaderData<typeof loader>();
  const workItems = [
    {
      value: arubaInventory.blocking ? 0 : Number(summary.ready_cases),
      label: copy.dashboard.readyPreparations,
      detail: copy.dashboard.readyDetail,
      to: "/ordini?vista=fatturare",
      action: copy.dashboard.openPreparations,
      icon: ClipboardCheck,
      tone: "success",
      primary: true,
    },
    {
      value: Number(summary.review_cases),
      label: copy.dashboard.reviews,
      detail: copy.dashboard.reviewDetail,
      to: "/ordini?vista=verificare",
      action: copy.dashboard.openOrders,
      icon: CircleAlert,
      tone: "warning",
      primary: false,
    },
    {
      value: Number(summary.pending_payments),
      label: copy.dashboard.pendingPayments,
      detail: copy.dashboard.pendingDetail,
      to: "/ordini?pagamento=PENDING",
      action: copy.dashboard.openOrders,
      icon: CreditCard,
      tone: "accent",
      primary: false,
    },
    {
      value: Number(summary.credit_notes_to_approve),
      label: copy.dashboard.creditNotesToApprove,
      detail: copy.dashboard.creditNoteDetail,
      to: "/attivita?tipo=note-credito",
      action: copy.dashboard.openActivity,
      icon: BadgeEuro,
      tone: "accent",
      primary: false,
    },
  ] as const;

  const incidents = [
    {
      value: Number(summary.failed_uploads),
      emptyLabel: copy.dashboard.noFailedUploads,
      countLabel: copy.dashboard.failedUploadsCount,
      to: "/documenti",
    },
    {
      value: Number(summary.rejected_by_sdi),
      emptyLabel: copy.dashboard.noRejectedDocuments,
      countLabel: copy.dashboard.rejectedDocumentsCount,
      to: "/documenti",
    },
    {
      value: Number(summary.sync_errors),
      emptyLabel: copy.dashboard.noSyncErrors,
      countLabel: copy.dashboard.syncErrorsCount,
      to: "/attivita",
    },
    {
      value: arubaInventory.potentialMatches + arubaInventory.ambiguous + arubaInventory.conflicts,
      emptyLabel: copy.dashboard.noArubaConflicts,
      countLabel: copy.dashboard.arubaConflictsCount,
      to: "/attivita",
    },
  ];

  const connections = createDashboardConnections({
    currentTime,
    shopify: {
      connected: summary.shopify_connection_status === "CONNECTED",
      lastSync: summary.last_shopify_sync,
    },
    ebay: {
      connected: summary.ebay_connection_status === "CONNECTED",
      lastSync: summary.last_ebay_sync,
    },
    aruba: {
      configured: arubaConnection.configured,
      connectionStatus: arubaConnection.status,
      apiPaused: arubaConnection.apiPaused,
      inboundEnabled: arubaConnection.inboundEnabled,
      activeSync: arubaInventory.activeSession,
      lastCompletedAt: arubaInventory.lastCompletedAt,
      syncFailed: arubaInventory.blockingReason === "FAILURE",
    },
  });

  const incidentCount = incidents.reduce((total, incident) => total + incident.value, 0);
  const hasMissingUpdates =
    Number(summary.aruba_batches_requiring_attention) > 0 ||
    connections.some((connection) => connection.blocking || connection.stale);
  const status = incidentCount
    ? {
        label: copy.dashboard.attentionNeeded,
        detail: copy.dashboard.attentionNeededDetail,
        tone: "warning",
        icon: CircleAlert,
      }
    : hasMissingUpdates
      ? {
          label: copy.dashboard.updatesMissing,
          detail: copy.dashboard.updatesMissingDetail,
          tone: "accent",
          icon: RefreshCw,
        }
      : {
          label: copy.dashboard.allUnderControl,
          detail: copy.dashboard.noCurrentIssues,
          tone: "success",
          icon: CircleCheck,
        };
  const StatusIcon = status.icon;
  const maxDocuments = Math.max(1, ...summary.documents_last_seven_days.map((day) => day.count));

  return (
    <AppShell username={username} canApprove={canApprove} csrfToken={csrfToken}>
      <div className="title-block dashboard-title">
        <p className="eyebrow">{copy.dashboard.eyebrow}</p>
        <h1>{copy.dashboard.title}</h1>
      </div>

      {arubaMonthlyUsage.warning ? (
        <p className="warning" role="status">
          {copy.dashboard.arubaMonthlyWarning(
            arubaMonthlyUsage.warning,
            arubaMonthlyUsage.accepted,
            arubaMonthlyUsage.remaining,
          )}
        </p>
      ) : null}

      <div className="dashboard-grid">
        <section className="dashboard-panel work-panel" aria-labelledby="dashboard-work-title">
          <h2 id="dashboard-work-title">{copy.dashboard.workNow}</h2>
          <div className="work-list">
            {workItems.map(({ value, label, detail, to, action, icon: Icon, tone, primary }) => (
              <div className="work-item" key={label}>
                <span className={`dashboard-icon dashboard-icon--${tone}`} aria-hidden="true">
                  <Icon size={24} strokeWidth={1.8} />
                </span>
                <strong className={`work-item__value work-item__value--${tone}`}>{value}</strong>
                <span className="work-item__copy">
                  <strong>{label}</strong>
                  <span>{detail}</span>
                </span>
                <Link className={primary ? "button" : "dashboard-row-link"} to={to}>
                  <span>{action}</span>
                  <ArrowRight aria-hidden="true" size={18} strokeWidth={1.8} />
                </Link>
              </div>
            ))}
          </div>
        </section>

        <section className="dashboard-panel status-panel" aria-labelledby="dashboard-status-title">
          <h2 id="dashboard-status-title">{copy.dashboard.operationalStatus}</h2>
          <div className={`status-lead status-lead--${status.tone}`}>
            <span className={`dashboard-icon dashboard-icon--${status.tone}`} aria-hidden="true">
              <StatusIcon size={24} strokeWidth={1.9} />
            </span>
            <span>
              <strong>{status.label}</strong>
              <span>{status.detail}</span>
            </span>
          </div>
          <div className="incident-list">
            {incidents.map(({ value, emptyLabel, countLabel, to }) => (
              <Link
                className={value > 0 ? "incident incident--warning" : "incident"}
                key={to + emptyLabel}
                to={to}
              >
                <strong>{value}</strong>
                <span>{value > 0 ? countLabel(value) : emptyLabel}</span>
                <ArrowRight aria-hidden="true" size={16} strokeWidth={1.8} />
              </Link>
            ))}
          </div>
        </section>
      </div>

      <DashboardConnections connections={connections} />

      <section
        className="dashboard-panel documents-panel"
        aria-labelledby="dashboard-documents-title"
      >
        <div className="documents-summary">
          <h2 id="dashboard-documents-title">{copy.dashboard.documents}</h2>
          <div>
            <Link to="/documenti">
              <strong>{summary.documents_today}</strong>
              <span>{copy.dashboard.issuedToday}</span>
            </Link>
            <Link to="/documenti">
              <strong>{summary.documents_this_month}</strong>
              <span>{copy.dashboard.issuedThisMonth}</span>
            </Link>
          </div>
        </div>
        <div className="documents-chart">
          <h3>{copy.dashboard.lastSevenDays}</h3>
          <div className="documents-chart__plot">
            {summary.documents_last_seven_days.map((day) => {
              const label = chartDate(day.date);
              return (
                <span className="documents-chart__day" key={day.date}>
                  <strong>{day.count}</strong>
                  <progress
                    aria-label={copy.dashboard.documentsInDay(day.count, label)}
                    max={maxDocuments}
                    value={day.count}
                  />
                  <span>{label}</span>
                </span>
              );
            })}
          </div>
        </div>
      </section>
    </AppShell>
  );
}
