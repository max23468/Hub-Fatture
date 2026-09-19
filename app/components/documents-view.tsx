import { ArrowRight, FileText, Mail, ReceiptText } from "lucide-react";
import { Form, Link, useLocation } from "react-router";

import type {
  documentArchiveSummary,
  listDocuments,
} from "../../src/db/document-archive.server.ts";
import type {
  DocumentListRow,
  DocumentListSortKey,
} from "../../src/db/document-archive-types.server.ts";
import type { listEmailDeliveries } from "../../src/db/email.server.ts";
import { copy, documentStateTone, documentTransmissionStatusLabel } from "../copy.it";
import { date, euros } from "../format";
import { Pager } from "./pager";
import { SortControlLink } from "./sortable-table";
import type { SortState } from "../table-sort";

type DocumentPage = Awaited<ReturnType<typeof listDocuments>>;
type DocumentRowData = DocumentPage["rows"][number];
type DocumentSummary = Awaited<ReturnType<typeof documentArchiveSummary>>;
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

export function transmissionLabel(document: DocumentListRow) {
  if (document.origin === "ARUBA_HISTORY") return copy.documents.arubaHistory;
  if (document.status === "DRAFT") return copy.documents.notApplicable;
  if (!document.aruba_status) return copy.documents.transmissionState.NOT_PREPARED;
  // Un documento creato senza trasmissione ha una submission ferma: vale lo stato del batch.
  if (document.aruba_batch_status === "DOCUMENT_ONLY") {
    return copy.documents.arubaBatchStatus.DOCUMENT_ONLY!;
  }
  if (document.aruba_awaiting_confirmation) {
    return copy.documents.arubaBatchStatus.AWAITING_CONFIRMATION!;
  }
  return documentTransmissionStatusLabel(document.aruba_status);
}

export function stateTone(document: DocumentListRow) {
  if (document.origin === "ARUBA_HISTORY") return "success";
  return documentStateTone(document.status, document.aruba_status);
}

function DocumentRow({ document, email }: { document: DocumentRowData; email?: EmailDelivery }) {
  const { search } = useLocation();
  const label = document.fiscal_label ?? copy.documents.draftLabel(document.public_number);
  const target = `/documenti/${document.id}`;
  // Il ritorno dal dettaglio ripristina filtri, ordinamento e pagina dell'elenco.
  const state = { from: search };
  const emailLabel = email
    ? (copy.documents.emailStatus[email.status] ?? copy.common.unavailable)
    : copy.documents.emailNotPrepared;
  return (
    <li className="document-row">
      <div className="document-row__grid">
        <span className="document-row__main">
          <small>{copy.documents.document}</small>
          <Link state={state} to={target}>
            {label}
          </Link>
          <span>
            {document.kind === "CREDIT_NOTE" ? copy.documents.creditNote : copy.documents.invoice}
          </span>
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
        <Link
          aria-label={copy.documents.openDocumentLabel(label)}
          className="dashboard-row-link document-row__action"
          state={state}
          to={target}
        >
          <span>{copy.documents.openDocument}</span>
          <ArrowRight aria-hidden="true" size={17} strokeWidth={1.8} />
        </Link>
      </div>
    </li>
  );
}

export function DocumentsView({
  documents,
  emailDeliveries,
  filters,
  page,
  summary,
  sort,
  view,
}: {
  documents: DocumentPage;
  emailDeliveries: EmailDelivery[];
  filters: DocumentFiltersValue;
  page: number;
  summary: DocumentSummary;
  sort: SortState<DocumentListSortKey>;
  view: string;
}) {
  const emailByDocument = new Map<string, EmailDelivery>();
  for (const delivery of emailDeliveries) {
    if (!emailByDocument.has(delivery.document_id))
      emailByDocument.set(delivery.document_id, delivery);
  }

  return (
    <>
      <DocumentOverview summary={summary} />
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
                  document={document}
                  email={emailByDocument.get(document.id)}
                  key={document.id}
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
    </>
  );
}
