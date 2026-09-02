import { ArrowRight, Cloud, ShoppingCart, Tag } from "lucide-react";
import { Link } from "react-router";

import {
  dashboardArubaConnectionState,
  dashboardConnectionFreshness,
  type DashboardArubaConnectionInput,
} from "../../src/dashboard.ts";
import {
  salesChannelConnectionState,
  salesChannelIsConnected,
  type SalesChannelConnectionStatus,
} from "../../src/sales-channel-connection.ts";
import { copy } from "../copy.it";
import { dateTime } from "../format";

interface DashboardConnectionSources {
  currentTime: string;
  shopify: { connectionStatus: SalesChannelConnectionStatus; lastSync: string | null };
  ebay: { connectionStatus: SalesChannelConnectionStatus; lastSync: string | null };
  aruba: {
    configured: boolean;
    connectionStatus: DashboardArubaConnectionInput["connectionStatus"];
    apiPaused: boolean;
    inboundEnabled: boolean;
    activeSync: boolean;
    lastCompletedAt: string | null;
    syncFailed: boolean;
  };
}

export function createDashboardConnections(sources: DashboardConnectionSources) {
  const shopifyState = salesChannelConnectionState(sources.shopify.connectionStatus);
  const ebayState = salesChannelConnectionState(sources.ebay.connectionStatus);
  const arubaStatus = dashboardArubaConnectionState({
    configured: sources.aruba.configured,
    connectionStatus: sources.aruba.connectionStatus,
    apiPaused: sources.aruba.apiPaused,
    inboundEnabled: sources.aruba.inboundEnabled,
    activeSync: sources.aruba.activeSync,
    lastCompletedAt: sources.aruba.lastCompletedAt,
    syncFailed: sources.aruba.syncFailed,
    now: sources.currentTime,
  });
  return [
    {
      label: "Shopify",
      value: sources.shopify.lastSync,
      connected: salesChannelIsConnected(shopifyState),
      state: "sales-channel" as const,
      connectionLabel:
        shopifyState === "CONNECTED"
          ? undefined
          : copy.dashboard.salesChannelConnectionStates[shopifyState],
      connectionAttention: shopifyState !== "CONNECTED",
      connectionBlocking: shopifyState !== "CONNECTED",
      never: copy.dashboard.neverUpdated,
      to: "/impostazioni#connessioni",
      icon: ShoppingCart,
    },
    {
      label: "eBay",
      value: sources.ebay.lastSync,
      connected: salesChannelIsConnected(ebayState),
      state: "sales-channel" as const,
      connectionLabel:
        ebayState === "CONNECTED"
          ? undefined
          : copy.dashboard.salesChannelConnectionStates[ebayState],
      connectionAttention: ebayState !== "CONNECTED",
      connectionBlocking: ebayState !== "CONNECTED",
      never: copy.dashboard.neverUpdated,
      to: "/impostazioni#connessioni",
      icon: Tag,
    },
    {
      label: "Aruba",
      value: sources.aruba.lastCompletedAt,
      connected: arubaStatus.state !== "NOT_CONNECTED",
      state: "connection" as const,
      connectionLabel: copy.dashboard.arubaConnectionStates[arubaStatus.state],
      connectionAttention: arubaStatus.attention,
      connectionBlocking: arubaStatus.blocking,
      never: copy.dashboard.neverRead,
      to: "/impostazioni#aruba",
      icon: Cloud,
    },
  ].map((connection) => {
    const freshness =
      connection.state === "connection" || connection.connectionAttention
        ? {
            stale: connection.connectionAttention,
            blocking: connection.connectionBlocking,
          }
        : dashboardConnectionFreshness({
            connected: connection.connected,
            lastUpdatedAt: connection.value,
            now: sources.currentTime,
          });
    return {
      ...connection,
      ...freshness,
      blocking: freshness.blocking,
    };
  });
}

type DashboardConnection = ReturnType<typeof createDashboardConnections>[number];

export function DashboardConnections({ connections }: { connections: DashboardConnection[] }) {
  return (
    <section
      className="dashboard-panel connections-panel"
      aria-labelledby="dashboard-connections-title"
    >
      <h2 id="dashboard-connections-title">{copy.dashboard.connections}</h2>
      <div className="connection-list">
        {connections.map(
          ({ label, value, connected, state, never, to, icon: Icon, stale, connectionLabel }) => (
            <Link className="connection" key={label} reloadDocument to={to}>
              <span className="dashboard-icon dashboard-icon--neutral" aria-hidden="true">
                <Icon size={22} strokeWidth={1.7} />
              </span>
              <span className="connection__copy">
                <span>
                  <strong>{label}</strong>
                  <span
                    className={
                      stale ? "connection__state connection__state--stale" : "connection__state"
                    }
                  >
                    <span aria-hidden="true" />
                    {state === "connection" || connectionLabel
                      ? connectionLabel
                      : !connected
                        ? copy.settings.notConnected
                        : value
                          ? stale
                            ? copy.dashboard.stale
                            : copy.dashboard.updated
                          : never}
                  </span>
                </span>
                <span>{value ? dateTime(value) : copy.settings.never}</span>
              </span>
              <ArrowRight aria-hidden="true" size={17} strokeWidth={1.8} />
            </Link>
          ),
        )}
      </div>
    </section>
  );
}
