import { AlertTriangle, CircleCheck, Landmark } from "lucide-react";
import { useState } from "react";
import { Form } from "react-router";

import type { getArubaSettings } from "../../../src/db/aruba.server.ts";
import type {
  getArubaApiConnectionStatus,
  getArubaApiCredentialIdentity,
  getArubaBackfillReadiness,
} from "../../../src/db/aruba-api-settings.server.ts";
import type { getArubaMonthlyTransmissionUsage } from "../../../src/db/aruba-api-outbound.server.ts";
import type { getArubaInventoryHealth } from "../../../src/db/aruba-inventory-health.server.ts";
import { copy } from "../../copy.it";
import { dateTime } from "../../format";
import { SettingsForm, SettingsSectionHeader, SettingsSelect } from "../settings-controls";
import type { ErrorFor } from "./settings-types";

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
  api,
  inventory,
  readiness,
}: {
  api: Awaited<ReturnType<typeof getArubaApiConnectionStatus>>;
  inventory: Awaited<ReturnType<typeof getArubaInventoryHealth>>;
  readiness: Awaited<ReturnType<typeof getArubaBackfillReadiness>>;
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
        <div>
          <dt>{copy.settings.arubaPotentialMatches}</dt>
          <dd>{inventory.potentialMatches}</dd>
        </div>
        <div>
          <dt>{copy.settings.arubaAmbiguousMatches}</dt>
          <dd>{inventory.ambiguous}</dd>
        </div>
        <div>
          <dt>{copy.settings.arubaBlockingConflicts}</dt>
          <dd>{inventory.conflicts}</dd>
        </div>
        <div>
          <dt>{copy.settings.arubaActionableFailures}</dt>
          <dd>{readiness.actionableFailures}</dd>
        </div>
        <div>
          <dt>{copy.settings.arubaHistoricalFailures}</dt>
          <dd>{readiness.historicalFailures}</dd>
        </div>
        <div>
          <dt>{copy.settings.arubaApiSafetyPause}</dt>
          <dd>
            {api.limits.cooldownUntil
              ? copy.settings.arubaApiSafetyPauseUntil(dateTime(api.limits.cooldownUntil))
              : copy.settings.arubaApiSafetyPauseInactive}
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

type ArubaApiCredentialIdentity = Awaited<ReturnType<typeof getArubaApiCredentialIdentity>>;

function useArubaCredentialForm({
  configured,
  credentialIdentity,
  hasError,
}: {
  configured: boolean;
  credentialIdentity: ArubaApiCredentialIdentity;
  hasError: boolean;
}) {
  const defaults = () => ({
    username: credentialIdentity?.username ?? "",
    expectedTaxId: credentialIdentity?.expectedTaxId ?? "",
  });
  const [credentialsOpen, setCredentialsOpen] = useState(!configured || hasError);
  const [credentialDraft, setCredentialDraft] = useState(defaults);
  const openCredentials = () => {
    setCredentialDraft(defaults());
    setCredentialsOpen(true);
  };
  const cancelCredentials = () => {
    setCredentialDraft(defaults());
    setCredentialsOpen(false);
  };
  return {
    cancelCredentials,
    credentialDraft,
    credentialsOpen,
    openCredentials,
    setCredentialDraft,
  };
}

function ArubaApiCredentials({
  canApprove,
  configured,
  credentialIdentity,
  csrfToken,
  hasError,
}: {
  canApprove: boolean;
  configured: boolean;
  credentialIdentity: ArubaApiCredentialIdentity;
  csrfToken: string;
  hasError: boolean;
}) {
  const {
    cancelCredentials,
    credentialDraft,
    credentialsOpen,
    openCredentials,
    setCredentialDraft,
  } = useArubaCredentialForm({ configured, credentialIdentity, hasError });

  if (!canApprove) return <p className="field-help">{copy.settings.arubaApiCodexHelp}</p>;
  if (configured && !credentialsOpen) {
    return (
      <div className="aruba-api-credentials-summary">
        <div>
          <h4>{copy.settings.arubaApiCredentialsTitle}</h4>
          <p>{copy.settings.arubaApiCredentialsConnected}</p>
        </div>
        <button className="button button--secondary" onClick={openCredentials} type="button">
          {copy.settings.arubaApiEditCredentials}
        </button>
      </div>
    );
  }

  return (
    <Form autoComplete="off" method="post" className="security-form aruba-api-credentials-form">
      <input type="hidden" name="csrf" value={csrfToken} />
      <input
        type="hidden"
        name="intent"
        value={configured ? "rotate-aruba-api" : "save-aruba-api"}
      />
      <header className="aruba-api-credentials-form__header">
        <h4>{copy.settings.arubaApiCredentialsTitle}</h4>
        <p>{copy.settings.arubaApiCredentialsHelp}</p>
      </header>
      <div className="field-with-help">
        <label htmlFor="aruba-api-username">{copy.settings.arubaApiUsername}</label>
        <input
          aria-describedby="aruba-api-username-help"
          autoCapitalize="none"
          autoComplete="new-password"
          id="aruba-api-username"
          name="arubaApiUsername"
          required
          spellCheck={false}
          type="text"
          value={credentialDraft.username}
          onChange={(event) => {
            const { value } = event.currentTarget;
            setCredentialDraft((current) => ({
              ...current,
              username: value,
            }));
          }}
          autoFocus={configured}
        />
        <p className="field-help" id="aruba-api-username-help">
          {copy.settings.arubaApiUsernameHelp}
        </p>
      </div>
      <div className="field-with-help">
        <label htmlFor="aruba-api-password">{copy.settings.arubaApiPassword}</label>
        <input
          aria-describedby="aruba-api-password-help aruba-api-secret-help"
          autoComplete="new-password"
          id="aruba-api-password"
          name="arubaApiPassword"
          required
          type="password"
          defaultValue=""
        />
        <p className="field-help" id="aruba-api-password-help">
          {copy.settings.arubaApiPasswordHelp}
        </p>
      </div>
      <div className="field-with-help">
        <label htmlFor="aruba-api-tax-id">{copy.settings.arubaApiExpectedTaxId}</label>
        <input
          aria-describedby="aruba-api-tax-id-help"
          autoCapitalize="characters"
          autoComplete="off"
          id="aruba-api-tax-id"
          name="arubaApiExpectedTaxId"
          required
          spellCheck={false}
          type="text"
          value={credentialDraft.expectedTaxId}
          onChange={(event) => {
            const { value } = event.currentTarget;
            setCredentialDraft((current) => ({
              ...current,
              expectedTaxId: value,
            }));
          }}
        />
        <p className="field-help" id="aruba-api-tax-id-help">
          {copy.settings.arubaApiExpectedTaxIdHelp}
        </p>
      </div>
      <div className="aruba-api-credentials-form__actions">
        <p className="field-help" id="aruba-api-secret-help">
          {copy.settings.arubaApiSecretHelp}
        </p>
        <div className="aruba-api-credentials-form__buttons">
          {configured ? (
            <button className="button button--secondary" onClick={cancelCredentials} type="button">
              {copy.settings.arubaApiCancelCredentials}
            </button>
          ) : null}
          <button className="button" type="submit">
            {configured
              ? copy.settings.arubaApiRotateCredentials
              : copy.settings.arubaApiSaveCredentials}
          </button>
        </div>
      </div>
    </Form>
  );
}

type ArubaApiStatus = Awaited<ReturnType<typeof getArubaApiConnectionStatus>>;

function arubaApiStatusLabel(api: ArubaApiStatus) {
  if (!api.configured) return copy.settings.arubaApiNotConfigured;
  if (api.apiPaused) return copy.settings.arubaApiPaused;
  if (api.status === "CONNECTED") return copy.settings.arubaApiRunning;
  if (api.status === "REAUTH_REQUIRED") return copy.settings.arubaApiAttention;
  return copy.settings.arubaApiBlocked;
}

function ArubaApiFacts({ api }: { api: ArubaApiStatus }) {
  return (
    <dl className="settings-facts-grid settings-facts-grid--three aruba-api-facts">
      <div>
        <dt>{copy.settings.arubaApiStatus}</dt>
        <dd className="aruba-api-fact">
          <span>{arubaApiStatusLabel(api)}</span>
          <small>
            {api.credentialsVerifiedAt
              ? `${copy.settings.arubaApiIdentityVerified}: ${dateTime(api.credentialsVerifiedAt)}`
              : copy.settings.arubaApiIdentityNotVerified}
          </small>
        </dd>
      </div>
      <div>
        <dt>{copy.settings.arubaApiAuthority}</dt>
        <dd>{copy.settings.arubaApiAuthorityApi}</dd>
      </div>
      <div>
        <dt>{copy.settings.arubaApiBackfill}</dt>
        <dd className="aruba-api-fact">
          <span>
            {api.lastFullSyncAt
              ? copy.settings.arubaApiBackfillComplete
              : api.latestRun?.progress
                ? copy.settings.arubaApiBackfillRunning(api.latestRun.progress.percent)
                : copy.settings.arubaApiBackfillPending}
          </span>
          {api.latestRun?.progress ? (
            <>
              <progress
                aria-label={copy.settings.arubaApiBackfillProgressLabel}
                className="aruba-api-progress"
                max={100}
                value={api.latestRun.progress.percent}
              />
              <small>
                {copy.settings.arubaApiBackfillCoveredThrough(
                  dateTime(api.latestRun.progress.coveredThrough),
                )}
              </small>
              <small>
                {copy.settings.arubaApiBackfillRemaining(
                  api.latestRun.progress.remainingWindows,
                  api.latestRun.progress.estimatedRemainingMinutes,
                )}
              </small>
            </>
          ) : null}
        </dd>
      </div>
      <div>
        <dt>{copy.settings.arubaApiLatestRun}</dt>
        <dd className="aruba-api-fact">
          {api.latestRun ? (
            <>
              <span>
                {copy.settings.arubaApiRunKinds[api.latestRun.kind]} ·{" "}
                {copy.settings.arubaApiRunStatuses[api.latestRun.status]}
              </span>
              <small>
                {copy.settings.arubaApiRunCounts(
                  api.latestRun.documents,
                  api.latestRun.files,
                  api.latestRun.notifications,
                )}
              </small>
              <small>
                {copy.settings.arubaApiRunRequests(
                  api.latestRun.requests,
                  api.latestRun.requestLimit,
                )}
              </small>
              <small>
                {copy.settings.arubaApiCheckpoint}:{" "}
                {copy.settings.arubaApiCheckpointValue(
                  dateTime(api.latestRun.checkpointEnd),
                  api.latestRun.checkpointPage,
                )}
              </small>
            </>
          ) : (
            <>
              <span>{copy.settings.never}</span>
              <small>
                {copy.settings.arubaApiCheckpoint}: {copy.settings.never}
              </small>
            </>
          )}
        </dd>
      </div>
      <div>
        <dt>{copy.settings.arubaApiLimits}</dt>
        <dd>
          {copy.settings.arubaApiLimitValue(
            api.limits.inventoryRequestsPerMinute,
            api.limits.notificationRequestsPerMinute,
          )}
          {api.limits.cooldownUntil ? (
            <small className="aruba-api-limit-warning">
              {copy.settings.arubaApiSafetyPauseUntil(dateTime(api.limits.cooldownUntil))}
            </small>
          ) : null}
        </dd>
      </div>
    </dl>
  );
}

function ArubaApiControls({
  api,
  canApprove,
  csrfToken,
}: {
  api: ArubaApiStatus;
  canApprove: boolean;
  csrfToken: string;
}) {
  const syncEnabled = api.configured && api.inboundEnabled && !api.apiPaused;
  return (
    <>
      {api.configured && canApprove ? (
        <Form method="post" className="aruba-api-controls">
          <input type="hidden" name="csrf" value={csrfToken} />
          <input type="hidden" name="intent" value="controls-aruba-api" />
          <div className="aruba-api-controls__options">
            <label className="aruba-api-toggle">
              <input
                defaultChecked={api.apiPaused}
                name="arubaApiPaused"
                type="checkbox"
                value="true"
              />
              <span>{copy.settings.arubaApiPauseControl}</span>
            </label>
            <label className="aruba-api-toggle">
              <input
                defaultChecked={api.inboundEnabled}
                name="arubaApiInboundEnabled"
                type="checkbox"
                value="true"
              />
              <span>{copy.settings.arubaApiInboundControl}</span>
            </label>
          </div>
          <input name="arubaApiPaused" type="hidden" value="false" />
          <input name="arubaApiInboundEnabled" type="hidden" value="false" />
          <div className="aruba-api-controls__actions">
            <button className="button button--secondary" type="submit">
              {copy.settings.arubaApiSaveControls}
            </button>
            {syncEnabled ? (
              <button className="button" form="aruba-api-sync-form" type="submit">
                {copy.settings.arubaApiSyncNow}
              </button>
            ) : null}
          </div>
        </Form>
      ) : null}
      {syncEnabled ? (
        <Form
          method="post"
          className={canApprove ? "aruba-api-sync-form" : "aruba-api-sync-action"}
          id="aruba-api-sync-form"
        >
          <input type="hidden" name="csrf" value={csrfToken} />
          <input type="hidden" name="intent" value="sync-aruba-api" />
          {!canApprove ? (
            <button className="button" type="submit">
              {copy.settings.arubaApiSyncNow}
            </button>
          ) : null}
        </Form>
      ) : null}
      {api.configured && canApprove ? (
        <Form method="post" className="aruba-api-revoke">
          <input type="hidden" name="csrf" value={csrfToken} />
          <input type="hidden" name="intent" value="revoke-aruba-api" />
          <label className="aruba-api-toggle aruba-api-toggle--revoke">
            <input name="confirmRevoke" required type="checkbox" value="yes" />
            <span>{copy.settings.arubaApiRevokeConfirmation}</span>
          </label>
          <button className="button button--warning" type="submit">
            {copy.settings.arubaApiRevoke}
          </button>
        </Form>
      ) : null}
    </>
  );
}

function ArubaApiSettingsCard({
  api,
  credentialIdentity,
  notice,
  canApprove,
  csrfToken,
  errorFor,
}: {
  api: Awaited<ReturnType<typeof getArubaApiConnectionStatus>>;
  credentialIdentity: ArubaApiCredentialIdentity;
  notice: string | null;
  canApprove: boolean;
  csrfToken: string;
  errorFor: ErrorFor;
}) {
  const credentialsError = errorFor("save-aruba-api", "rotate-aruba-api");
  const apiError = errorFor(
    "save-aruba-api",
    "rotate-aruba-api",
    "revoke-aruba-api",
    "controls-aruba-api",
    "sync-aruba-api",
  );
  return (
    <section
      className="settings-inset-card aruba-api-card"
      id="aruba-api"
      aria-labelledby="aruba-api-title"
    >
      <header>
        <h3 id="aruba-api-title">{copy.settings.arubaApiTitle}</h3>
        <p>{copy.settings.arubaApiHelp}</p>
      </header>
      {notice ? (
        <p className="notice" role="status">
          {copy.settings.arubaApiSavedNotice}
        </p>
      ) : null}
      <ArubaApiFacts api={api} />
      <ArubaApiCredentials
        canApprove={canApprove}
        configured={api.configured}
        credentialIdentity={credentialIdentity}
        csrfToken={csrfToken}
        hasError={Boolean(credentialsError)}
      />
      <ArubaApiControls api={api} canApprove={canApprove} csrfToken={csrfToken} />
      {apiError ? (
        <p className="error" role="alert">
          {apiError}
        </p>
      ) : null}
    </section>
  );
}

type ArubaSettings = Awaited<ReturnType<typeof getArubaSettings>>;
type ArubaInventory = Awaited<ReturnType<typeof getArubaInventoryHealth>>;
type ArubaMonthlyUsage = Awaited<ReturnType<typeof getArubaMonthlyTransmissionUsage>>;

function arubaConnectionPresentation(inventory: ArubaInventory) {
  const state = inventory.activeSession
    ? "ACTIVE"
    : inventory.blockingReason === "CONFLICT"
      ? "CONFLICT"
      : inventory.blocking
        ? "ATTENTION"
        : "READY";
  const text = {
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
  }[state];
  return {
    Icon: state === "ATTENTION" || state === "CONFLICT" ? AlertTriangle : CircleCheck,
    state,
    ...text,
  };
}

function ArubaSettingsNotices({
  aruba,
  arubaSaved,
  manualReadbackCompleted,
}: {
  aruba: ArubaSettings;
  arubaSaved: boolean;
  manualReadbackCompleted: boolean;
}) {
  return (
    <>
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
      {aruba.transmissionForcedDocumentOnly ? (
        <p className="warning">{copy.settings.arubaKillSwitch}</p>
      ) : null}
    </>
  );
}

function ArubaSyncStatus({ inventory }: { inventory: ArubaInventory }) {
  const { Icon, state, title, description } = arubaConnectionPresentation(inventory);
  return (
    <section className="aruba-sync-card" aria-labelledby="aruba-sync-status-title">
      <div className="aruba-sync-card__status">
        <span className={`aruba-sync-card__icon aruba-sync-card__icon--${state.toLowerCase()}`}>
          <Icon aria-hidden="true" size={22} strokeWidth={1.8} />
        </span>
        <div>
          <p className="aruba-sync-card__eyebrow">{copy.settings.arubaSyncTitle}</p>
          <h3 id="aruba-sync-status-title">{title}</h3>
          <p>{description}</p>
          <p className="aruba-sync-card__updated">
            {copy.settings.arubaLastUpdate(
              inventory.lastCompletedAt ? dateTime(inventory.lastCompletedAt) : copy.settings.never,
            )}
          </p>
        </div>
      </div>
    </section>
  );
}

function ArubaMonthlyUsageCard({ usage }: { usage: ArubaMonthlyUsage }) {
  return (
    <section
      className="settings-inset-card aruba-monthly-usage-card"
      aria-labelledby="aruba-monthly-usage-title"
    >
      <h3 id="aruba-monthly-usage-title">{copy.settings.arubaMonthlyUsageTitle}</h3>
      <p>{copy.settings.arubaMonthlyUsage(usage.accepted)}</p>
      {usage.warning ? (
        <p className="warning" role="status">
          {copy.settings.arubaMonthlyWarning(usage.warning, usage.remaining)}
        </p>
      ) : null}
    </section>
  );
}

function ArubaTransmissionSettings({
  aruba,
  canApprove,
  csrfToken,
  errorFor,
}: {
  aruba: ArubaSettings;
  canApprove: boolean;
  csrfToken: string;
  errorFor: ErrorFor;
}) {
  const error = errorFor("save-aruba");
  return (
    <>
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
                <option value="DOCUMENT_ONLY">{copy.settings.arubaDocumentOnly}</option>
                <option value="CONTEXTUAL_CONFIRMATION">
                  {copy.settings.arubaContextualConfirmation}
                </option>
                <option value="AUTOMATIC_AFTER_APPROVAL">
                  {copy.settings.arubaAutomaticAfterApproval}
                </option>
              </SettingsSelect>
            </label>
          </SettingsForm>
        </section>
      ) : (
        <p>{copy.settings.arubaOwnerOnly}</p>
      )}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

export function ArubaSettingsSection({
  aruba,
  arubaSaved,
  inventory,
  manualReadback,
  manualReadbackCompleted,
  canApprove,
  csrfToken,
  errorFor,
  arubaApi,
  arubaApiCredentialIdentity,
  arubaApiNotice,
  arubaBackfillReadiness,
  arubaMonthlyUsage,
}: {
  aruba: Awaited<ReturnType<typeof getArubaSettings>>;
  arubaSaved: boolean;
  inventory: Awaited<ReturnType<typeof getArubaInventoryHealth>>;
  manualReadback?: ManualReadbackData | null;
  manualReadbackCompleted: boolean;
  canApprove: boolean;
  csrfToken: string;
  errorFor: ErrorFor;
  arubaApi: Awaited<ReturnType<typeof getArubaApiConnectionStatus>>;
  arubaApiCredentialIdentity: Awaited<ReturnType<typeof getArubaApiCredentialIdentity>>;
  arubaApiNotice: string | null;
  arubaBackfillReadiness: Awaited<ReturnType<typeof getArubaBackfillReadiness>>;
  arubaMonthlyUsage: Awaited<ReturnType<typeof getArubaMonthlyTransmissionUsage>>;
}) {
  return (
    <section className="settings-section" id="aruba" aria-labelledby="aruba-title">
      <SettingsSectionHeader
        id="aruba"
        icon={Landmark}
        title={copy.settings.arubaTitle}
        intro={copy.settings.arubaHelp}
      />
      <ArubaSettingsNotices
        aruba={aruba}
        arubaSaved={arubaSaved}
        manualReadbackCompleted={manualReadbackCompleted}
      />
      <div className="aruba-settings-stack">
        <ArubaApiSettingsCard
          api={arubaApi}
          credentialIdentity={arubaApiCredentialIdentity}
          canApprove={canApprove}
          csrfToken={csrfToken}
          errorFor={errorFor}
          notice={arubaApiNotice}
        />
        <ArubaSyncStatus inventory={inventory} />
        <ArubaInventoryCard inventory={inventory} />
        <ArubaConnectionDetails
          api={arubaApi}
          inventory={inventory}
          readiness={arubaBackfillReadiness}
        />
        <ArubaMonthlyUsageCard usage={arubaMonthlyUsage} />
        {canApprove && inventory.blocking ? (
          <ArubaManualRecovery
            csrfToken={csrfToken}
            errorFor={errorFor}
            manualReadback={manualReadback}
          />
        ) : null}
        <ArubaTransmissionSettings
          aruba={aruba}
          canApprove={canApprove}
          csrfToken={csrfToken}
          errorFor={errorFor}
        />
      </div>
    </section>
  );
}
