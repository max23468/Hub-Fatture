import {
  ArrowRight,
  FileCheck2,
  FileText,
  History,
  Link2,
  Mail,
  ReceiptText,
  RefreshCw,
  Send,
  Upload,
} from "lucide-react";
import { Form, Link, useNavigation } from "react-router";

import type { getDocumentDetail } from "../../src/db/document-detail.server.ts";
import { auditActionLabel, copy, taxIdentifierLabels } from "../copy.it";
import { date, dateTime, euros } from "../format";
import { DetailSectionHeader } from "./detail-section-header";

export type DocumentDetail = NonNullable<Awaited<ReturnType<typeof getDocumentDetail>>>;
type OfficialFile = DocumentDetail["officialFiles"][number];
type EmailDelivery = NonNullable<DocumentDetail["email"]>;
type DocumentContent = NonNullable<DocumentDetail["content"]>;

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

function DocumentFiles({
  document,
  fileCount,
  officialFiles,
}: {
  document: DocumentDetail;
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

function arubaStatusLabel(document: DocumentDetail) {
  if (document.aruba_awaiting_confirmation) {
    return copy.documents.arubaBatchStatus.AWAITING_CONFIRMATION ?? copy.common.unavailable;
  }
  if (document.aruba_batch_status === "DOCUMENT_ONLY") {
    return copy.documents.arubaBatchStatus.DOCUMENT_ONLY ?? copy.common.unavailable;
  }
  return document.aruba_status
    ? (copy.documents.arubaDocumentStatus[document.aruba_status] ?? document.aruba_status)
    : copy.common.unavailable;
}

export function DocumentArubaStatus({ document }: { document: DocumentDetail }) {
  const status = arubaStatusLabel(document);
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

const REFRESHABLE_ARUBA_STATUSES = [
  "ARUBA_ACCEPTED",
  "SDI_PROCESSING",
  "SUBMITTED",
  "UNKNOWN",
  "UNKNOWN_REMOTE_STATE",
];

function recipientName(recipient: DocumentContent["recipient"]) {
  return (
    recipient.businessName ??
    ([recipient.firstName, recipient.lastName].filter(Boolean).join(" ") ||
      recipient.displayName ||
      copy.common.unavailable)
  );
}

function recipientAddress(address: DocumentContent["recipient"]["address"]) {
  return [
    [address.line1, address.streetNumber, address.line2].filter(Boolean).join(" "),
    [address.postalCode, address.city, address.province].filter(Boolean).join(" "),
    address.countryCode,
  ]
    .filter(Boolean)
    .join(", ");
}

const paymentMethodLabels: Record<string, string> = {
  MP01: copy.document.paymentCash,
  MP05: copy.document.paymentTransfer,
  MP08: copy.document.paymentCard,
};

function taxIdentifiersLabel(recipient: DocumentContent["recipient"]) {
  return recipient.taxIdentifiers.length
    ? recipient.taxIdentifiers
        .map(
          (identifier) =>
            `${taxIdentifierLabels[identifier.type] ?? identifier.type} ${identifier.value}`,
        )
        .join(" · ")
    : copy.common.unavailable;
}

function paymentLabel(content: DocumentContent) {
  const status =
    content.paymentStatus === "PAID" ? copy.document.paymentPaid : copy.document.paymentPending;
  return `${status} · ${paymentMethodLabels[content.paymentMethod] ?? content.paymentMethod}`;
}

function DocumentContentFacts({
  content,
  taxTreatment,
}: {
  content: DocumentContent;
  taxTreatment: DocumentDetail["taxTreatment"];
}) {
  const optionalFacts = [
    taxTreatment
      ? {
          label: copy.documentDetail.taxTreatment,
          value: `${taxTreatment.taxNature} · ${taxTreatment.legalReference}`,
        }
      : null,
    content.relatedInvoice
      ? {
          label: copy.documentDetail.relatedInvoice,
          value: `${content.relatedInvoice.number} · ${date(content.relatedInvoice.date)}`,
        }
      : null,
    content.causale ? { label: copy.document.causale, value: content.causale } : null,
    content.notes ? { label: copy.document.notes, value: content.notes } : null,
  ].filter((fact) => fact !== null);
  return (
    <dl className="facts document-detail-facts">
      <div>
        <dt>{copy.documentDetail.recipient}</dt>
        <dd>{recipientName(content.recipient)}</dd>
      </div>
      <div>
        <dt>{copy.documentDetail.taxIdentifiers}</dt>
        <dd>{taxIdentifiersLabel(content.recipient)}</dd>
      </div>
      <div>
        <dt>{copy.documentDetail.address}</dt>
        <dd>{recipientAddress(content.recipient.address)}</dd>
      </div>
      <div>
        <dt>{copy.documentDetail.payment}</dt>
        <dd>{paymentLabel(content)}</dd>
      </div>
      {optionalFacts.map((fact) => (
        <div key={fact.label}>
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function DocumentLinesTable({ lines, total }: { lines: DocumentContent["lines"]; total: number }) {
  // Il numero di riga è l'identità della riga nel documento emesso, come NumeroLinea nell'XML.
  const numberedLines = lines.map((line, position) => ({ ...line, number: position + 1 }));
  return (
    <div className="table-wrap section-gap">
      <table className="document-detail-lines">
        <caption>{copy.documentDetail.lines}</caption>
        <thead>
          <tr>
            <th scope="col">{copy.document.description}</th>
            <th className="numeric" scope="col">
              {copy.document.quantity}
            </th>
            <th className="numeric" scope="col">
              {copy.document.unitAmount}
            </th>
            <th className="numeric" scope="col">
              {copy.documentDetail.lineTotal}
            </th>
          </tr>
        </thead>
        <tbody>
          {numberedLines.map((line) => (
            <tr key={line.number}>
              <td>{line.description}</td>
              <td className="numeric">{line.quantity}</td>
              <td className="numeric">{euros(line.unitAmount)}</td>
              <td className="numeric">{euros(line.quantity * line.unitAmount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th colSpan={3} scope="row">
              {copy.documents.total}
            </th>
            <td className="numeric">{euros(total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function DocumentContentSection({ document }: { document: DocumentDetail }) {
  const content = document.content;
  const draft = document.status === "DRAFT";
  return (
    <section aria-labelledby="contenuto-fiscale" className="dashboard-panel section-gap">
      <DetailSectionHeader
        description={draft ? copy.documentDetail.draftHelp : copy.documentDetail.contentHelp}
        icon={<ReceiptText size={22} strokeWidth={1.8} />}
        id="contenuto-fiscale"
        title={copy.documentDetail.contentTitle}
      />
      {content ? (
        <>
          <DocumentContentFacts content={content} taxTreatment={document.taxTreatment} />
          <DocumentLinesTable lines={content.lines} total={document.total_amount} />
        </>
      ) : draft ? null : (
        <p>{copy.documentDetail.contentUnavailable}</p>
      )}
    </section>
  );
}

function DocumentTransmissionSection({
  canApprove,
  csrfToken,
  document,
}: {
  canApprove: boolean;
  csrfToken: string;
  document: DocumentDetail;
}) {
  const navigation = useNavigation();
  const refreshPending = navigation.formData?.get("intent") === "refresh-aruba-status";
  const hasArubaStatus = Boolean(document.aruba_batch_id && document.aruba_status);
  const canRefreshAruba = Boolean(
    canApprove &&
    document.aruba_batch_id &&
    document.aruba_status &&
    REFRESHABLE_ARUBA_STATUSES.includes(document.aruba_status),
  );
  const canImportFile = Boolean(canApprove && document.aruba_batch_id && document.xml_sha256);
  return (
    <section aria-labelledby="trasmissione" className="dashboard-panel section-gap">
      <DetailSectionHeader
        description={copy.documentDetail.transmissionHelp}
        icon={<Send size={22} strokeWidth={1.8} />}
        id="trasmissione"
        title={copy.documentDetail.transmissionTitle}
      />
      {hasArubaStatus ? (
        <DocumentArubaStatus document={document} />
      ) : (
        <p>{copy.documentDetail.noTransmission}</p>
      )}
      {document.aruba_awaiting_confirmation || canRefreshAruba || canImportFile ? (
        <div className="document-tool-actions section-gap">
          {document.aruba_awaiting_confirmation ? (
            <Link className="button" to={`/ordini/preparazione/${document.billing_case_id}`}>
              <ArrowRight aria-hidden="true" size={17} strokeWidth={1.8} />
              {copy.documents.openPreparationToTransmit}
            </Link>
          ) : null}
          {canRefreshAruba ? (
            <Form method="post">
              <input name="csrf" type="hidden" value={csrfToken} />
              <input name="intent" type="hidden" value="refresh-aruba-status" />
              <button className="button button--secondary" disabled={refreshPending} type="submit">
                <RefreshCw aria-hidden="true" size={17} strokeWidth={1.8} />
                {refreshPending
                  ? copy.documents.refreshingArubaStatus
                  : copy.documents.refreshArubaStatus}
              </button>
            </Form>
          ) : null}
          {canImportFile ? <ImportForm csrfToken={csrfToken} documentId={document.id} /> : null}
        </div>
      ) : null}
    </section>
  );
}

function DocumentFilesSection({ document }: { document: DocumentDetail }) {
  const fileCount = Number(Boolean(document.xml_sha256)) + document.officialFiles.length;
  return (
    <section aria-labelledby="file-documento" className="dashboard-panel section-gap">
      <DetailSectionHeader
        description={copy.documents.availableFiles(fileCount)}
        icon={<FileCheck2 size={22} strokeWidth={1.8} />}
        id="file-documento"
        title={copy.documentDetail.filesTitle}
      />
      <DocumentFiles
        document={document}
        fileCount={fileCount}
        officialFiles={document.officialFiles}
      />
    </section>
  );
}

function DocumentEmailSection({
  canApprove,
  csrfToken,
  document,
  emailEnabled,
}: {
  canApprove: boolean;
  csrfToken: string;
  document: DocumentDetail;
  emailEnabled: boolean;
}) {
  const email = document.email;
  const emailRedacted = Boolean(email?.requires_explicit_recipient);
  const canPrepareRedactedEmail = Boolean(emailRedacted && emailEnabled && canApprove);
  const canRetryEmail = Boolean(
    emailEnabled && email && email.status !== "PENDING" && !emailRedacted && canApprove,
  );
  return (
    <section aria-labelledby="email-cliente" className="dashboard-panel section-gap">
      <DetailSectionHeader
        description={
          email
            ? (copy.documents.emailStatus[email.status] ?? copy.common.unavailable)
            : copy.documents.emailNotPrepared
        }
        icon={<Mail size={22} strokeWidth={1.8} />}
        id="email-cliente"
        title={copy.documentDetail.emailTitle}
      />
      <div className="document-tool-actions">
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
  );
}

function DocumentLinksSection({ document }: { document: DocumentDetail }) {
  const creditNotes = document.related_documents.filter(
    (related) => related.kind === "CREDIT_NOTE",
  );
  const invoices = document.related_documents.filter((related) => related.kind === "INVOICE");
  const hasLinks =
    document.orders.length ||
    document.related_documents.length ||
    document.refunds.length ||
    document.billing_case_open;
  return (
    <section aria-labelledby="collegamenti" className="dashboard-panel section-gap">
      <DetailSectionHeader
        description={
          document.billing_case_open
            ? copy.documentDetail.preparationHelp
            : copy.documentDetail.linksHelp
        }
        icon={<Link2 size={22} strokeWidth={1.8} />}
        id="collegamenti"
        title={copy.documentDetail.linksTitle}
      />
      {hasLinks ? (
        <dl className="facts document-detail-links">
          {document.billing_case_open ? (
            <div>
              <dt>{copy.documentDetail.openPreparation}</dt>
              <dd>
                <Link to={`/ordini/preparazione/${document.billing_case_id}`}>
                  {copy.documentDetail.preparation(document.public_number)}
                </Link>
              </dd>
            </div>
          ) : null}
          {document.orders.length ? (
            <div>
              <dt>{copy.documentDetail.orders}</dt>
              <dd>
                {document.orders.map((order, index) => (
                  <span key={order.id}>
                    {index ? ", " : null}
                    <Link to={`/ordini/${order.id}`}>
                      {`${order.provider === "SHOPIFY" ? "Shopify" : "eBay"} ${order.display_number}`}
                    </Link>
                  </span>
                ))}
              </dd>
            </div>
          ) : null}
          {invoices.length ? (
            <div>
              <dt>{copy.documentDetail.relatedInvoice}</dt>
              <dd>
                {invoices.map((invoice) => (
                  <Link key={invoice.id} to={`/documenti/${invoice.id}`}>
                    {invoice.fiscal_label ?? copy.documents.invoice}
                  </Link>
                ))}
              </dd>
            </div>
          ) : null}
          {creditNotes.length ? (
            <div>
              <dt>{copy.documentDetail.creditNotes}</dt>
              <dd>
                {creditNotes.map((note, index) => (
                  <span key={note.id}>
                    {index ? ", " : null}
                    <Link to={`/documenti/${note.id}`}>
                      {note.fiscal_label ?? copy.documents.draft}
                    </Link>
                    {` · ${euros(note.total_amount)}`}
                  </span>
                ))}
              </dd>
            </div>
          ) : null}
          {document.refunds.length ? (
            <div>
              <dt>{copy.documentDetail.refunds}</dt>
              <dd>
                {document.refunds
                  .map((refund) => `${refund.display_number} · ${euros(refund.amount)}`)
                  .join(", ")}
              </dd>
            </div>
          ) : null}
          {document.credit_balance ? (
            <div>
              <dt>{copy.documentDetail.remainder}</dt>
              <dd>
                {euros(
                  document.credit_balance.invoice_total - document.credit_balance.credited_amount,
                )}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p>{copy.documentDetail.noLinks}</p>
      )}
    </section>
  );
}

function DocumentActivitySection({ document }: { document: DocumentDetail }) {
  return (
    <details className="dashboard-panel technical-details section-gap">
      <summary>
        <History aria-hidden="true" size={18} strokeWidth={1.8} />
        {copy.documentDetail.activityTitle}
      </summary>
      {document.audit.length ? (
        <ol className="timeline preparation-activity__timeline">
          {document.audit.map((event) => (
            <li key={event.id}>
              <div className="preparation-activity__event">
                <strong>{auditActionLabel(event.action) ?? copy.activity.recorded}</strong>
                {event.reason ? <span>{event.reason}</span> : null}
              </div>
              <time dateTime={event.created_at}>{dateTime(event.created_at)}</time>
            </li>
          ))}
        </ol>
      ) : (
        <p>{copy.documentDetail.activityEmpty}</p>
      )}
    </details>
  );
}

export function DocumentDetailView({
  canApprove,
  csrfToken,
  document,
  emailEnabled,
}: {
  canApprove: boolean;
  csrfToken: string;
  document: DocumentDetail;
  emailEnabled: boolean;
}) {
  return (
    <>
      <DocumentContentSection document={document} />
      {document.status === "APPROVED" ? (
        <>
          <DocumentTransmissionSection
            canApprove={canApprove}
            csrfToken={csrfToken}
            document={document}
          />
          <DocumentFilesSection document={document} />
          <DocumentEmailSection
            canApprove={canApprove}
            csrfToken={csrfToken}
            document={document}
            emailEnabled={emailEnabled}
          />
        </>
      ) : null}
      <DocumentLinksSection document={document} />
      <DocumentActivitySection document={document} />
    </>
  );
}
