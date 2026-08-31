import { PlugZap } from "lucide-react";
import { Form } from "react-router";

import type {
  connectionSummaries,
  latestEbayHistory,
} from "../../../src/db/connector-connections.server.ts";
import { defaultHistoricalStartDate } from "../../../src/orders.ts";
import {
  salesChannelConnectionState,
  salesChannelIsConnected,
} from "../../../src/sales-channel-connection.ts";
import { copy } from "../../copy.it";
import { dateTime } from "../../format";
import { SettingsSectionHeader } from "../settings-controls";
import type { ErrorFor } from "./settings-types";

export function ConnectionsSettingsSection({
  connections,
  ebayHistory,
  historyStart,
  historyProvider,
  historyToday,
  imported,
  preview,
  csrfToken,
  errorFor,
}: {
  connections: Awaited<ReturnType<typeof connectionSummaries>>;
  ebayHistory: Awaited<ReturnType<typeof latestEbayHistory>>;
  historyStart: string | null;
  historyProvider: string | null;
  historyToday: string;
  imported: {
    provider: string;
    imported: string;
    updated: string;
    ignored: string;
  } | null;
  preview: { provider: string; count: string; review: string } | null;
  csrfToken: string;
  errorFor: ErrorFor;
}) {
  const byProvider = new Map(connections.map((connection) => [connection.provider, connection]));
  return (
    <section className="settings-section" id="connessioni" aria-labelledby="connessioni-title">
      <SettingsSectionHeader
        id="connessioni"
        icon={PlugZap}
        title={copy.settings.connectionsTitle}
        intro={copy.settings.connectionsHelp}
      />
      {preview ? (
        <p className="notice" role="status">
          {copy.settings.previewResult(preview.provider, preview.count, preview.review)}
        </p>
      ) : null}
      {imported ? (
        <p className="notice" role="status">
          {copy.settings.historyImportResult(
            imported.provider,
            imported.imported,
            imported.updated,
            imported.ignored,
          )}
        </p>
      ) : null}
      {ebayHistory ? (
        <p className="notice" role="status">
          {copy.settings.ebayHistoryStatus(ebayHistory)}
        </p>
      ) : null}
      {errorFor("preview-shopify", "preview-ebay", "import-shopify", "import-ebay") ? (
        <p className="error" role="alert">
          {errorFor("preview-shopify", "preview-ebay", "import-shopify", "import-ebay")}
        </p>
      ) : null}
      <div className="connection-grid">
        {(["SHOPIFY", "EBAY"] as const).map((provider) => {
          const connection = byProvider.get(provider);
          const connectionState = salesChannelConnectionState(connection?.status);
          const isConnected = salesChannelIsConnected(connectionState);
          const label = copy.settings.providerLabels[provider];
          const initialHistoryStart = connection
            ? ((historyProvider === provider ? historyStart : null) ??
              defaultHistoricalStartDate(Date.parse(connection.connectedAt)))
            : null;
          return (
            <section className="connection-panel settings-inset-card" key={provider}>
              <header>
                <div>
                  <span className="connection-panel__eyebrow">{copy.settings.salesChannel}</span>
                  <h3>{label}</h3>
                </div>
                <span
                  className={`settings-status ${
                    isConnected ? "settings-status--success" : "settings-status--neutral"
                  }`}
                >
                  {copy.settings.connectionStates[connectionState]}
                </span>
              </header>
              <dl className="facts connection-panel__facts">
                <div>
                  <dt>{copy.settings.connectionEnvironment}</dt>
                  <dd>{connection?.environment ?? copy.common.unavailable}</dd>
                </div>
                <div>
                  <dt>{copy.settings.connectionAccount}</dt>
                  <dd>{connection?.accountReference ?? copy.common.unavailable}</dd>
                </div>
                <div>
                  <dt>{copy.settings.lastCheck}</dt>
                  <dd>
                    {connection?.lastCheckedAt
                      ? dateTime(connection.lastCheckedAt)
                      : copy.settings.never}
                  </dd>
                </div>
                <div>
                  <dt>{copy.settings.lastSync}</dt>
                  <dd>
                    {connection?.lastSyncedAt
                      ? dateTime(connection.lastSyncedAt)
                      : copy.settings.never}
                  </dd>
                </div>
              </dl>
              <div className="connection-panel__feedback">
                {connection?.lastErrorCode ? (
                  <p className="error">
                    {copy.settings.connectionError(connection.lastErrorCode)}{" "}
                    <a href="/controlli?origine=CONNECTIONS">{copy.settings.openControls}</a>
                  </p>
                ) : null}
              </div>
              <div className="connection-panel__actions">
                <a
                  className="button button--secondary"
                  href={
                    provider === "SHOPIFY"
                      ? "/integrations/shopify/auth"
                      : "/integrations/ebay/auth"
                  }
                >
                  {connection ? copy.settings.reconnect : copy.settings.connect}
                </a>
              </div>
              <section className="connection-history">
                <header className="connection-history__header">
                  <h4>{copy.settings.historyTitle}</h4>
                  <span className="settings-status settings-status--neutral">
                    {connection?.historyImported
                      ? copy.settings.historyComplete
                      : copy.settings.historyToComplete}
                  </span>
                </header>
                {isConnected && !connection?.historyImported ? (
                  <Form method="post" className="connection-history__form">
                    <input type="hidden" name="csrf" value={csrfToken} />
                    <label>
                      {copy.settings.historyStart(label)}
                      <input
                        defaultValue={initialHistoryStart!}
                        key={`${provider}:${initialHistoryStart}`}
                        max={historyToday}
                        name="historyStart"
                        required
                        type="date"
                      />
                    </label>
                    <p className="field-help">{copy.settings.historyHelp}</p>
                    <div className="connection-panel__actions">
                      <button
                        className="button button--secondary"
                        name="intent"
                        value={provider === "SHOPIFY" ? "preview-shopify" : "preview-ebay"}
                        type="submit"
                      >
                        {copy.settings.preview}
                      </button>
                      <button
                        className="button"
                        name="intent"
                        value={provider === "SHOPIFY" ? "import-shopify" : "import-ebay"}
                        type="submit"
                      >
                        {copy.settings.importHistory}
                      </button>
                    </div>
                  </Form>
                ) : connection?.historyImported ? (
                  <p className="connection-history__ready">{copy.settings.historyReady}</p>
                ) : (
                  <p className="connection-history__ready">{copy.settings.historyConnectFirst}</p>
                )}
              </section>
            </section>
          );
        })}
      </div>
    </section>
  );
}
