import { FileCheck2, Mail } from "lucide-react";
import { useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/settings";

import { AppShell } from "../components/app-shell";
import { ArubaSettingsSection } from "../components/settings/aruba-settings-section";
import { BillingSettingsSection } from "../components/settings/billing-settings-section";
import { ConnectionsSettingsSection } from "../components/settings/connections-settings-section";
import { ProfileSettingsSection } from "../components/settings/profile-settings-section";
import { SystemSettingsSection } from "../components/settings/system-settings-section";
import {
  SettingsForm,
  SettingsNavigation,
  SettingsSelect,
  SettingsSectionHeader,
} from "../components/settings-controls";
import { copy } from "../copy.it";
import { dateTime } from "../format";
import { privateRouteMeta } from "../metadata";
import { action, loader } from "./settings.server.ts";

export { action, loader };

export function meta({ error }: Route.MetaArgs) {
  return privateRouteMeta("settings", { error });
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
    arubaApi,
    arubaApiCredentialIdentity,
    arubaApiNotice,
    arubaBackfillReadiness,
    arubaMonthlyUsage,
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
            arubaApi={arubaApi}
            arubaApiCredentialIdentity={arubaApiCredentialIdentity}
            arubaApiNotice={arubaApiNotice}
            arubaBackfillReadiness={arubaBackfillReadiness}
            arubaMonthlyUsage={arubaMonthlyUsage}
            arubaSaved={arubaSaved}
            inventory={arubaInventory}
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
