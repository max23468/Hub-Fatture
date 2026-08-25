import {
  AlertTriangle,
  CircleCheck,
  CircleUserRound,
  FileCheck2,
  Landmark,
  LogOut,
  Mail,
  PlugZap,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { Form, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/settings";

import { AppShell } from "../components/app-shell";
import {
  SettingsForm,
  SettingsNavigation,
  SettingsSelect,
  SettingsSectionHeader,
} from "../components/settings-controls";
import { ThemePicker } from "../components/theme-picker";
import { copy } from "../copy.it";
import { dateTime } from "../format";
import { privateRouteMeta } from "../metadata";
import type { getAccountProfile } from "../../src/db/auth.server.ts";
import type { getArubaSettings } from "../../src/db/aruba.server.ts";
import type { getArubaInventoryHealth } from "../../src/db/aruba-inbound.server.ts";
import type { connectionSummaries, latestEbayHistory } from "../../src/db/connectors.server.ts";
import { defaultHistoricalStartDate } from "../../src/orders.ts";
import type { getSystemStatus } from "../../src/db/system.server.ts";
import { action, loader } from "./settings.server.ts";

export { action, loader };

export function meta({ error }: Route.MetaArgs) {
  return privateRouteMeta("settings", { error });
}

type ErrorFor = (...intents: string[]) => string | null;

function BookmarkletLink({ value }: { value: string }) {
  const linkRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    linkRef.current?.setAttribute("href", value);
  }, [value]);
  return (
    <a
      aria-label={copy.settings.arubaBookmarkletAccessibleLabel}
      className="button button--secondary aruba-bookmarklet__button"
      href="#aruba-bookmarklet-title"
      ref={linkRef}
      title={copy.settings.arubaBookmarkletLabel}
    >
      {copy.settings.arubaBookmarkletLabel}
    </a>
  );
}

function ProfileSettingsSection({
  username,
  canApprove,
  csrfToken,
  profile,
  passwordChanged,
  sessionsRevoked,
  errorFor,
}: {
  username: string;
  canApprove: boolean;
  csrfToken: string;
  profile: Awaited<ReturnType<typeof getAccountProfile>>;
  passwordChanged: boolean;
  sessionsRevoked: boolean;
  errorFor: ErrorFor;
}) {
  const otherSessions = profile.sessions.filter((session) => !session.current);
  return (
    <section
      className="settings-section"
      id="profilo-sicurezza"
      aria-labelledby="profilo-sicurezza-title"
    >
      <SettingsSectionHeader
        id="profilo-sicurezza"
        icon={CircleUserRound}
        title={copy.settings.profileTitle}
        intro={copy.settings.profileHelp}
      />
      {passwordChanged ? (
        <p className="notice" role="status">
          {copy.settings.passwordChanged}
        </p>
      ) : null}
      {sessionsRevoked ? (
        <p className="notice" role="status">
          {copy.settings.sessionsRevoked}
        </p>
      ) : null}
      <div className="settings-profile-grid">
        <div className="profile-overview settings-inset-card">
          <span className="profile-overview__avatar" aria-hidden="true">
            <CircleUserRound size={30} strokeWidth={1.6} />
          </span>
          <div className="profile-overview__identity">
            <strong>{username}</strong>
            <span>{canApprove ? copy.navigation.ownerRole : copy.navigation.operatorRole}</span>
          </div>
          <p className="profile-overview__permission">
            <ShieldCheck aria-hidden="true" size={18} strokeWidth={1.8} />
            {canApprove ? copy.navigation.ownerPermission : copy.navigation.operatorPermission}
          </p>
        </div>
        <div className="settings-inset-card settings-appearance-card">
          <h3>{copy.settings.appearanceTitle}</h3>
          <ThemePicker />
        </div>
      </div>
      <div className="settings-profile-details">
        <div className="settings-inset-card settings-detail-card">
          <header className="settings-detail-card__header">
            <h3>{copy.settings.passwordTitle}</h3>
            <p>{copy.settings.passwordHelp}</p>
          </header>
          <Form method="post" className="security-form">
            <input type="hidden" name="csrf" value={csrfToken} />
            <input type="hidden" name="intent" value="change-password" />
            <input
              aria-label={copy.login.username}
              autoComplete="username"
              className="visually-hidden"
              name="username"
              readOnly
              tabIndex={-1}
              type="text"
              value={username}
            />
            <label>
              {copy.settings.currentPassword}
              <input
                autoComplete="current-password"
                maxLength={128}
                name="currentPassword"
                required
                type="password"
              />
            </label>
            <label>
              {copy.settings.newPassword}
              <input
                autoComplete="new-password"
                minLength={8}
                maxLength={128}
                name="newPassword"
                required
                type="password"
              />
            </label>
            <label className="security-form__confirmation">
              {copy.settings.passwordConfirmation}
              <input
                autoComplete="new-password"
                minLength={8}
                maxLength={128}
                name="passwordConfirmation"
                required
                type="password"
              />
            </label>
            {errorFor("change-password") ? (
              <p className="error" role="alert">
                {errorFor("change-password")}
              </p>
            ) : null}
            <button className="button" type="submit">
              {copy.settings.changePassword}
            </button>
          </Form>
          <div className="settings-password-exit">
            <div>
              <h4>{copy.settings.exitTitle}</h4>
              <p>{copy.settings.exitHelp}</p>
            </div>
            <Form method="post" action="/logout">
              <input type="hidden" name="csrf" value={csrfToken} />
              <button className="button button--secondary" type="submit">
                <LogOut aria-hidden="true" size={17} strokeWidth={1.8} />
                {copy.navigation.logout}
              </button>
            </Form>
          </div>
        </div>

        <div className="settings-inset-card settings-detail-card settings-sessions-card">
          <header className="settings-detail-card__header">
            <h3>{copy.settings.sessionsTitle}</h3>
            <p>{copy.settings.sessionsHelp}</p>
          </header>
          <ul className="session-list">
            {profile.sessions.map((session) => (
              <li key={`${session.createdAt}:${session.expiresAt}:${session.current}`}>
                <span>
                  <strong>
                    {session.current ? copy.settings.currentSession : copy.settings.otherSession}
                  </strong>
                  <small>{copy.settings.lastActivity(dateTime(session.lastSeenAt))}</small>
                </span>
                <small>{copy.settings.sessionExpiry(dateTime(session.expiresAt))}</small>
              </li>
            ))}
          </ul>
          {otherSessions.length ? (
            <Form method="post" className="settings-card-action">
              <input type="hidden" name="csrf" value={csrfToken} />
              <input type="hidden" name="intent" value="revoke-other-sessions" />
              {errorFor("revoke-other-sessions") ? (
                <p className="error" role="alert">
                  {errorFor("revoke-other-sessions")}
                </p>
              ) : null}
              <button className="button button--secondary" type="submit">
                {copy.settings.revokeOtherSessions}
              </button>
            </Form>
          ) : (
            <p className="field-help settings-card-action">{copy.settings.noOtherSessions}</p>
          )}
        </div>
      </div>
    </section>
  );
}

function ConnectionsSettingsSection({
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
  imported: { provider: string; imported: string; updated: string; ignored: string } | null;
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
                    connection?.status === "CONNECTED"
                      ? "settings-status--success"
                      : "settings-status--neutral"
                  }`}
                >
                  {connection?.status === "CONNECTED"
                    ? copy.settings.connected
                    : copy.settings.notConnected}
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
                    <a href="/attivita">{copy.settings.openActivities}</a>
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
                {connection?.status === "CONNECTED" && !connection.historyImported ? (
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

type ManualReadbackData = {
  id: string;
  coverage?: { streams: string[]; oldestReconciliationDate: string | null };
  pagesAdded?: number;
  documentsAdded?: number;
};

function ArubaInventoryCard({
  inventory,
}: {
  inventory: Awaited<ReturnType<typeof getArubaInventoryHealth>>;
}) {
  const unresolvedCount = inventory.potentialMatches + inventory.ambiguous + inventory.conflicts;
  return (
    <section className="aruba-inventory-card" aria-labelledby="aruba-inventory-title">
      <header>
        <h3 id="aruba-inventory-title">{copy.settings.arubaInventoryTitle}</h3>
        <span
          className={`settings-status settings-status--${inventory.status === "HEALTHY" ? "success" : "neutral"}`}
        >
          {copy.settings.arubaInventoryLabels[inventory.status]}
        </span>
      </header>
      <dl>
        <div>
          <dt>{copy.settings.arubaRemoteDocuments}</dt>
          <dd>{inventory.remoteDocuments}</dd>
        </div>
        <div>
          <dt>{copy.settings.arubaExternalDocuments}</dt>
          <dd>{inventory.externalDocuments}</dd>
        </div>
        <div>
          <dt>{copy.settings.arubaUnresolved}</dt>
          <dd>{unresolvedCount}</dd>
        </div>
      </dl>
    </section>
  );
}

function ArubaConnectionDetails({
  inventory,
}: {
  inventory: Awaited<ReturnType<typeof getArubaInventoryHealth>>;
}) {
  return (
    <details className="settings-disclosure aruba-connection-details">
      <summary>{copy.settings.arubaConnectionDetails}</summary>
      <dl className="settings-facts-grid settings-facts-grid--three">
        <div>
          <dt>{copy.settings.arubaLastReadback}</dt>
          <dd>
            {inventory.lastCompletedAt ? dateTime(inventory.lastCompletedAt) : copy.settings.never}
          </dd>
        </div>
        <div>
          <dt>{copy.settings.arubaSession}</dt>
          <dd>
            {inventory.activeSession
              ? copy.settings.arubaSessionActive
              : copy.settings.arubaSessionInactive}
          </dd>
        </div>
        <div>
          <dt>{copy.settings.arubaDiagnostic}</dt>
          <dd>
            {inventory.lastErrorCode
              ? copy.settings.arubaDiagnosticValue(inventory.lastErrorCode)
              : copy.settings.arubaNoError}
          </dd>
        </div>
      </dl>
    </details>
  );
}

function ArubaManualRecovery({
  manualReadback,
  csrfToken,
  errorFor,
}: {
  manualReadback?: ManualReadbackData | null;
  csrfToken: string;
  errorFor: ErrorFor;
}) {
  const manualError = errorFor(
    "create-aruba-manual-readback",
    "add-aruba-manual-readback-pages",
    "finalize-aruba-manual-readback",
  );
  return (
    <details className="settings-disclosure settings-manual-readback">
      <summary>{copy.settings.arubaAdvancedRecovery}</summary>
      <p className="field-help">{copy.settings.arubaAdvancedRecoveryHelp}</p>
      {!manualReadback ? (
        <Form method="post">
          <input type="hidden" name="csrf" value={csrfToken} />
          <input type="hidden" name="intent" value="create-aruba-manual-readback" />
          <button className="button button--secondary" type="submit">
            {copy.settings.arubaOpenManualRecovery}
          </button>
        </Form>
      ) : manualReadback.pagesAdded === undefined ? (
        <Form method="post" className="security-form">
          <input type="hidden" name="csrf" value={csrfToken} />
          <input type="hidden" name="intent" value="add-aruba-manual-readback-pages" />
          <input type="hidden" name="readbackId" value={manualReadback.id} />
          {manualReadback.coverage ? (
            <p className="field-help">
              Stream obbligatori: {manualReadback.coverage.streams.join(", ")}. Estremo:{" "}
              {manualReadback.coverage.oldestReconciliationDate ?? "oggi"}.
            </p>
          ) : null}
          <label>
            Pagine acquisite in JSON
            <textarea name="pagesJson" required rows={10} spellCheck={false} />
          </label>
          <button className="button" type="submit">
            Valida pagine
          </button>
        </Form>
      ) : (
        <Form method="post">
          <input type="hidden" name="csrf" value={csrfToken} />
          <input type="hidden" name="intent" value="finalize-aruba-manual-readback" />
          <input type="hidden" name="readbackId" value={manualReadback.id} />
          <p className="field-help">
            {manualReadback.pagesAdded} pagine e {manualReadback.documentsAdded} documenti validati.
            La finalizzazione è atomica e non supera conflitti o stati incerti.
          </p>
          <button className="button" type="submit">
            Finalizza inventario manuale
          </button>
        </Form>
      )}
      {manualError ? (
        <p className="error" role="alert">
          {manualError}
        </p>
      ) : null}
    </details>
  );
}

function ArubaSettingsSection({
  aruba,
  arubaSaved,
  inventory,
  arubaPanelUrl,
  arubaBookmarkletUrl,
  manualReadback,
  manualReadbackCompleted,
  canApprove,
  csrfToken,
  errorFor,
}: {
  aruba: Awaited<ReturnType<typeof getArubaSettings>>;
  arubaSaved: boolean;
  inventory: Awaited<ReturnType<typeof getArubaInventoryHealth>>;
  arubaPanelUrl: string;
  arubaBookmarkletUrl: string;
  manualReadback?: ManualReadbackData | null;
  manualReadbackCompleted: boolean;
  canApprove: boolean;
  csrfToken: string;
  errorFor: ErrorFor;
}) {
  const connectionState = inventory.activeSession
    ? "ACTIVE"
    : inventory.blockingReason === "CONFLICT"
      ? "CONFLICT"
      : inventory.blocking
        ? "ATTENTION"
        : "READY";
  const connectionCopy = {
    ACTIVE: {
      title: copy.settings.arubaConnectionActive,
      description: copy.settings.arubaConnectionActiveHelp,
    },
    READY: {
      title: copy.settings.arubaConnectionReady,
      description: copy.settings.arubaConnectionReadyHelp,
    },
    ATTENTION: {
      title: copy.settings.arubaConnectionAttention,
      description: copy.settings.arubaConnectionAttentionHelp,
    },
    CONFLICT: {
      title: copy.settings.arubaConnectionConflict,
      description: copy.settings.arubaConnectionConflictHelp,
    },
  }[connectionState];
  const ConnectionIcon =
    connectionState === "ATTENTION" || connectionState === "CONFLICT" ? AlertTriangle : CircleCheck;
  return (
    <section className="settings-section" id="aruba-helper" aria-labelledby="aruba-helper-title">
      <SettingsSectionHeader
        id="aruba-helper"
        icon={Landmark}
        title={copy.settings.arubaTitle}
        intro={copy.settings.arubaHelp}
      />
      {arubaSaved ? (
        <p className="notice" role="status">
          {copy.settings.arubaSaved}
        </p>
      ) : null}
      {manualReadbackCompleted ? (
        <p className="notice" role="status">
          Readback manuale completo acquisito e inventario Aruba aggiornato.
        </p>
      ) : null}
      {aruba.automaticForcedAssisted ? (
        <p className="warning">{copy.settings.arubaKillSwitch}</p>
      ) : null}
      <section className="aruba-sync-card" aria-labelledby="aruba-sync-status-title">
        <div className="aruba-sync-card__status">
          <span
            className={`aruba-sync-card__icon aruba-sync-card__icon--${connectionState.toLowerCase()}`}
          >
            <ConnectionIcon aria-hidden="true" size={22} strokeWidth={1.8} />
          </span>
          <div>
            <p className="aruba-sync-card__eyebrow">{copy.settings.arubaSyncTitle}</p>
            <h3 id="aruba-sync-status-title">{connectionCopy.title}</h3>
            <p>{connectionCopy.description}</p>
            <p className="aruba-sync-card__updated">
              {copy.settings.arubaLastUpdate(
                aruba.helper.lastReadbackAt
                  ? dateTime(aruba.helper.lastReadbackAt)
                  : copy.settings.never,
              )}
            </p>
          </div>
        </div>
        {canApprove ? (
          <div className="aruba-sync-card__actions">
            <a className="button" href={arubaPanelUrl} rel="noreferrer" target="_blank">
              {copy.settings.arubaOpenPanel}
            </a>
          </div>
        ) : (
          <p className="field-help">{copy.settings.arubaSyncOwnerOnly}</p>
        )}
      </section>
      {canApprove ? (
        <section
          className="settings-inset-card aruba-bookmarklet"
          aria-labelledby="aruba-bookmarklet-title"
        >
          <header>
            <h3 id="aruba-bookmarklet-title">{copy.settings.arubaBookmarkletTitle}</h3>
            <p>{copy.settings.arubaBookmarkletHelp}</p>
          </header>
          <ol>
            <li>
              <div className="aruba-bookmarklet__step">
                <div className="aruba-bookmarklet__copy">
                  <strong>{copy.settings.arubaBookmarkletSaveTitle}</strong>
                  <span>{copy.settings.arubaBookmarkletSaveHelp}</span>
                </div>
                <BookmarkletLink value={arubaBookmarkletUrl} />
              </div>
            </li>
            <li>
              <div className="aruba-bookmarklet__copy">
                <strong>{copy.settings.arubaBookmarkletRunTitle}</strong>
                <span>{copy.settings.arubaBookmarkletRunHelp}</span>
              </div>
            </li>
          </ol>
        </section>
      ) : null}
      <ArubaInventoryCard inventory={inventory} />
      <ArubaConnectionDetails inventory={inventory} />
      {canApprove && inventory.blocking ? (
        <ArubaManualRecovery
          csrfToken={csrfToken}
          errorFor={errorFor}
          manualReadback={manualReadback}
        />
      ) : null}
      {canApprove ? (
        <section
          className="settings-transmission-section"
          aria-labelledby="aruba-transmission-title"
        >
          <header>
            <h3 id="aruba-transmission-title">{copy.settings.arubaTransmissionTitle}</h3>
            <p>{copy.settings.arubaTransmissionHelp}</p>
          </header>
          <SettingsForm
            accessibleSubmitLabel={copy.settings.arubaSave}
            className="settings-choice-card settings-choice-card--compact"
            key={aruba.mode.version}
            submitLabel={copy.settings.saveShort}
          >
            <input type="hidden" name="csrf" value={csrfToken} />
            <input type="hidden" name="intent" value="save-aruba" />
            <input type="hidden" name="arubaModeVersion" value={aruba.mode.version} />
            <label className="settings-choice-card__field">
              <span>{copy.settings.arubaMode}</span>
              <SettingsSelect
                data-initial={aruba.mode.value}
                defaultValue={aruba.mode.value}
                name="arubaMode"
              >
                <option value="ASSISTED">{copy.settings.arubaAssisted}</option>
                <option value="AUTOMATIC">{copy.settings.arubaAutomatic}</option>
              </SettingsSelect>
            </label>
          </SettingsForm>
        </section>
      ) : (
        <p>{copy.settings.arubaOwnerOnly}</p>
      )}
      {errorFor("save-aruba") ? (
        <p className="error" role="alert">
          {errorFor("save-aruba")}
        </p>
      ) : null}
    </section>
  );
}

function SystemSettingsSection({
  environment,
  system,
}: {
  environment: string;
  system: Awaited<ReturnType<typeof getSystemStatus>>;
}) {
  return (
    <section className="settings-section" id="sistema" aria-labelledby="sistema-title">
      <SettingsSectionHeader
        id="sistema"
        icon={ShieldCheck}
        title={copy.settings.systemTitle}
        intro={copy.settings.systemHelp}
      />
      <div className="system-groups">
        <section className="system-group settings-inset-card">
          <h3>{copy.settings.systemOperations}</h3>
          <dl className="facts">
            <div>
              <dt>{copy.settings.environment}</dt>
              <dd>{copy.settings.environmentLabel(environment)}</dd>
            </div>
            <div>
              <dt>{copy.settings.timeZone}</dt>
              <dd>Europe/Rome</dd>
            </div>
            <div>
              <dt>{copy.settings.workerQueue}</dt>
              <dd>{copy.settings.workerQueueStatus(system.jobs.active, system.jobs.failed)}</dd>
            </div>
            <div>
              <dt>{copy.settings.arubaKillSwitchStatus}</dt>
              <dd>
                {system.arubaSubmissionEnabled ? copy.settings.enabled : copy.settings.disabled}
              </dd>
            </div>
          </dl>
        </section>
        <section className="system-group settings-inset-card">
          <h3>{copy.settings.systemData}</h3>
          <dl className="facts">
            <div>
              <dt>{copy.settings.databaseSchema}</dt>
              <dd>{system.schema.latest ?? copy.common.unavailable}</dd>
            </div>
            <div>
              <dt>{copy.settings.lastBackup}</dt>
              <dd>
                {system.backup
                  ? copy.settings.backupStatus(
                      dateTime(system.backup.completedAt),
                      system.backup.sizeBytes,
                    )
                  : copy.settings.backupPending}
              </dd>
            </div>
          </dl>
        </section>
        <section className="system-group settings-inset-card">
          <h3>{copy.settings.systemTechnical}</h3>
          <dl className="facts">
            <div>
              <dt>{copy.settings.applicationVersion}</dt>
              <dd>{system.application.version}</dd>
            </div>
            <div>
              <dt>{copy.settings.commit}</dt>
              <dd>
                <details className="technical-value">
                  <summary>
                    <code>{system.application.commit.slice(0, 18)}</code>
                  </summary>
                  <code>{system.application.commit}</code>
                </details>
              </dd>
            </div>
            <div>
              <dt>{copy.settings.imageDigest}</dt>
              <dd>
                <details className="technical-value">
                  <summary>
                    <code>{system.application.imageDigest.slice(0, 18)}</code>
                  </summary>
                  <code>{system.application.imageDigest}</code>
                </details>
              </dd>
            </div>
          </dl>
        </section>
      </div>
      <p className="field-help">{copy.settings.systemOperationalHelp}</p>
    </section>
  );
}

function BillingSettingsSection({
  csrfToken,
  errorFor,
  saved,
  shopifyPaymentFeeMode,
  shopifyPaymentFeeModeSaved,
  trigger,
}: {
  csrfToken: string;
  errorFor: ErrorFor;
  saved: boolean;
  shopifyPaymentFeeMode: { value: "DEDUCT" | "INCLUDE"; version: number };
  shopifyPaymentFeeModeSaved: boolean;
  trigger: { value: "PAID" | "FULFILLED"; version: number };
}) {
  return (
    <section className="settings-section" id="fatturazione" aria-labelledby="fatturazione-title">
      <SettingsSectionHeader
        id="fatturazione"
        icon={Settings2}
        title={copy.settings.billingTitle}
        intro={copy.settings.billingHelp}
      />
      {saved ? (
        <p className="notice" role="status">
          {copy.settings.saved}
        </p>
      ) : null}
      <SettingsForm
        accessibleSubmitLabel={copy.settings.preparationSave}
        className="settings-choice-card"
        key={`trigger:${trigger.version}`}
        submitLabel={copy.settings.save}
      >
        <input type="hidden" name="csrf" value={csrfToken} />
        <input type="hidden" name="intent" value="save-trigger" />
        <input type="hidden" name="version" value={trigger.version} />
        <label className="settings-choice-card__field">
          <span className="settings-choice-card__title">{copy.settings.preparationLabel}</span>
          <span className="field-help">{copy.settings.preparationHelp}</span>
          <SettingsSelect data-initial={trigger.value} defaultValue={trigger.value} name="trigger">
            <option value="PAID">{copy.settings.onPaid}</option>
            <option value="FULFILLED">{copy.settings.onFulfilled}</option>
          </SettingsSelect>
        </label>
      </SettingsForm>
      {errorFor("save-trigger") ? (
        <p className="error" role="alert">
          {errorFor("save-trigger")}
        </p>
      ) : null}
      {shopifyPaymentFeeModeSaved ? (
        <p className="notice" role="status">
          {copy.settings.shopifyPaymentFeeModeSaved}
        </p>
      ) : null}
      <SettingsForm
        accessibleSubmitLabel={copy.settings.shopifyPaymentFeeModeSave}
        className="settings-choice-card"
        key={`shopify-payment-fees:${shopifyPaymentFeeMode.version}`}
        submitLabel={copy.settings.save}
      >
        <input type="hidden" name="csrf" value={csrfToken} />
        <input type="hidden" name="intent" value="save-shopify-payment-fee-mode" />
        <input
          type="hidden"
          name="shopifyPaymentFeeModeVersion"
          value={shopifyPaymentFeeMode.version}
        />
        <label className="settings-choice-card__field">
          <span className="settings-choice-card__title">
            {copy.settings.shopifyPaymentFeeModeLabel}
          </span>
          <span className="field-help">{copy.settings.shopifyPaymentFeeModeHelp}</span>
          <SettingsSelect
            data-initial={shopifyPaymentFeeMode.value}
            defaultValue={shopifyPaymentFeeMode.value}
            name="shopifyPaymentFeeMode"
          >
            <option value="DEDUCT">{copy.settings.shopifyPaymentFeeDeduct}</option>
            <option value="INCLUDE">{copy.settings.shopifyPaymentFeeInclude}</option>
          </SettingsSelect>
        </label>
      </SettingsForm>
      {errorFor("save-shopify-payment-fee-mode") ? (
        <p className="error" role="alert">
          {errorFor("save-shopify-payment-fee-mode")}
        </p>
      ) : null}
    </section>
  );
}

export default function Settings() {
  const {
    username,
    canApprove,
    csrfToken,
    profile,
    trigger,
    shopifyPaymentFeeMode,
    saved,
    shopifyPaymentFeeModeSaved,
    connections,
    ebayHistory,
    historyStart,
    historyProvider,
    historyToday,
    imported,
    preview,
    aruba,
    arubaSaved,
    arubaInventory,
    arubaPanelUrl,
    arubaBookmarkletUrl,
    arubaManualReadbackCompleted,
    customerEmail,
    customerEmailSaved,
    fiscalProfile,
    environment,
    system,
    passwordChanged,
    sessionsRevoked,
  } = useLoaderData<typeof loader>();
  const actionError = useActionData<typeof action>();
  const manualReadback =
    actionError && "manualReadback" in actionError
      ? actionError.manualReadback
      : actionError && "manualReadbackId" in actionError
        ? {
            id: actionError.manualReadbackId,
            pagesAdded: actionError.added.pages,
            documentsAdded: actionError.added.documents,
          }
        : null;
  const errorFor = (...intents: string[]) =>
    actionError && "message" in actionError && intents.includes(actionError.intent)
      ? actionError.message
      : null;

  return (
    <AppShell username={username} canApprove={canApprove} csrfToken={csrfToken}>
      <div className="title-block dashboard-title settings-title">
        <p className="eyebrow">{copy.settings.eyebrow}</p>
        <h1>{copy.settings.title}</h1>
        <p>{copy.settings.intro}</p>
      </div>

      <div className="settings-layout">
        <SettingsNavigation />

        <div className="settings-panel">
          <ProfileSettingsSection
            username={username}
            canApprove={canApprove}
            csrfToken={csrfToken}
            profile={profile}
            passwordChanged={passwordChanged}
            sessionsRevoked={sessionsRevoked}
            errorFor={errorFor}
          />

          <BillingSettingsSection
            csrfToken={csrfToken}
            errorFor={errorFor}
            saved={saved}
            shopifyPaymentFeeMode={shopifyPaymentFeeMode}
            shopifyPaymentFeeModeSaved={shopifyPaymentFeeModeSaved}
            trigger={trigger}
          />

          <section
            className="settings-section"
            id="profilo-fiscale"
            aria-labelledby="profilo-fiscale-title"
          >
            <SettingsSectionHeader
              id="profilo-fiscale"
              icon={FileCheck2}
              title={copy.settings.fiscalTitle}
              intro={copy.settings.fiscalHelp}
            />
            {fiscalProfile ? (
              <dl className="settings-facts-grid settings-facts-grid--four">
                <div>
                  <dt>{copy.settings.fiscalStatus}</dt>
                  <dd>
                    {fiscalProfile.status === "AUDITED"
                      ? copy.settings.fiscalVerified
                      : copy.settings.fiscalMock}
                  </dd>
                </div>
                <div>
                  <dt>{copy.settings.fiscalVersion}</dt>
                  <dd>{fiscalProfile.version}</dd>
                </div>
                <div>
                  <dt>{copy.settings.fiscalRegime}</dt>
                  <dd>{fiscalProfile.taxRegime}</dd>
                </div>
                <div>
                  <dt>{copy.settings.fiscalNature}</dt>
                  <dd>{fiscalProfile.taxNature}</dd>
                </div>
                <div>
                  <dt>{copy.settings.fiscalSeries}</dt>
                  <dd>{fiscalProfile.series}</dd>
                </div>
                <div>
                  <dt>{copy.settings.fiscalCadence}</dt>
                  <dd>{copy.settings.fiscalAnnual}</dd>
                </div>
                <div>
                  <dt>{copy.settings.fiscalScope}</dt>
                  <dd>{copy.settings.fiscalShared}</dd>
                </div>
                <div>
                  <dt>{copy.settings.fiscalLastAudit}</dt>
                  <dd>
                    {fiscalProfile.auditedAt
                      ? dateTime(fiscalProfile.auditedAt)
                      : copy.common.unavailable}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="warning">{copy.settings.fiscalMissing}</p>
            )}
          </section>

          <ConnectionsSettingsSection
            connections={connections}
            ebayHistory={ebayHistory}
            historyStart={historyStart}
            historyProvider={historyProvider}
            historyToday={historyToday}
            imported={imported}
            preview={preview}
            csrfToken={csrfToken}
            errorFor={errorFor}
          />

          <ArubaSettingsSection
            aruba={aruba}
            arubaSaved={arubaSaved}
            inventory={arubaInventory}
            arubaPanelUrl={arubaPanelUrl}
            arubaBookmarkletUrl={arubaBookmarkletUrl}
            manualReadback={manualReadback}
            manualReadbackCompleted={arubaManualReadbackCompleted}
            canApprove={canApprove}
            csrfToken={csrfToken}
            errorFor={errorFor}
          />

          <section
            className="settings-section"
            id="email-cliente"
            aria-labelledby="email-cliente-title"
          >
            <SettingsSectionHeader
              id="email-cliente"
              icon={Mail}
              title={copy.settings.customerEmailTitle}
              intro={copy.settings.customerEmailHelp}
            />
            {customerEmailSaved ? (
              <p className="notice" role="status">
                {copy.settings.customerEmailSaved}
              </p>
            ) : null}
            <dl className="settings-facts-grid settings-facts-grid--three">
              <div>
                <dt>{copy.settings.smtpTransport}</dt>
                <dd>
                  {copy.settings.smtpTransportLabels[customerEmail.transport] ??
                    copy.common.unavailable}
                </dd>
              </div>
              <div>
                <dt>{copy.settings.smtpSender}</dt>
                <dd>{customerEmail.sender}</dd>
              </div>
              <div>
                <dt>{copy.settings.smtpStatus}</dt>
                <dd>
                  {customerEmail.configured
                    ? copy.settings.smtpConfigured
                    : copy.settings.smtpNotConfigured}
                </dd>
              </div>
            </dl>
            {canApprove ? (
              <SettingsForm
                className="settings-choice-card"
                key={customerEmail.version}
                submitLabel={copy.settings.customerEmailSave}
              >
                <input type="hidden" name="csrf" value={csrfToken} />
                <input type="hidden" name="intent" value="save-customer-email" />
                <input type="hidden" name="emailModeVersion" value={customerEmail.version} />
                <label className="settings-choice-card__field">
                  <span className="settings-choice-card__title">
                    {copy.settings.customerEmailMode}
                  </span>
                  <span className="field-help">{copy.settings.customerEmailModeHelp}</span>
                  <SettingsSelect
                    data-initial={customerEmail.mode}
                    defaultValue={customerEmail.mode}
                    name="customerEmailMode"
                  >
                    <option value="AUTOMATIC">{copy.settings.customerEmailAutomatic}</option>
                    <option value="MANUAL">{copy.settings.customerEmailManual}</option>
                    <option value="DISABLED">{copy.settings.customerEmailDisabled}</option>
                  </SettingsSelect>
                </label>
              </SettingsForm>
            ) : (
              <p>{copy.settings.customerEmailOwnerOnly}</p>
            )}
            {errorFor("save-customer-email") ? (
              <p className="error" role="alert">
                {errorFor("save-customer-email")}
              </p>
            ) : null}
          </section>

          <SystemSettingsSection environment={environment} system={system} />
        </div>
      </div>
    </AppShell>
  );
}
