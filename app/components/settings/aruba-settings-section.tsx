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
import { SettingsSectionHeader } from "../settings-controls";
import { ArubaAccountCard } from "./aruba-account-card";
import { ArubaTransmissionSettings } from "./aruba-transmission-settings";
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
    <div className="aruba-inventory-card" role="group" aria-labelledby="aruba-inventory-title">
      <header>
        <h4 id="aruba-inventory-title">{copy.settings.arubaInventoryTitle}</h4>
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
    </div>
  );
}

function ArubaConnectionDetails({
  api,
  canApprove,
  csrfToken,
  inventory,
  readiness,
}: {
  api: Awaited<ReturnType<typeof getArubaApiConnectionStatus>>;
  canApprove: boolean;
  csrfToken: string;
  inventory: Awaited<ReturnType<typeof getArubaInventoryHealth>>;
  readiness: Awaited<ReturnType<typeof getArubaBackfillReadiness>>;
}) {
  return (
    <details className="settings-disclosure aruba-connection-details">
      <summary>{copy.settings.arubaConnectionDetails}</summary>
      <div className="aruba-connection-details__content">
        <ArubaApiFacts api={api} />
        <ArubaInventoryCard inventory={inventory} />
        <dl className="aruba-diagnostic-list">
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
        </dl>
        <ArubaApiControls api={api} canApprove={canApprove} csrfToken={csrfToken} />
      </div>
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
    <dl className="aruba-api-facts">
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
  if (!api.configured || !canApprove) return null;
  return (
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
      </div>
    </Form>
  );
}

function ArubaApiSyncAction({ api, csrfToken }: { api: ArubaApiStatus; csrfToken: string }) {
  const syncEnabled = api.configured && api.inboundEnabled && !api.apiPaused;
  if (!syncEnabled) return null;
  return (
    <Form method="post" className="aruba-api-sync-action">
      <input type="hidden" name="csrf" value={csrfToken} />
      <input type="hidden" name="intent" value="sync-aruba-api" />
      <button className="button" type="submit">
        {copy.settings.arubaApiSyncNow}
      </button>
    </Form>
  );
}

function ArubaApiRevoke({ csrfToken }: { csrfToken: string }) {
  return (
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
  );
}

function ArubaApiSettingsCard({
  api,
  credentialIdentity,
  inventory,
  manualReadback,
  monthlyUsage,
  notice,
  canApprove,
  csrfToken,
  errorFor,
}: {
  api: Awaited<ReturnType<typeof getArubaApiConnectionStatus>>;
  credentialIdentity: ArubaApiCredentialIdentity;
  inventory: ArubaInventory;
  manualReadback?: ManualReadbackData | null;
  monthlyUsage: Awaited<ReturnType<typeof getArubaMonthlyTransmissionUsage>>;
  notice: string | null;
  canApprove: boolean;
  csrfToken: string;
  errorFor: ErrorFor;
}) {
  const credentialsError = errorFor("save-aruba-api", "rotate-aruba-api");
  const apiError = errorFor("save-aruba-api");
  return (
    <section
      className="aruba-section-card aruba-api-card"
      id="aruba-api"
      aria-labelledby="aruba-api-title"
    >
      <div className="aruba-api-card__grid">
        <section className="aruba-connection-panel" aria-labelledby="aruba-api-title">
          <header className="aruba-section-card__header">
            <div>
              <h3 id="aruba-api-title">{copy.settings.arubaConnectionBlockTitle}</h3>
            </div>
            <span
              className={`settings-status settings-status--${api.configured && api.status === "CONNECTED" && !api.apiPaused ? "success" : "neutral"}`}
            >
              {arubaApiStatusLabel(api)}
            </span>
          </header>
          {notice ? (
            <p className="notice" role="status">
              {copy.settings.arubaApiSavedNotice}
            </p>
          ) : null}
          <p className="aruba-connection-environment">
            <span>{copy.settings.arubaApiEnvironment}</span>
            <strong>
              {credentialIdentity?.apiEnvironment === "PRODUCTION"
                ? copy.settings.arubaApiEnvironmentProduction
                : credentialIdentity?.apiEnvironment === "DEMO"
                  ? copy.settings.arubaApiEnvironmentDemo
                  : copy.common.unavailable}
            </strong>
          </p>
          {!api.configured ? (
            <ArubaApiCredentials
              canApprove={canApprove}
              configured={api.configured}
              credentialIdentity={credentialIdentity}
              csrfToken={csrfToken}
              hasError={Boolean(credentialsError)}
            />
          ) : null}
          {api.configured && canApprove ? (
            <details className="settings-disclosure aruba-connection-management">
              <summary>{copy.settings.arubaManageConnection}</summary>
              <div className="aruba-connection-management__content">
                <ArubaApiCredentials
                  canApprove={canApprove}
                  configured
                  credentialIdentity={credentialIdentity}
                  csrfToken={csrfToken}
                  hasError={Boolean(credentialsError)}
                />
                {inventory.blocking ? (
                  <ArubaManualRecovery
                    csrfToken={csrfToken}
                    errorFor={errorFor}
                    manualReadback={manualReadback}
                  />
                ) : null}
                <ArubaApiRevoke csrfToken={csrfToken} />
              </div>
            </details>
          ) : null}
          {apiError ? (
            <p className="error" role="alert">
              {apiError}
            </p>
          ) : null}
        </section>
        <ArubaAccountCard api={api} usage={monthlyUsage} />
      </div>
    </section>
  );
}

type ArubaSettings = Awaited<ReturnType<typeof getArubaSettings>>;
type ArubaInventory = Awaited<ReturnType<typeof getArubaInventoryHealth>>;

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

function ArubaSyncStatus({
  api,
  csrfToken,
  inventory,
}: {
  api: ArubaApiStatus;
  csrfToken: string;
  inventory: ArubaInventory;
}) {
  const { Icon, state, title, description } = arubaConnectionPresentation(inventory);
  return (
    <div className="aruba-sync-card" role="group" aria-labelledby="aruba-sync-status-title">
      <div className="aruba-sync-card__status">
        <span className={`aruba-sync-card__icon aruba-sync-card__icon--${state.toLowerCase()}`}>
          <Icon aria-hidden="true" size={22} strokeWidth={1.8} />
        </span>
        <div>
          <h4 id="aruba-sync-status-title">{title}</h4>
          <p>{description}</p>
          <p className="aruba-sync-card__updated">
            {copy.settings.arubaLastUpdate(
              inventory.lastCompletedAt ? dateTime(inventory.lastCompletedAt) : copy.settings.never,
            )}
          </p>
        </div>
      </div>
      <ArubaApiSyncAction api={api} csrfToken={csrfToken} />
    </div>
  );
}

function ArubaSynchronizationCard({
  api,
  canApprove,
  csrfToken,
  errorFor,
  inventory,
  readiness,
}: {
  api: ArubaApiStatus;
  canApprove: boolean;
  csrfToken: string;
  errorFor: ErrorFor;
  inventory: ArubaInventory;
  readiness: Awaited<ReturnType<typeof getArubaBackfillReadiness>>;
}) {
  const synchronizationError = errorFor("controls-aruba-api", "sync-aruba-api");
  return (
    <section
      className="aruba-section-card aruba-synchronization-card"
      id="aruba-synchronization"
      aria-labelledby="aruba-synchronization-title"
    >
      <header className="aruba-section-card__header">
        <div>
          <h3 id="aruba-synchronization-title">{copy.settings.arubaSyncBlockTitle}</h3>
        </div>
      </header>
      <ArubaSyncStatus api={api} csrfToken={csrfToken} inventory={inventory} />
      {synchronizationError ? (
        <p className="error" role="alert">
          {synchronizationError}
        </p>
      ) : null}
      <ArubaConnectionDetails
        api={api}
        canApprove={canApprove}
        csrfToken={csrfToken}
        inventory={inventory}
        readiness={readiness}
      />
    </section>
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
          inventory={inventory}
          manualReadback={manualReadback}
          monthlyUsage={arubaMonthlyUsage}
          canApprove={canApprove}
          csrfToken={csrfToken}
          errorFor={errorFor}
          notice={arubaApiNotice}
        />
        <ArubaSynchronizationCard
          api={arubaApi}
          canApprove={canApprove}
          csrfToken={csrfToken}
          errorFor={errorFor}
          inventory={inventory}
          readiness={arubaBackfillReadiness}
        />
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
