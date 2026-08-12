import {
  CircleUserRound,
  FileCheck2,
  Landmark,
  LogOut,
  Mail,
  PlugZap,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { Form, useActionData, useLoaderData } from "react-router";

import { AppShell } from "../components/app-shell";
import {
  SettingsForm,
  SettingsNavigation,
  SettingsSectionHeader,
} from "../components/settings-controls";
import { ThemePicker } from "../components/theme-picker";
import { copy } from "../copy.it";
import { dateTime } from "../format";
import type { getAccountProfile } from "../../src/db/auth.server.ts";
import type { getArubaSettings } from "../../src/db/aruba.server.ts";
import type { connectionSummaries, latestEbayHistory } from "../../src/db/connectors.server.ts";
import { defaultHistoricalStartDate } from "../../src/orders.ts";
import type { getSystemStatus } from "../../src/db/system.server.ts";
import { action, loader } from "./settings.server.ts";

export { action, loader };

type ErrorFor = (...intents: string[]) => string | null;

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

      <div className="profile-overview">
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

      <div className="settings-subsection">
        <h3>{copy.settings.appearanceTitle}</h3>
        <ThemePicker />
      </div>

      <div className="settings-subsection">
        <h3>{copy.settings.passwordTitle}</h3>
        <p>{copy.settings.passwordHelp}</p>
        <Form method="post" className="security-form">
          <input type="hidden" name="csrf" value={csrfToken} />
          <input type="hidden" name="intent" value="change-password" />
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
          <label>
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
      </div>

      <div className="settings-subsection">
        <h3>{copy.settings.sessionsTitle}</h3>
        <p>{copy.settings.sessionsHelp}</p>
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
          <Form method="post">
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
          <p className="field-help">{copy.settings.noOtherSessions}</p>
        )}
      </div>

      <div className="settings-subsection settings-subsection--actions">
        <h3>{copy.settings.exitTitle}</h3>
        <Form method="post" action="/logout">
          <input type="hidden" name="csrf" value={csrfToken} />
          <button className="button button--secondary" type="submit">
            <LogOut aria-hidden="true" size={17} strokeWidth={1.8} />
            {copy.navigation.logout}
          </button>
        </Form>
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
          const label = provider === "SHOPIFY" ? "Shopify" : "eBay";
          const initialHistoryStart = connection
            ? ((historyProvider === provider ? historyStart : null) ??
              defaultHistoricalStartDate(Date.parse(connection.connectedAt)))
            : null;
          return (
            <section className="connection-panel" key={provider}>
              <header>
                <h3>{label}</h3>
                <span className="status">
                  {connection?.status === "CONNECTED"
                    ? copy.settings.connected
                    : copy.settings.notConnected}
                </span>
              </header>
              <dl className="facts">
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
              {connection?.lastErrorCode ? (
                <p className="error">
                  {copy.settings.connectionError(connection.lastErrorCode)}{" "}
                  <a href="/attivita">{copy.settings.openActivities}</a>
                </p>
              ) : null}
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
              {connection?.status === "CONNECTED" && !connection.historyImported ? (
                <Form method="post" className="settings-subsection">
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
                <p className="notice">{copy.settings.historyReady}</p>
              ) : null}
            </section>
          );
        })}
      </div>
    </section>
  );
}

function ArubaSettingsSection({
  aruba,
  arubaSaved,
  canApprove,
  csrfToken,
  errorFor,
}: {
  aruba: Awaited<ReturnType<typeof getArubaSettings>>;
  arubaSaved: boolean;
  canApprove: boolean;
  csrfToken: string;
  errorFor: ErrorFor;
}) {
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
      {aruba.automaticForcedAssisted ? (
        <p className="warning">{copy.settings.arubaKillSwitch}</p>
      ) : null}
      <dl className="facts facts--columns">
        <div>
          <dt>{copy.settings.arubaConfiguredMode}</dt>
          <dd>{copy.settings.arubaModeLabel(aruba.mode.value)}</dd>
        </div>
        <div>
          <dt>{copy.settings.arubaEffectiveMode}</dt>
          <dd>{copy.settings.arubaModeLabel(aruba.effectiveMode)}</dd>
        </div>
        <div>
          <dt>{copy.settings.helperLastSeen}</dt>
          <dd>
            {aruba.helper.lastSeenAt ? dateTime(aruba.helper.lastSeenAt) : copy.settings.never}
          </dd>
        </div>
        <div>
          <dt>{copy.settings.helperVersion}</dt>
          <dd>{aruba.helper.version ?? copy.common.unavailable}</dd>
        </div>
        <div>
          <dt>{copy.settings.helperBrowser}</dt>
          <dd>{aruba.helper.browser ?? copy.common.unavailable}</dd>
        </div>
        <div>
          <dt>{copy.settings.helperLastReadback}</dt>
          <dd>
            {aruba.helper.lastReadbackAt
              ? dateTime(aruba.helper.lastReadbackAt)
              : copy.settings.never}
          </dd>
        </div>
      </dl>
      {canApprove ? (
        <SettingsForm
          accessibleSubmitLabel={copy.settings.arubaSave}
          className="inline-form section-gap"
          key={`${aruba.mode.version}:${aruba.authProtection.version}`}
          submitLabel={copy.settings.saveShort}
        >
          <input type="hidden" name="csrf" value={csrfToken} />
          <input type="hidden" name="intent" value="save-aruba" />
          <input type="hidden" name="arubaModeVersion" value={aruba.mode.version} />
          <input type="hidden" name="arubaAuthVersion" value={aruba.authProtection.version} />
          <label>
            {copy.settings.arubaMode}
            <select
              data-initial={aruba.mode.value}
              defaultValue={aruba.mode.value}
              name="arubaMode"
            >
              <option value="ASSISTED">{copy.settings.arubaAssisted}</option>
              <option value="AUTOMATIC">{copy.settings.arubaAutomatic}</option>
            </select>
          </label>
          <label>
            {copy.settings.arubaAuthProtection}
            <select
              data-initial={aruba.authProtection.value}
              defaultValue={aruba.authProtection.value}
              name="arubaAuthProtection"
            >
              <option value="UNKNOWN">{copy.settings.arubaAuthUnknown}</option>
              <option value="TWO_FACTOR">{copy.settings.arubaTwoFactor}</option>
              <option value="SMS_PER_UPLOAD">{copy.settings.arubaSms}</option>
            </select>
          </label>
        </SettingsForm>
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
        <section className="system-group">
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
        <section className="system-group">
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
        <section className="system-group">
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

export default function Settings() {
  const {
    username,
    canApprove,
    csrfToken,
    profile,
    trigger,
    saved,
    connections,
    ebayHistory,
    historyStart,
    historyProvider,
    historyToday,
    imported,
    preview,
    aruba,
    arubaSaved,
    customerEmail,
    customerEmailSaved,
    fiscalProfile,
    environment,
    system,
    passwordChanged,
    sessionsRevoked,
  } = useLoaderData<typeof loader>();
  const actionError = useActionData<typeof action>();
  const errorFor = (...intents: string[]) =>
    actionError && intents.includes(actionError.intent) ? actionError.message : null;

  return (
    <AppShell username={username} canApprove={canApprove} csrfToken={csrfToken}>
      <div className="title-block">
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

          <section
            className="settings-section"
            id="fatturazione"
            aria-labelledby="fatturazione-title"
          >
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
              className="inline-form"
              key={trigger.version}
              submitLabel={copy.settings.save}
            >
              <input type="hidden" name="csrf" value={csrfToken} />
              <input type="hidden" name="intent" value="save-trigger" />
              <input type="hidden" name="version" value={trigger.version} />
              <label>
                {copy.settings.preparationLabel}
                <select data-initial={trigger.value} defaultValue={trigger.value} name="trigger">
                  <option value="PAID">{copy.settings.onPaid}</option>
                  <option value="FULFILLED">{copy.settings.onFulfilled}</option>
                </select>
              </label>
            </SettingsForm>
            {errorFor("save-trigger") ? (
              <p className="error" role="alert">
                {errorFor("save-trigger")}
              </p>
            ) : null}
            <p className="field-help">{copy.settings.preparationHelp}</p>
          </section>

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
              <dl className="facts facts--columns">
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
            <dl className="facts facts--columns">
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
                className="inline-form section-gap"
                key={customerEmail.version}
                submitLabel={copy.settings.customerEmailSave}
              >
                <input type="hidden" name="csrf" value={csrfToken} />
                <input type="hidden" name="intent" value="save-customer-email" />
                <input type="hidden" name="emailModeVersion" value={customerEmail.version} />
                <label>
                  {copy.settings.customerEmailMode}
                  <select
                    data-initial={customerEmail.mode}
                    defaultValue={customerEmail.mode}
                    name="customerEmailMode"
                  >
                    <option value="AUTOMATIC">{copy.settings.customerEmailAutomatic}</option>
                    <option value="MANUAL">{copy.settings.customerEmailManual}</option>
                  </select>
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
