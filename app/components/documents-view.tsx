import {
  ArrowRight,
  CircleAlert,
  Download,
  FileCheck2,
  FileClock,
  FileText,
  Layers3,
  Mail,
  ReceiptText,
  RefreshCw,
  Upload,
} from "lucide-react";
import { Form, Link, useNavigation } from "react-router";

import type {
  listArubaBatches,
  listOfficialArubaFiles,
  listUnbatchedApprovedDocuments,
} from "../../src/db/aruba.server.ts";
import type {
  documentArchiveSummary,
  listDocuments,
} from "../../src/db/document-archive.server.ts";
import type { listEmailDeliveries } from "../../src/db/email.server.ts";
import { copy } from "../copy.it";
import { date, dateTime, euros } from "../format";
import { Pager } from "./pager";
import { SortControlLink } from "./sortable-table";
import type { SortState } from "../table-sort";
import type { DocumentListSortKey } from "../../src/db/document-archive-types.server.ts";

type DocumentPage = Awaited<ReturnType<typeof listDocuments>>;
type DocumentRowData = DocumentPage["rows"][number];
type DocumentSummary = Awaited<ReturnType<typeof documentArchiveSummary>>;
type ArubaBatch = Awaited<ReturnType<typeof listArubaBatches>>[number];
type UnbatchedDocument = Awaited<ReturnType<typeof listUnbatchedApprovedDocuments>>[number];
type OfficialFile = Awaited<ReturnType<typeof listOfficialArubaFiles>>[number];
type EmailDelivery = Awaited<ReturnType<typeof listEmailDeliveries>>[number];

interface DocumentFiltersValue {
  query: string;
  kind: string;
  status: string;
  arubaStatus: string;
  dateFrom: string;
  dateTo: string;
  remoteUpdatedFrom: string;
  remoteUpdatedTo: string;
  recipientCountry: string;
  recipientTaxId: string;
  origin: string;
  fiscalNumber: string;
  providerFilename: string;
  sdiId: string;
}

function DocumentOverview({ summary }: { summary: DocumentSummary }) {
  return (
    <section
      aria-label={copy.documents.overviewLabel}
      className="dashboard-panel document-overview section-gap"
    >
      <div className="document-overview__lead">
        <span className="dashboard-icon dashboard-icon--neutral" aria-hidden="true">
          <FileText size={24} strokeWidth={1.9} />
        </span>
        <span>
          <strong>{copy.documents.overviewCount(summary.total)}</strong>
          <span>{copy.documents.overviewHelp}</span>
        </span>
      </div>
      <dl className="document-overview__counts">
        <div>
          <dt>{copy.documents.overviewInvoices}</dt>
          <dd>{summary.invoices}</dd>
        </div>
        <div>
          <dt>{copy.documents.overviewCreditNotes}</dt>
          <dd>{summary.credit_notes}</dd>
        </div>
        <div>
          <dt>{copy.documents.overviewToSend}</dt>
          <dd>{summary.to_send}</dd>
        </div>
        <div>
          <dt>{copy.documents.overviewToReconcile}</dt>
          <dd>{summary.reconciliation_required}</dd>
        </div>
      </dl>
    </section>
  );
}

function DocumentFilters({
  count,
  filters,
  view,
}: {
  count: number;
  filters: DocumentFiltersValue;
  view: string;
}) {
  const hasImplicitTransmission = view === "da-trasmettere";
  const activeFilters = [
    filters.query,
    view === "tutti" ? filters.kind : "",
    filters.status,
    hasImplicitTransmission ? "" : filters.arubaStatus,
    filters.dateFrom,
    filters.dateTo,
    filters.remoteUpdatedFrom,
    filters.remoteUpdatedTo,
    filters.recipientCountry,
    filters.recipientTaxId,
    filters.origin,
    filters.fiscalNumber,
    filters.providerFilename,
    filters.sdiId,
  ].filter(Boolean).length;
  const resetTo = view === "tutti" ? "/documenti" : `/documenti?vista=${view}`;

  return (
    <div className="document-filter-block">
      <Form
        aria-label={copy.documents.filterLabel}
        className="document-filters"
        key={JSON.stringify(filters)}
        method="get"
        role="search"
      >
        {view !== "tutti" ? <input name="vista" type="hidden" value={view} /> : null}
        <label className="document-filters__search">
          {copy.documents.search}
          <input
            defaultValue={filters.query}
            name="q"
            placeholder={copy.documents.searchPlaceholder}
          />
        </label>
        {view === "tutti" ? (
          <label>
            {copy.documents.type}
            <select defaultValue={filters.kind} name="tipo">
              <option value="">{copy.documents.allTypes}</option>
              <option value="INVOICE">{copy.documents.invoice}</option>
              <option value="CREDIT_NOTE">{copy.documents.creditNote}</option>
            </select>
          </label>
        ) : null}
        <label>
          {copy.documents.approvalStatus}
          <select defaultValue={filters.status} name="stato">
            <option value="">{copy.documents.allStatuses}</option>
            <option value="DRAFT">{copy.documents.draft}</option>
            <option value="APPROVED">{copy.documents.approved}</option>
          </select>
        </label>
        {!hasImplicitTransmission ? (
          <label>
            {copy.documents.transmissionStatus}
            <select defaultValue={filters.arubaStatus} name="trasmissione">
              <option value="">{copy.documents.allTransmissionStatuses}</option>
              <option value="NOT_PREPARED">{copy.documents.transmissionState.NOT_PREPARED}</option>
              {Object.entries(copy.documents.arubaBatchStatus).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          {copy.documents.dateFrom}
          <input autoComplete="off" defaultValue={filters.dateFrom} name="dal" type="date" />
        </label>
        <label>
          {copy.documents.dateTo}
          <input autoComplete="off" defaultValue={filters.dateTo} name="al" type="date" />
        </label>
        <details className="document-filters__advanced">
          <summary>{copy.documents.advancedFilters}</summary>
          <div>
            <label>
              {copy.documents.remoteUpdatedFrom}
              <input
                autoComplete="off"
                defaultValue={filters.remoteUpdatedFrom}
                name="aggiornatoDal"
                type="date"
              />
            </label>
            <label>
              {copy.documents.remoteUpdatedTo}
              <input
                autoComplete="off"
                defaultValue={filters.remoteUpdatedTo}
                name="aggiornatoAl"
                type="date"
              />
            </label>
            <label>
              {copy.documents.recipientCountry}
              <input
                defaultValue={filters.recipientCountry}
                maxLength={2}
                name="paese"
                placeholder="IT"
              />
            </label>
            <label>
              {copy.documents.recipientTaxId}
              <input defaultValue={filters.recipientTaxId} name="identificativo" />
            </label>
            <label>
              {copy.documents.origin}
              <select defaultValue={filters.origin} name="origine">
                <option value="">{copy.documents.allOrigins}</option>
                <option value="HUB">{copy.documents.originLocal}</option>
                <option value="ARUBA_HISTORY">{copy.documents.originAruba}</option>
              </select>
            </label>
            <label>
              {copy.documents.fiscalNumber}
              <input defaultValue={filters.fiscalNumber} inputMode="numeric" name="numeroFiscale" />
            </label>
            <label>
              {copy.documents.providerFilename}
              <input defaultValue={filters.providerFilename} name="filename" />
            </label>
            <label>
              {copy.documents.sdiId}
              <input defaultValue={filters.sdiId} name="idSdi" />
            </label>
          </div>
        </details>
        <div className="document-filters__actions">
          <button className="button button--secondary" type="submit">
            {copy.documents.filter}
          </button>
          {activeFilters ? <Link to={resetTo}>{copy.documents.resetFilters}</Link> : null}
        </div>
      </Form>
      <div aria-live="polite" className="filter-summary">
        <span>{copy.documents.resultsOnPage(count)}</span>
        {activeFilters ? <span>{copy.documents.activeFilters(activeFilters)}</span> : null}
      </div>
    </div>
  );
}

function ImportForm({ csrfToken, documentId }: { csrfToken: string; documentId: string }) {
  return (
    <details className="document-import">
      <summary>
        <Upload aria-hidden="true" size={17} strokeWidth={1.8} />
        {copy.documents.importOfficial}
      </summary>
      <Form className="document-import__form" encType="multipart/form-data" method="post">
        <input name="csrf" type="hidden" value={csrfToken} />
        <input name="documentId" type="hidden" value={documentId} />
        <label>
          {copy.documents.fileType}
          <select name="fileKind">
            {Object.entries(copy.documents.officialFileKind).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {copy.documents.officialFile}
          <input name="file" required type="file" />
        </label>
        <button className="button button--secondary" type="submit">
          {copy.documents.importAction}
        </button>
      </Form>
    </details>
  );
}

function documentTarget(document: DocumentRowData) {
  if (document.kind === "CREDIT_NOTE") return `/documenti/${document.id}/nota`;
  if (document.origin === "ARUBA_HISTORY") {
    return document.historical_order_id ? `/ordini/${document.historical_order_id}` : null;
  }
  return `/ordini/preparazione/${document.billing_case_id}`;
}

function transmissionLabel(document: DocumentRowData) {
  if (document.origin === "ARUBA_HISTORY") return copy.documents.arubaHistory;
  if (document.status === "DRAFT") return copy.documents.notApplicable;
  if (!document.aruba_status) return copy.documents.transmissionState.NOT_PREPARED;
  return (
    copy.documents.transmissionState[document.aruba_status] ??
    copy.documents.arubaBatchStatus[document.aruba_status] ??
    copy.common.unavailable
  );
}

function stateTone(document: DocumentRowData) {
  if (["VALIDATION_FAILED", "RECONCILIATION_REQUIRED"].includes(document.aruba_status ?? "")) {
    return "warning";
  }
  if (document.aruba_status === "RECONCILED" || document.origin === "ARUBA_HISTORY") {
    return "success";
  }
  return document.status === "APPROVED" ? "accent" : "neutral";
}

function DocumentRowGrid({
  document,
  emailLabel,
  label,
  target,
}: {
  document: DocumentRowData;
  emailLabel: string;
  label: string;
  target: string | null;
}) {
  return (
    <div className="document-row__grid">
      <span className="document-row__main">
        <small>{copy.documents.document}</small>
        {target ? <Link to={target}>{label}</Link> : <strong>{label}</strong>}
        <span>
          {document.kind === "CREDIT_NOTE" ? copy.documents.creditNote : copy.documents.invoice}
        </span>
        {document.source_billing_case_id && document.source_public_number ? (
          <Link to={`/ordini/preparazione/${document.source_billing_case_id}`}>
            {copy.documents.sourcePreparation(document.source_public_number)}
          </Link>
        ) : null}
      </span>
      <span className="document-row__customer" title={document.customer_name}>
        <small>{copy.documents.customer}</small>
        <strong>{document.customer_name}</strong>
      </span>
      <span className="document-row__facts">
        <span>
          <small>{copy.documents.date}</small>
          <time dateTime={document.document_date}>{date(document.document_date)}</time>
        </span>
        <span>
          <small>{copy.documents.total}</small>
          <strong>{euros(document.total_amount)}</strong>
        </span>
      </span>
      <span className="document-row__state">
        <small>{copy.documents.status}</small>
        <span className={`document-state document-state--${stateTone(document)}`}>
          {document.status === "APPROVED" ? copy.documents.approved : copy.documents.draft}
        </span>
        <span>{transmissionLabel(document)}</span>
      </span>
      <span className="document-row__email">
        <small>{copy.documents.email}</small>
        <span>
          <Mail aria-hidden="true" size={16} strokeWidth={1.8} />
          {emailLabel}
        </span>
      </span>
      {target ? (
        <Link
          aria-label={copy.documents.openDocumentLabel(label)}
          className="dashboard-row-link document-row__action"
          to={target}
        >
          <span>{copy.documents.openDocument}</span>
          <ArrowRight aria-hidden="true" size={17} strokeWidth={1.8} />
        </Link>
      ) : null}
    </div>
  );
}

function DocumentFiles({
  document,
  fileCount,
  officialFiles,
}: {
  document: DocumentRowData;
  fileCount: number;
  officialFiles: OfficialFile[];
}) {
  return (
    <div className="document-file-list">
      {document.xml_sha256 ? (
        <a href={`/documenti/${document.id}/xml`}>
          <FileCheck2 aria-hidden="true" size={17} strokeWidth={1.8} />
          {copy.documents.downloadXml}
        </a>
      ) : null}
      {officialFiles.map((file) => (
        <a href={`/documenti/${document.id}/aruba/${file.id}`} key={file.id}>
          <FileText aria-hidden="true" size={17} strokeWidth={1.8} />
          <span>
            {copy.documents.officialFileKind[file.kind]}
            <small>{dateTime(file.imported_at)}</small>
          </span>
        </a>
      ))}
      {!fileCount ? <p>{copy.documents.noOfficialFiles}</p> : null}
    </div>
  );
}

function DocumentEmailActions({
  canPrepareRedactedEmail,
  canRetryEmail,
  csrfToken,
  documentId,
  email,
  emailRedacted,
}: {
  canPrepareRedactedEmail: boolean;
  canRetryEmail: boolean;
  csrfToken: string;
  documentId: string;
  email?: EmailDelivery;
  emailRedacted: boolean;
}) {
  return (
    <>
      {email?.last_error_code === "EMAIL_DELIVERY_UNCERTAIN" ? (
        <p className="warning">{copy.documents.emailUncertain}</p>
      ) : null}
      {canPrepareRedactedEmail ? (
        <Form method="post">
          <input name="csrf" type="hidden" value={csrfToken} />
          <input name="intent" type="hidden" value="retry-customer-email" />
          <input name="documentId" type="hidden" value={documentId} />
          <label>
            {copy.documents.newEmailRecipient}
            <input name="newRecipient" type="email" maxLength={256} required />
          </label>
          <p className="field-help">{copy.documents.emailRedacted}</p>
          <button className="button button--secondary" type="submit">
            <RefreshCw aria-hidden="true" size={17} strokeWidth={1.8} />
            {copy.documents.prepareNewDelivery}
          </button>
        </Form>
      ) : emailRedacted ? (
        <p className="field-help">{copy.documents.emailRedactedUnavailable}</p>
      ) : null}
      {canRetryEmail ? (
        <Form method="post">
          <input name="csrf" type="hidden" value={csrfToken} />
          <input name="intent" type="hidden" value="retry-customer-email" />
          <input name="documentId" type="hidden" value={documentId} />
          {email?.last_error_code === "EMAIL_DELIVERY_UNCERTAIN" ? (
            <label className="checkbox-row">
              <input name="confirmUncertain" required type="checkbox" value="yes" />
              {copy.documents.emailUncertainConfirmed}
            </label>
          ) : null}
          <button className="button button--secondary" type="submit">
            <RefreshCw aria-hidden="true" size={17} strokeWidth={1.8} />
            {copy.documents.prepareResend}
          </button>
        </Form>
      ) : null}
    </>
  );
}

function DocumentTools({
  capabilities,
  csrfToken,
  document,
  email,
  fileCount,
  officialFiles,
}: {
  capabilities: {
    canImportFile: boolean;
    canPrepareRedactedEmail: boolean;
    canRetryEmail: boolean;
    canRefreshAruba: boolean;
    emailRedacted: boolean;
  };
  csrfToken: string;
  document: DocumentRowData;
  email?: EmailDelivery;
  fileCount: number;
  officialFiles: OfficialFile[];
}) {
  const { canImportFile, canPrepareRedactedEmail, canRetryEmail, canRefreshAruba, emailRedacted } =
    capabilities;
  const navigation = useNavigation();
  const refreshPending =
    navigation.formData?.get("intent") === "refresh-aruba-status" &&
    navigation.formData.get("documentId") === document.id;
  const hasArubaStatus = Boolean(document.aruba_batch_id && document.aruba_status);
  return (
    <details className="document-row__tools">
      <summary>
        <span>
          <Download aria-hidden="true" size={17} strokeWidth={1.8} />
          {hasArubaStatus ? copy.documents.arubaDetail : copy.documents.filesAndActions}
        </span>
        <small>
          {hasArubaStatus
            ? (copy.documents.arubaDocumentStatus[document.aruba_status!] ?? document.aruba_status)
            : copy.documents.availableFiles(fileCount)}
        </small>
      </summary>
      <div className="document-row__tools-content">
        {hasArubaStatus ? <DocumentArubaStatus document={document} /> : null}
        <div className="document-resource-grid">
          <section aria-labelledby={`document-files-${document.id}`}>
            <h3 id={`document-files-${document.id}`}>{copy.documents.availableFiles(fileCount)}</h3>
            <DocumentFiles
              document={document}
              fileCount={fileCount}
              officialFiles={officialFiles}
            />
          </section>
          <section aria-labelledby={`document-actions-${document.id}`}>
            <h3 id={`document-actions-${document.id}`}>{copy.documents.arubaActions}</h3>
            <div className="document-tool-actions">
              {canRefreshAruba ? (
                <Form method="post">
                  <input name="csrf" type="hidden" value={csrfToken} />
                  <input name="intent" type="hidden" value="refresh-aruba-status" />
                  <input name="documentId" type="hidden" value={document.id} />
                  <button
                    className="button button--secondary"
                    disabled={refreshPending}
                    type="submit"
                  >
                    <RefreshCw aria-hidden="true" size={17} strokeWidth={1.8} />
                    {refreshPending
                      ? copy.documents.refreshingArubaStatus
                      : copy.documents.refreshArubaStatus}
                  </button>
                </Form>
              ) : null}
              {canImportFile ? <ImportForm csrfToken={csrfToken} documentId={document.id} /> : null}
              <DocumentEmailActions
                canPrepareRedactedEmail={canPrepareRedactedEmail}
                canRetryEmail={canRetryEmail}
                csrfToken={csrfToken}
                documentId={document.id}
                email={email}
                emailRedacted={emailRedacted}
              />
            </div>
          </section>
        </div>
      </div>
    </details>
  );
}

function DocumentArubaStatus({ document }: { document: DocumentRowData }) {
  const status = document.aruba_status
    ? (copy.documents.arubaDocumentStatus[document.aruba_status] ?? document.aruba_status)
    : copy.common.unavailable;
  const hasIdentifiers = Boolean(document.provider_filename || document.provider_sdi_id);
  return (
    <section className="document-aruba-status" aria-labelledby={`aruba-status-${document.id}`}>
      <header>
        <div>
          <p>{copy.documents.currentArubaStatus}</p>
          <h3 id={`aruba-status-${document.id}`}>{status}</h3>
        </div>
        <dl>
          <div>
            <dt>{copy.documents.arubaLastStatusChange}</dt>
            <dd>
              {document.remote_status_changed_at
                ? dateTime(document.remote_status_changed_at)
                : copy.common.unavailable}
            </dd>
          </div>
          <div>
            <dt>{copy.documents.arubaLastCheck}</dt>
            <dd>
              {document.remote_updated_at
                ? dateTime(document.remote_updated_at)
                : copy.common.unavailable}
            </dd>
          </div>
        </dl>
      </header>
      <div className="document-aruba-status__body">
        <section aria-labelledby={`aruba-identifiers-${document.id}`}>
          <h4 id={`aruba-identifiers-${document.id}`}>{copy.documents.arubaIdentifiers}</h4>
          {hasIdentifiers ? (
            <dl className="document-aruba-identifiers">
              {document.provider_filename ? (
                <div>
                  <dt>{copy.documents.providerFilename}</dt>
                  <dd>{document.provider_filename}</dd>
                </div>
              ) : null}
              {document.provider_sdi_id ? (
                <div>
                  <dt>{copy.documents.sdiId}</dt>
                  <dd>{document.provider_sdi_id}</dd>
                </div>
              ) : null}
            </dl>
          ) : (
            <p>{copy.documents.arubaNoIdentifiers}</p>
          )}
        </section>
        <section aria-labelledby={`aruba-timeline-${document.id}`}>
          <h4 id={`aruba-timeline-${document.id}`}>{copy.documents.arubaTimeline}</h4>
          {document.aruba_timeline.length ? (
            <ol className="document-aruba-timeline">
              {document.aruba_timeline.map((event) => (
                <li key={event.event_key}>
                  <span aria-hidden="true" />
                  <div>
                    <strong>
                      {copy.documents.arubaDocumentStatus[event.status] ?? event.status}
                    </strong>
                    <small>
                      {dateTime(event.observed_at)} ·{" "}
                      {copy.documents.arubaSourceLabels[event.source]}
                    </small>
                    {event.detail && event.detail !== event.status ? <p>{event.detail}</p> : null}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p>{copy.documents.arubaTimelineEmpty}</p>
          )}
        </section>
      </div>
    </section>
  );
}

function documentRowState({
  canApprove,
  document,
  email,
  emailEnabled,
  officialFiles,
}: {
  canApprove: boolean;
  document: DocumentRowData;
  email?: EmailDelivery;
  emailEnabled: boolean;
  officialFiles: OfficialFile[];
}) {
  const emailRedacted = Boolean(email?.requires_explicit_recipient);
  const canPrepareRedactedEmail = Boolean(emailRedacted && emailEnabled && canApprove);
  const canRetryEmail = Boolean(
    emailEnabled && email && email.status !== "PENDING" && !emailRedacted && canApprove,
  );
  const canImportFile = Boolean(canApprove && document.aruba_batch_id && document.xml_sha256);
  const canRefreshAruba = Boolean(
    canApprove &&
    document.aruba_batch_id &&
    document.aruba_status &&
    ["ARUBA_ACCEPTED", "SDI_PROCESSING", "SUBMITTED", "UNKNOWN", "UNKNOWN_REMOTE_STATE"].includes(
      document.aruba_status,
    ),
  );
  const fileCount = Number(Boolean(document.xml_sha256)) + officialFiles.length;
  return {
    canImportFile,
    canPrepareRedactedEmail,
    canRetryEmail,
    canRefreshAruba,
    emailLabel: email
      ? (copy.documents.emailStatus[email.status] ?? copy.common.unavailable)
      : copy.documents.emailNotPrepared,
    emailRedacted,
    fileCount,
    hasTools: Boolean(
      document.xml_sha256 ||
      officialFiles.length ||
      canRetryEmail ||
      canImportFile ||
      canRefreshAruba ||
      emailRedacted,
    ),
    label: document.fiscal_label ?? copy.documents.draftLabel(document.public_number),
    target: documentTarget(document),
  };
}

function DocumentRow({
  canApprove,
  csrfToken,
  document,
  email,
  emailEnabled,
  officialFiles,
}: {
  canApprove: boolean;
  csrfToken: string;
  document: DocumentRowData;
  email?: EmailDelivery;
  emailEnabled: boolean;
  officialFiles: OfficialFile[];
}) {
  const state = documentRowState({ canApprove, document, email, emailEnabled, officialFiles });

  return (
    <li className="document-row">
      <DocumentRowGrid
        document={document}
        emailLabel={state.emailLabel}
        label={state.label}
        target={state.target}
      />
      {state.hasTools ? (
        <DocumentTools
          capabilities={state}
          csrfToken={csrfToken}
          document={document}
          email={email}
          fileCount={state.fileCount}
          officialFiles={officialFiles}
        />
      ) : null}
    </li>
  );
}

function ManualBatchPanel({
  arubaConfiguredMode,
  arubaDowngradeRequired,
  csrfToken,
  documents,
}: {
  arubaConfiguredMode: string;
  arubaDowngradeRequired: boolean;
  csrfToken: string;
  documents: UnbatchedDocument[];
}) {
  return (
    <section className="dashboard-panel document-task-panel section-gap">
      <header className="document-panel-header">
        <span className="dashboard-icon dashboard-icon--warning" aria-hidden="true">
          <CircleAlert size={22} strokeWidth={1.8} />
        </span>
        <span>
          <h2>{copy.documents.manualBatchTitle}</h2>
          <p>{copy.documents.manualBatchHelp}</p>
        </span>
        <strong>{copy.documents.manualBatchCount(documents.length)}</strong>
      </header>
      <Form method="post">
        <input name="csrf" type="hidden" value={csrfToken} />
        <input name="intent" type="hidden" value="create-aruba-batch" />
        <div className="document-batch-picker">
          {documents.map((document) => (
            <label className="document-batch-option" key={document.id}>
              <input name="documentId" type="checkbox" value={document.id} />
              <span>
                <strong>{document.fiscal_label}</strong>
                <small>{document.customer_name}</small>
              </span>
              <strong>{euros(document.total_amount)}</strong>
            </label>
          ))}
        </div>
        {arubaDowngradeRequired ? (
          <label className="checkbox-row">
            <input name="confirmArubaDowngrade" required type="checkbox" value="yes" />
            {copy.document.confirmArubaDowngrade(arubaConfiguredMode)}
          </label>
        ) : null}
        <button className="button document-task-panel__action" type="submit">
          <Layers3 aria-hidden="true" size={18} strokeWidth={1.8} />
          {copy.documents.createBatch}
        </button>
      </Form>
    </section>
  );
}

function BatchPanel({
  batches,
  canApprove,
  csrfToken,
}: {
  batches: ArubaBatch[];
  canApprove: boolean;
  csrfToken: string;
}) {
  return (
    <section className="dashboard-panel document-batches section-gap">
      <header className="document-panel-header">
        <span className="dashboard-icon dashboard-icon--neutral" aria-hidden="true">
          <FileClock size={22} strokeWidth={1.8} />
        </span>
        <span>
          <h2>{copy.documents.batchesTitle}</h2>
          <p>{copy.documents.batchesHelp}</p>
        </span>
        <strong>{copy.documents.batchesCount(batches.length)}</strong>
      </header>
      <ul className="document-batch-list">
        {batches.map((batch) => (
          <li key={batch.id}>
            <span className="document-batch-list__main">
              <strong>{copy.documents.batchSummary(batch.document_count, batch.mode)}</strong>
              <span>
                {copy.documents.arubaBatchStatus[batch.status] ?? copy.common.unavailable}
              </span>
            </span>
            <span className="document-batch-list__dates">
              <span>
                <small>{copy.documents.batchCreatedAt}</small>
                <time dateTime={batch.created_at}>{dateTime(batch.created_at)}</time>
              </span>
              <span>
                <small>{copy.documents.batchLastReadback}</small>
                <span>
                  {batch.last_readback_at
                    ? dateTime(batch.last_readback_at)
                    : copy.documents.batchNeverRead}
                </span>
              </span>
            </span>
            <details className="technical-details">
              <summary>{copy.documents.batchDocumentResults}</summary>
              <ul>
                {batch.documents.map((document) => (
                  <li key={document.id}>
                    <strong>{document.fiscal_label}</strong>
                    {" · "}
                    {copy.documents.arubaDocumentStatus[document.status] ?? document.status}
                    {document.error_code ? ` · ${document.error_code}` : ""}
                    {document.error_message ? ` · ${document.error_message}` : ""}
                  </li>
                ))}
              </ul>
            </details>
            <div aria-label={copy.documents.batchActions} className="document-batch-list__actions">
              {canApprove &&
              batch.transport === "API" &&
              batch.status === "AWAITING_CONFIRMATION" ? (
                <Form method="post">
                  <input name="csrf" type="hidden" value={csrfToken} />
                  <input name="intent" type="hidden" value="confirm-aruba-api-batch" />
                  <input name="batchId" type="hidden" value={batch.id} />
                  <button className="button" type="submit">
                    {copy.documents.confirmApiTransmission}
                  </button>
                </Form>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DocumentsView({
  arubaConfiguredMode,
  arubaDowngradeRequired,
  batches,
  canApprove,
  csrfToken,
  documents,
  emailDeliveries,
  emailEnabled,
  filters,
  officialFiles,
  page,
  summary,
  sort,
  unbatched,
  view,
}: {
  arubaConfiguredMode: string;
  arubaDowngradeRequired: boolean;
  batches: ArubaBatch[];
  canApprove: boolean;
  csrfToken: string;
  documents: DocumentPage;
  emailDeliveries: EmailDelivery[];
  emailEnabled: boolean;
  filters: DocumentFiltersValue;
  officialFiles: OfficialFile[];
  page: number;
  summary: DocumentSummary;
  sort: SortState<DocumentListSortKey>;
  unbatched: UnbatchedDocument[];
  view: string;
}) {
  const officialFilesByDocument = new Map<string, OfficialFile[]>();
  const emailByDocument = new Map<string, EmailDelivery>();
  for (const delivery of emailDeliveries) {
    if (!emailByDocument.has(delivery.document_id))
      emailByDocument.set(delivery.document_id, delivery);
  }
  for (const file of officialFiles) {
    const current = officialFilesByDocument.get(file.document_id) ?? [];
    current.push(file);
    officialFilesByDocument.set(file.document_id, current);
  }

  return (
    <>
      <DocumentOverview summary={summary} />
      {canApprove && unbatched.length ? (
        <ManualBatchPanel
          arubaConfiguredMode={arubaConfiguredMode}
          arubaDowngradeRequired={arubaDowngradeRequired}
          csrfToken={csrfToken}
          documents={unbatched}
        />
      ) : null}
      <section
        aria-labelledby="document-archive-title"
        className="dashboard-panel document-archive section-gap"
      >
        <header className="document-panel-header">
          <span className="dashboard-icon dashboard-icon--neutral" aria-hidden="true">
            <ReceiptText size={22} strokeWidth={1.8} />
          </span>
          <span>
            <h2 id="document-archive-title">{copy.documents.archiveTitle}</h2>
            <p>{copy.documents.archiveHelp}</p>
          </span>
          <strong>{copy.documents.archiveCount(documents.rows.length)}</strong>
        </header>
        <DocumentFilters count={documents.rows.length} filters={filters} view={view} />
        {documents.rows.length ? (
          <>
            <div aria-label={copy.table.sortControls} className="document-list-header" role="group">
              <SortControlLink
                directionParam="direzione"
                keyParam="ordina"
                label={copy.documents.document}
                sort={sort}
                sortKey="documento"
              />
              <SortControlLink
                directionParam="direzione"
                keyParam="ordina"
                label={copy.documents.customer}
                sort={sort}
                sortKey="cliente"
              />
              <span className="document-list-header__facts">
                <SortControlLink
                  directionParam="direzione"
                  keyParam="ordina"
                  label={copy.documents.date}
                  sort={sort}
                  sortKey="data"
                />
                <SortControlLink
                  className="table-sort-button--numeric"
                  directionParam="direzione"
                  keyParam="ordina"
                  label={copy.documents.total}
                  sort={sort}
                  sortKey="totale"
                />
              </span>
              <SortControlLink
                directionParam="direzione"
                keyParam="ordina"
                label={copy.documents.status}
                sort={sort}
                sortKey="stato"
              />
              <SortControlLink
                directionParam="direzione"
                keyParam="ordina"
                label={copy.documents.email}
                sort={sort}
                sortKey="email"
              />
              <span aria-hidden="true">{copy.documents.actions}</span>
            </div>
            <ul className="document-list">
              {documents.rows.map((document) => (
                <DocumentRow
                  canApprove={canApprove}
                  csrfToken={csrfToken}
                  document={document}
                  email={emailByDocument.get(document.id)}
                  emailEnabled={emailEnabled}
                  key={document.id}
                  officialFiles={officialFilesByDocument.get(document.id) ?? []}
                />
              ))}
            </ul>
            <Pager basePath="/documenti" hasNext={documents.hasNext} page={page} />
          </>
        ) : (
          <div className="empty-state document-empty">
            <h2>{summary.total ? copy.documents.noResults : copy.documents.empty}</h2>
            <p>{summary.total ? copy.documents.archiveHelp : copy.documents.emptyHelp}</p>
            <div className="empty-state__actions">
              {summary.total ? (
                <Link className="button button--secondary" to="/documenti">
                  {copy.documents.resetFilters}
                </Link>
              ) : (
                <Link className="button button--secondary" to="/ordini">
                  {copy.documents.openOrders}
                </Link>
              )}
            </div>
          </div>
        )}
      </section>
      {batches.length ? (
        <BatchPanel batches={batches} canApprove={canApprove} csrfToken={csrfToken} />
      ) : null}
    </>
  );
}
