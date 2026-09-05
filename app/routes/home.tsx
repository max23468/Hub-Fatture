import { ArrowRight, CircleAlert, CircleCheck, ClipboardCheck, CreditCard } from "lucide-react";
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
import { arubaInventoryApprovalState } from "../../src/aruba-inventory.ts";
import { getArubaInventoryHealth } from "../../src/db/aruba-inventory-health.server.ts";
import { getArubaMonthlyTransmissionUsage } from "../../src/db/aruba-api-outbound.server.ts";
import { dashboardSummary } from "../../src/db/order-queries.server.ts";
import { readOperationalControlSummary } from "../../src/db/operational-controls.server.ts";

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
  const [summary, arubaConnection, arubaInventory, arubaMonthlyUsage, controls] = await Promise.all(
    [
      dashboardSummary(),
      getArubaApiConnectionStatus(),
      getArubaInventoryHealth(),
      getArubaMonthlyTransmissionUsage(),
      readOperationalControlSummary(),
    ],
  );
  return {
    username: user.username,
    canApprove: user.canApprove,
    csrfToken: user.csrfToken,
    currentTime: new Date().toISOString(),
    summary,
    arubaConnection,
    arubaInventory,
    arubaMonthlyUsage,
    controls,
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
    controls,
  } = useLoaderData<typeof loader>();
  const workItems = [
    {
      value: Number(summary.ready_cases),
      label: copy.dashboard.readyPreparations,
      detail: copy.document.inventoryApprovalStates[arubaInventoryApprovalState(arubaInventory)],
      to: "/ordini?vista=fatturare",
      action: copy.dashboard.openPreparations,
      icon: ClipboardCheck,
      tone: "success",
      primary: true,
    },
    {
      value: controls.open,
      label: copy.dashboard.controlsToResolve,
      details: copy.dashboard.controlsDetails(
        controls.blocking,
        controls.important,
        controls.ordinary,
      ),
      to: "/controlli",
      action: copy.dashboard.openControls,
      icon: CircleAlert,
      tone: "warning",
      primary: false,
    },
    {
      value: Number(summary.pending_payments),
      label: copy.dashboard.pendingPayments,
      detail: copy.dashboard.pendingDetail,
      to: "/ordini?vista=attesa",
      action: copy.dashboard.openPreparations,
      icon: CreditCard,
      tone: "accent",
      primary: false,
    },
  ] as const;

  const connections = createDashboardConnections({
    currentTime,
    shopify: {
      connectionStatus: summary.shopify_connection_status,
      lastSync: summary.last_shopify_sync,
    },
    ebay: {
      connectionStatus: summary.ebay_connection_status,
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

  const hasMissingUpdates =
    Number(summary.aruba_batches_requiring_attention) > 0 ||
    connections.some((connection) => connection.blocking || connection.stale);
  const requiresTechnicalAttention = controls.technical > 0 || hasMissingUpdates;
  const status = requiresTechnicalAttention
    ? {
        label:
          controls.technical > 0
            ? copy.dashboard.technicalErrors(controls.technical)
            : copy.dashboard.updatesMissing,
        detail: copy.dashboard.technicalAttention,
        tone: "warning",
        icon: CircleAlert,
      }
    : {
        label: copy.dashboard.noTechnicalErrors,
        detail: copy.dashboard.technicalHealthy,
        tone: "success",
        icon: CircleCheck,
      };
  const technicalAreas = [
    {
      label: copy.dashboard.acquisition,
      healthy: controls.acquisition === 0 && !hasMissingUpdates,
    },
    { label: copy.dashboard.processing, healthy: controls.processing === 0 },
    { label: copy.dashboard.documentGeneration, healthy: controls.document_generation === 0 },
  ];
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

      <section
        className="dashboard-panel work-panel work-panel--primary"
        aria-labelledby="dashboard-work-title"
      >
        <h2 className="visually-hidden" id="dashboard-work-title">
          {copy.dashboard.workNow}
        </h2>
        <div className="work-list">
          {workItems.map((item) => (
            <div className="work-item" key={item.label}>
              <span className={`dashboard-icon dashboard-icon--${item.tone}`} aria-hidden="true">
                <item.icon size={24} strokeWidth={1.8} />
              </span>
              <strong className={`work-item__value work-item__value--${item.tone}`}>
                {item.value}
              </strong>
              <span className="work-item__copy">
                <strong>{item.label}</strong>
                {"details" in item ? (
                  <span className="work-item__details">
                    {item.details.map((detail) => (
                      <span key={detail}>{detail}</span>
                    ))}
                  </span>
                ) : (
                  <span>{item.detail}</span>
                )}
              </span>
              <Link
                className={item.primary ? "button" : "dashboard-row-link"}
                reloadDocument
                to={item.to}
              >
                <span>{item.action}</span>
                <ArrowRight aria-hidden="true" size={18} strokeWidth={1.8} />
              </Link>
            </div>
          ))}
        </div>
      </section>

      <section
        className="dashboard-panel status-panel status-panel--wide"
        aria-labelledby="dashboard-status-title"
      >
        <div className={`status-lead status-lead--${status.tone}`}>
          <span className={`dashboard-icon dashboard-icon--${status.tone}`} aria-hidden="true">
            <StatusIcon size={24} strokeWidth={1.9} />
          </span>
          <span>
            <h2 className="status-lead__title" id="dashboard-status-title">
              {copy.dashboard.operationalStatus}
            </h2>
            <strong>{status.label}</strong>
            <span>{status.detail}</span>
          </span>
        </div>
        <div className="technical-areas">
          {technicalAreas.map((area) => (
            <span
              className={area.healthy ? "technical-area" : "technical-area technical-area--warning"}
              key={area.label}
            >
              {area.healthy ? (
                <CircleCheck aria-hidden="true" size={20} />
              ) : (
                <CircleAlert aria-hidden="true" size={20} />
              )}
              <span>
                <strong>{area.label}</strong>
                <small>
                  {area.healthy ? copy.dashboard.regular : copy.dashboard.needsAttention}
                </small>
              </span>
            </span>
          ))}
        </div>
      </section>

      <DashboardConnections connections={connections} />

      <section
        className="dashboard-panel documents-panel"
        aria-labelledby="dashboard-documents-title"
      >
        <div className="documents-summary">
          <h2 id="dashboard-documents-title">{copy.dashboard.documents}</h2>
          <div>
            <Link reloadDocument to="/documenti">
              <strong>{summary.documents_today}</strong>
              <span>{copy.dashboard.issuedToday}</span>
            </Link>
            <Link reloadDocument to="/documenti">
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
