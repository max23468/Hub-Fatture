import {
  CircleUserRound,
  FileCheck2,
  Landmark,
  LogOut,
  Mail,
  PlugZap,
  Settings2,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { data, Form, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/settings";

import { AppShell } from "../components/app-shell";
import { ThemePicker } from "../components/theme-picker";
import { copy } from "../copy.it";
import { dateTime } from "../format";
import {
  assertCsrf,
  changePassword,
  getAccountProfile,
  requestId,
  requireSessionUser,
  revokeOtherSessions,
} from "../../src/db/auth.server.ts";
import { getArubaSettings, setArubaSettings } from "../../src/db/aruba.server.ts";
import { getConfig } from "../../src/config.server.ts";
import {
  connectionSummaries,
  enqueueEbayPreview,
  latestEbayPreview,
} from "../../src/db/connectors.server.ts";
import { getFiscalProfileSettings } from "../../src/db/documents.server.ts";
import { getCustomerEmailSettings, setCustomerEmailMode } from "../../src/db/email.server.ts";
import { publicError } from "../../src/errors.ts";
import { readForm } from "../../src/http.server.ts";
import { previewShopifyHistory } from "../../src/integrations/shopify.server.ts";
import { getDraftTrigger, setDraftTrigger } from "../../src/db/orders.server.ts";
import { getSystemStatus } from "../../src/db/system.server.ts";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const url = new URL(request.url);
  const [profile, trigger, connections, ebayPreview, aruba, customerEmail, fiscalProfile, system] =
    await Promise.all([
      getAccountProfile(request, user),
      getDraftTrigger(),
      connectionSummaries(),
      latestEbayPreview(),
      getArubaSettings(),
      getCustomerEmailSettings(),
      getFiscalProfileSettings(),
      getSystemStatus(),
    ]);
  return {
    username: user.username,
    canApprove: user.canApprove,
    csrfToken: user.csrfToken,
    profile,
    trigger,
    saved: url.searchParams.get("trigger") === "salvato",
    connections,
    ebayPreview,
    aruba,
    arubaSaved: url.searchParams.get("aruba") === "salvata",
    customerEmail,
    customerEmailSaved: url.searchParams.get("email") === "salvata",
    fiscalProfile,
    environment: getConfig().APP_ENV,
    system,
    passwordChanged: url.searchParams.get("profilo") === "password",
    sessionsRevoked: url.searchParams.get("profilo") === "sessioni",
    preview:
      url.searchParams.get("provider") && url.searchParams.get("count")
        ? {
            provider: url.searchParams.get("provider")!,
            count: url.searchParams.get("count")!,
            review: url.searchParams.get("review") ?? "0",
          }
        : null,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireSessionUser(request);
  const form = await readForm(request);
  const intent = form.get("intent") ?? "save-trigger";
  try {
    assertCsrf(user, form.get("csrf") ?? "");
    if (intent === "change-password") {
      await changePassword(
        request,
        {
          currentPassword: form.get("currentPassword"),
          newPassword: form.get("newPassword"),
          confirmation: form.get("passwordConfirmation"),
        },
        user,
        requestId(request),
      );
      return redirect("/impostazioni?profilo=password#profilo-sicurezza");
    }
    if (intent === "revoke-other-sessions") {
      await revokeOtherSessions(request, user, requestId(request));
      return redirect("/impostazioni?profilo=sessioni#profilo-sicurezza");
    }
    if (intent === "save-customer-email") {
      await setCustomerEmailMode(form.get("customerEmailMode"), form.get("emailModeVersion"), {
        id: user.id,
        canApprove: user.canApprove,
        requestId: requestId(request),
      });
      return redirect("/impostazioni?email=salvata#email-cliente");
    }
    if (intent === "save-aruba") {
      await setArubaSettings(
        {
          mode: form.get("arubaMode"),
          modeVersion: form.get("arubaModeVersion"),
          authProtection: form.get("arubaAuthProtection"),
          authVersion: form.get("arubaAuthVersion"),
        },
        { id: user.id, canApprove: user.canApprove, requestId: requestId(request) },
      );
      return redirect("/impostazioni?aruba=salvata#aruba-helper");
    }
    if (intent === "preview-ebay") {
      await enqueueEbayPreview();
      return redirect("/impostazioni?ebayPreview=avviata#connessioni");
    }
    if (intent === "preview-shopify") {
      const provider = "Shopify";
      const preview = await previewShopifyHistory();
      return redirect(
        "/impostazioni?" +
          new URLSearchParams({
            provider,
            count: String(preview.count),
            review: String(preview.reviewRequired),
          }).toString() +
          "#connessioni",
      );
    }
    if (intent !== "save-trigger") {
      throw new Response("Azione non supportata", { status: 400 });
    }
    await setDraftTrigger(form.get("trigger"), Number(form.get("version") ?? Number.NaN), {
      id: user.id,
      requestId: requestId(request),
    });
    return redirect("/impostazioni?trigger=salvato#fatturazione");
  } catch (error) {
    if (error instanceof Response) throw error;
    const result = publicError(error);
    return data({ ...result, intent }, { status: result.status });
  }
}

const sections: Array<{ id: string; label: string; icon: LucideIcon }> = [
  { id: "profilo-sicurezza", label: copy.settings.profileTitle, icon: CircleUserRound },
  { id: "fatturazione", label: copy.settings.billingTitle, icon: Settings2 },
  { id: "profilo-fiscale", label: copy.settings.fiscalTitle, icon: FileCheck2 },
  { id: "connessioni", label: copy.settings.connectionsTitle, icon: PlugZap },
  { id: "aruba-helper", label: copy.settings.arubaTitle, icon: Landmark },
  { id: "email-cliente", label: copy.settings.customerEmailTitle, icon: Mail },
  { id: "sistema", label: copy.settings.systemTitle, icon: ShieldCheck },
];

function SettingsNavigation() {
  const [active, setActive] = useState(sections[0]!.id);

  useEffect(() => {
    if (window.location.hash) setActive(window.location.hash.slice(1));
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.find((entry) => entry.isIntersecting);
        if (visible) setActive(visible.target.id);
      },
      { rootMargin: "-15% 0px -70%" },
    );
    for (const { id } of sections) {
      const section = document.getElementById(id);
      if (section) observer.observe(section);
    }
    return () => observer.disconnect();
  }, []);

  const selectSection = (id: string) => {
    setActive(id);
    window.history.replaceState(null, "", `#${id}`);
    document.getElementById(id)?.scrollIntoView();
  };

  return (
    <>
      <label className="settings-section-picker">
        {copy.settings.goToSection}
        <select value={active} onChange={(event) => selectSection(event.currentTarget.value)}>
          {sections.map(({ id, label }) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <nav className="settings-nav" aria-label={copy.settings.sectionsLabel}>
        {sections.map(({ id, label, icon: Icon }) => (
          <a
            aria-current={active === id ? "location" : undefined}
            className="settings-nav__item"
            href={`#${id}`}
            key={id}
            onClick={() => setActive(id)}
          >
            <Icon aria-hidden="true" size={18} strokeWidth={1.8} />
            {label}
          </a>
        ))}
      </nav>
    </>
  );
}

function SettingsForm({
  accessibleSubmitLabel,
  children,
  className,
  submitLabel,
}: {
  accessibleSubmitLabel?: string;
  children: ReactNode;
  className: string;
  submitLabel: string;
}) {
  const [dirty, setDirty] = useState(false);
  const updateDirty = (event: FormEvent<HTMLFormElement>) => {
    setDirty(
      Array.from(event.currentTarget.elements).some(
        (element) =>
          element instanceof HTMLSelectElement &&
          element.dataset.initial !== undefined &&
          element.value !== element.dataset.initial,
      ),
    );
  };

  return (
    <Form method="post" className={className} onChange={updateDirty}>
      {children}
      <button aria-label={accessibleSubmitLabel} className="button" disabled={!dirty} type="submit">
        {submitLabel}
      </button>
    </Form>
  );
}

function SectionHeader({
  id,
  icon: Icon,
  title,
  intro,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  intro: string;
}) {
  return (
    <header className="settings-section__header">
      <span className="settings-section__icon" aria-hidden="true">
        <Icon size={20} strokeWidth={1.8} />
      </span>
      <div>
        <h2 id={id + "-title"}>{title}</h2>
        <p>{intro}</p>
      </div>
    </header>
  );
}

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
      <SectionHeader
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
  ebayPreview,
  preview,
  csrfToken,
  errorFor,
}: {
  connections: Awaited<ReturnType<typeof connectionSummaries>>;
  ebayPreview: Awaited<ReturnType<typeof latestEbayPreview>>;
  preview: { provider: string; count: string; review: string } | null;
  csrfToken: string;
  errorFor: ErrorFor;
}) {
  const byProvider = new Map(connections.map((connection) => [connection.provider, connection]));
  return (
    <section className="settings-section" id="connessioni" aria-labelledby="connessioni-title">
      <SectionHeader
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
      {ebayPreview ? (
        <p className="notice" role="status">
          {copy.settings.ebayPreviewStatus(
            ebayPreview.status,
            ebayPreview.count,
            ebayPreview.reviewRequired,
            ebayPreview.errorCode,
          )}
        </p>
      ) : null}
      {errorFor("preview-shopify", "preview-ebay") ? (
        <p className="error" role="alert">
          {errorFor("preview-shopify", "preview-ebay")}
        </p>
      ) : null}
      <div className="connection-grid">
        {(["SHOPIFY", "EBAY"] as const).map((provider) => {
          const connection = byProvider.get(provider);
          const label = provider === "SHOPIFY" ? "Shopify" : "eBay";
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
                {connection?.status === "CONNECTED" ? (
                  <Form method="post">
                    <input type="hidden" name="csrf" value={csrfToken} />
                    <input
                      type="hidden"
                      name="intent"
                      value={provider === "SHOPIFY" ? "preview-shopify" : "preview-ebay"}
                    />
                    <button className="button button--secondary" type="submit">
                      {copy.settings.preview}
                    </button>
                  </Form>
                ) : null}
              </div>
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
      <SectionHeader
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
      <SectionHeader
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
    ebayPreview,
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
            <SectionHeader
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
            <SectionHeader
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
            ebayPreview={ebayPreview}
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
            <SectionHeader
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
