import { CircleCheck, FileCode2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Form, Link, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/billing-case-detail";

import { AppShell } from "../components/app-shell";
import { ComparisonTable } from "../components/comparison-table";
import { CustomerEditor } from "../components/customer-editor";
import { DetailSectionHeader } from "../components/detail-section-header";
import { SortableHeader, useSortableRows } from "../components/sortable-table";
import {
  anomalyLabels,
  auditActionLabel,
  billingCaseStatusLabels,
  copy,
  customerKindLabels,
  fulfillmentStatusLabels,
  paymentStatusLabels,
  reactivationBlockerMessages,
  refundStatusLabels,
  taxIdentifierLabels,
} from "../copy.it";
import { date, dateTime, euros } from "../format";
import { privateRouteMeta } from "../metadata";
import type { SortValue } from "../table-sort";
import type { getInvoiceProjection } from "../../src/db/documents.server.ts";
import { action, loader } from "./billing-case-detail.server.ts";

export { action, loader };

export function meta({ error, loaderData }: Route.MetaArgs) {
  return privateRouteMeta("preparation", {
    error,
    title: loaderData?.billingCase
      ? copy.preparation.title(loaderData.billingCase.public_number)
      : undefined,
  });
}

type InvoiceProjection = Extract<
  NonNullable<Awaited<ReturnType<typeof getInvoiceProjection>>>,
  { profileMissing: false }
>;

type InvoiceLine = InvoiceProjection["lines"][number];
type InvoiceLineSortKey = "description" | "quantity" | "unitAmount";

function invoiceLineValue(line: InvoiceLine, key: InvoiceLineSortKey): SortValue {
  return line[key];
}

type SourceSnapshot = Record<string, unknown>;

interface SourceRevision {
  id: string;
  display_number: string;
  created_at: string;
  previous_normalized_snapshot_json: SourceSnapshot;
  current_normalized_snapshot_json: SourceSnapshot;
}

interface SourceChange {
  field: string;
  before: string;
  after: string;
}

function objectValue(value: unknown): SourceSnapshot {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as SourceSnapshot)
    : {};
}

function arrayValue(value: unknown): SourceSnapshot[] {
  return Array.isArray(value) ? value.map(objectValue) : [];
}

function textValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : copy.common.unavailable;
}

function decimalEuros(value: unknown): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? euros(Math.round(parsed * 100)) : copy.common.unavailable;
}

function centsEuros(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? euros(value)
    : copy.common.unavailable;
}

function addressValue(customer: SourceSnapshot, field: "billingAddress" | "shippingAddress") {
  const address = objectValue(customer[field]);
  const parts = [
    address.line1,
    address.line2,
    address.postalCode,
    address.city,
    address.province,
    address.countryCode,
  ].filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
  return parts.length ? parts.join(" · ") : copy.common.unavailable;
}

function taxIdentifiersValue(customer: SourceSnapshot): string {
  const values = arrayValue(customer.taxIdentifiers)
    .map((identifier) => {
      const type = typeof identifier.type === "string" ? identifier.type : "";
      const label = taxIdentifierLabels[type] ?? copy.common.unknownType;
      const country =
        typeof identifier.countryCode === "string" ? `${identifier.countryCode} · ` : "";
      return `${label} · ${country}${textValue(identifier.value)}`;
    })
    .toSorted();
  return values.length ? values.join("; ") : copy.common.unavailable;
}

function linesValue(snapshot: SourceSnapshot): string {
  const values = arrayValue(snapshot.lines)
    .map((line) => {
      const quantity = typeof line.quantity === "number" ? line.quantity : 1;
      const discount = Number(line.discountAmount);
      return [
        `Rif. ${textValue(line.externalLineId)}`,
        textValue(line.description),
        `${quantity} × ${decimalEuros(line.grossAmount)}`,
        Number.isFinite(discount) && discount !== 0
          ? `sconto ${decimalEuros(line.discountAmount)}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ");
    })
    .toSorted();
  return values.length ? values.join("; ") : copy.common.unavailable;
}

function paymentValue(snapshot: SourceSnapshot): string {
  const status = typeof snapshot.paymentStatus === "string" ? snapshot.paymentStatus : "";
  const summary = paymentStatusLabels[status] ?? copy.common.unknownStatus;
  const payments = arrayValue(snapshot.payments)
    .map((payment) => {
      const paymentStatus = typeof payment.status === "string" ? payment.status : "";
      const fee = Number(payment.shopifyPaymentsFeeAmount);
      return [
        `Rif. ${textValue(payment.externalPaymentId)}`,
        textValue(payment.method),
        paymentStatusLabels[paymentStatus] ?? copy.common.unknownStatus,
        decimalEuros(payment.amount),
        Number.isFinite(fee) && fee !== 0
          ? `commissione ${decimalEuros(payment.shopifyPaymentsFeeAmount)}`
          : null,
        typeof payment.paidAt === "string" ? dateTime(payment.paidAt) : null,
      ]
        .filter(Boolean)
        .join(" · ");
    })
    .toSorted();
  return payments.length ? `${summary}; ${payments.join("; ")}` : summary;
}

function refundsValue(snapshot: SourceSnapshot): string {
  const values = arrayValue(snapshot.refunds)
    .map((refund) => {
      const status = typeof refund.status === "string" ? refund.status : "";
      const amount = refund.amount === null ? copy.common.unavailable : decimalEuros(refund.amount);
      return [
        `Rif. ${textValue(refund.externalRefundId)}`,
        refundStatusLabels[status] ?? copy.common.unknownStatus,
        amount,
        typeof refund.completedAt === "string" ? dateTime(refund.completedAt) : null,
      ]
        .filter(Boolean)
        .join(" · ");
    })
    .toSorted();
  return values.length ? values.join("; ") : copy.common.unavailable;
}

function sourceFacts(snapshot: SourceSnapshot): Record<string, string> {
  const customer = objectValue(snapshot.customerSnapshot);
  const kind = typeof customer.kind === "string" ? customer.kind : "";
  const fulfillment =
    typeof snapshot.fulfillmentStatus === "string" ? snapshot.fulfillmentStatus : "";
  return {
    displayNumber: textValue(snapshot.displayNumber),
    localOrderDate:
      typeof snapshot.localOrderDate === "string"
        ? date(snapshot.localOrderDate)
        : copy.common.unavailable,
    totalAmount: centsEuros(snapshot.totalAmount),
    billableAmount: centsEuros(snapshot.billableAmount),
    shippingAmount: centsEuros(snapshot.shippingAmount),
    payment: paymentValue(snapshot),
    fulfillment: fulfillmentStatusLabels[fulfillment] ?? copy.common.unknownStatus,
    cancellation:
      typeof snapshot.cancelledAt === "string"
        ? dateTime(snapshot.cancelledAt)
        : copy.common.unavailable,
    customerName: textValue(customer.displayName),
    firstName: textValue(customer.firstName),
    lastName: textValue(customer.lastName),
    customerKind: customerKindLabels[kind] ?? copy.common.unknownType,
    companyName: textValue(customer.companyName),
    email: textValue(customer.email),
    certifiedEmail: textValue(customer.certifiedEmail),
    recipientCode: textValue(customer.recipientCode),
    phone: textValue(customer.phone),
    billingAddress: addressValue(customer, "billingAddress"),
    shippingAddress: addressValue(customer, "shippingAddress"),
    taxIdentifiers: taxIdentifiersValue(customer),
    lines: linesValue(snapshot),
    refunds: refundsValue(snapshot),
    sourceReviewRequired:
      snapshot.sourceReviewRequired === true
        ? copy.preparation.sourceReviewRequested
        : copy.preparation.sourceReviewNotRequested,
  };
}

function sourceChanges(revision: SourceRevision): SourceChange[] {
  const before = sourceFacts(revision.previous_normalized_snapshot_json);
  const after = sourceFacts(revision.current_normalized_snapshot_json);
  return Object.keys(before).flatMap((field) =>
    before[field] === after[field] ? [] : [{ field, before: before[field]!, after: after[field]! }],
  );
}

type SourceChangeSortKey = "field" | "before" | "after";

function sourceChangeValue(change: SourceChange, key: SourceChangeSortKey): SortValue {
  return key === "field"
    ? (copy.preparation.sourceChangeFields[change.field] ?? change.field)
    : change[key];
}

function SourceChangesTable({ changes }: { changes: SourceChange[] }) {
  const { onSort, rows, sort } = useSortableRows<SourceChange, SourceChangeSortKey>(
    changes,
    { key: "field", direction: "asc" },
    sourceChangeValue,
  );
  return (
    <div className="table-wrap source-revisions__table">
      <table className="data-table source-changes-table">
        <colgroup>
          <col className="source-changes-table__field" />
          <col className="source-changes-table__value" />
          <col className="source-changes-table__value" />
        </colgroup>
        <thead>
          <tr>
            <SortableHeader
              label={copy.preparation.sourceChangesField}
              onSort={onSort}
              sort={sort}
              sortKey="field"
            />
            <SortableHeader
              label={copy.preparation.sourceChangesBefore}
              onSort={onSort}
              sort={sort}
              sortKey="before"
            />
            <SortableHeader
              label={copy.preparation.sourceChangesNow}
              onSort={onSort}
              sort={sort}
              sortKey="after"
            />
          </tr>
        </thead>
        <tbody>
          {rows.map((change) => (
            <tr key={change.field}>
              <td data-label={copy.preparation.sourceChangesField}>
                <strong>{copy.preparation.sourceChangeFields[change.field] ?? change.field}</strong>
              </td>
              <td data-label={copy.preparation.sourceChangesBefore}>{change.before}</td>
              <td data-label={copy.preparation.sourceChangesNow}>{change.after}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SourceRevisionReview({
  csrfToken,
  revision,
  revisions,
  showConfirmation,
}: {
  csrfToken: string;
  revision: number;
  revisions: SourceRevision[];
  showConfirmation: boolean;
}) {
  if (!revisions.length) return null;
  return (
    <section className="card section-gap">
      <h2>{copy.preparation.changesTitle}</h2>
      <p>{copy.preparation.changesIntro}</p>
      <ol className="timeline source-revisions">
        {revisions.map((sourceRevision) => {
          const changes = sourceChanges(sourceRevision);
          return (
            <li key={sourceRevision.id}>
              <strong>Ordine {sourceRevision.display_number}</strong>
              <span>
                {dateTime(sourceRevision.created_at)} · {copy.preparation.changedOrderData}
              </span>
              {changes.length ? (
                <SourceChangesTable changes={changes} />
              ) : (
                <small>{copy.preparation.sourceChangesEmpty}</small>
              )}
            </li>
          );
        })}
      </ol>
      {showConfirmation ? (
        <Form method="post" className="source-revisions__confirmation">
          <input type="hidden" name="csrf" value={csrfToken} />
          <input type="hidden" name="revision" value={revision} />
          <input type="hidden" name="intent" value="review-source-changes" />
          <label className="checkbox-row">
            <input name="confirmSourceReview" required type="checkbox" value="yes" />
            {copy.preparation.sourceReviewConfirmation}
          </label>
          <p>{copy.preparation.sourceReviewHelp}</p>
          <button className="button button--secondary" type="submit">
            {copy.preparation.sourceReviewSubmit}
          </button>
        </Form>
      ) : null}
    </section>
  );
}

function InvoiceLinesTable({ lines }: { lines: InvoiceLine[] }) {
  const { onSort, rows, sort } = useSortableRows<InvoiceLine, InvoiceLineSortKey>(
    lines,
    { key: "description", direction: "asc" },
    invoiceLineValue,
  );
  const originalPosition = new Map(lines.map((line, index) => [line.orderId, index]));
  return (
    <div className="table-wrap section-gap">
      <table className="data-table invoice-lines-table">
        <colgroup>
          <col className="invoice-lines-table__description" />
          <col className="invoice-lines-table__quantity" />
          <col className="invoice-lines-table__amount" />
        </colgroup>
        <thead>
          <tr>
            <SortableHeader
              label={copy.document.description}
              onSort={onSort}
              sort={sort}
              sortKey="description"
            />
            <SortableHeader
              className="table-heading--numeric"
              label={copy.document.quantity}
              onSort={onSort}
              sort={sort}
              sortKey="quantity"
            />
            <SortableHeader
              className="table-heading--numeric"
              label={copy.document.unitAmount}
              onSort={onSort}
              sort={sort}
              sortKey="unitAmount"
            />
          </tr>
        </thead>
        <tbody>
          {rows.map((line) => (
            <tr key={line.orderId}>
              <td data-label={copy.document.description}>
                <input type="hidden" name="documentOrderId" value={line.orderId} />
                <input
                  type="hidden"
                  name="documentLinePosition"
                  value={originalPosition.get(line.orderId)}
                />
                <input
                  aria-label={`${copy.document.description} ${line.orderId}`}
                  defaultValue={line.description}
                  maxLength={1000}
                  name="documentDescription"
                  required
                />
              </td>
              <td className="table-cell--numeric" data-label={copy.document.quantity}>
                <input
                  aria-label={`${copy.document.quantity} ${line.orderId}`}
                  defaultValue={line.quantity}
                  min={1}
                  name="documentQuantity"
                  required
                  type="number"
                />
              </td>
              <td className="table-cell--numeric" data-label={copy.document.unitAmount}>
                <input
                  aria-label={`${copy.document.unitAmount} ${line.orderId}`}
                  defaultValue={(line.unitAmount / 100).toFixed(2)}
                  min="0"
                  name="documentUnitAmount"
                  required
                  step="0.01"
                  type="number"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InvoiceDraftEditor({
  csrfToken,
  dirty,
  onDirty,
  projection,
}: {
  csrfToken: string;
  dirty: boolean;
  onDirty: () => void;
  projection: InvoiceProjection;
}) {
  return (
    <details className="card section-gap preparation-disclosure" open>
      <summary>
        <span>
          <strong>{copy.document.draftTitle}</strong>
          <small>{copy.document.draftIntro}</small>
        </span>
      </summary>
      <Form method="post" className="preparation-edit-form" onChange={onDirty}>
        <input type="hidden" name="csrf" value={csrfToken} />
        <input type="hidden" name="intent" value="save-document" />
        <input type="hidden" name="revision" value={projection.caseRevision} />
        <input type="hidden" name="draftVersion" value={projection.draftVersion} />
        <p>{copy.document.approvalDate(date(projection.documentDate))}</p>
        <InvoiceLinesTable lines={projection.lines} />
        <div className="detail-grid section-gap">
          <label>
            {copy.document.paymentStatus}
            <select defaultValue={projection.paymentStatus} name="paymentStatus">
              <option value="PAID">{copy.document.paymentPaid}</option>
              <option value="PENDING">{copy.document.paymentPending}</option>
            </select>
          </label>
          <label>
            {copy.document.paymentMethod}
            <select defaultValue={projection.paymentMethod} name="paymentMethod">
              <option value="MP01">{copy.document.paymentCash}</option>
              <option value="MP05">{copy.document.paymentTransfer}</option>
              <option value="MP08">{copy.document.paymentCard}</option>
            </select>
          </label>
        </div>
        <div className="preparation-edit-form__fields section-gap">
          <label>
            {copy.document.causale}
            <input defaultValue={projection.causale} maxLength={200} name="causale" />
          </label>
          <label>
            {copy.document.notes}
            <input defaultValue={projection.notes} maxLength={200} name="notes" />
          </label>
          <label className="preparation-edit-form__wide-field">
            {copy.document.differenceReason}
            <input
              defaultValue={projection.differenceReason}
              maxLength={500}
              name="differenceReason"
            />
          </label>
        </div>
        <button className="button preparation-edit-form__submit" disabled={!dirty} type="submit">
          {copy.document.saveDraft}
        </button>
      </Form>
    </details>
  );
}

function InvoiceComparisonCard({ projection }: { projection: InvoiceProjection }) {
  return (
    <section className="card preparation-check section-gap" aria-labelledby="comparatore-fiscale">
      <DetailSectionHeader
        description={copy.document.comparisonHelp}
        icon={<CircleCheck size={22} strokeWidth={1.8} />}
        title={copy.document.comparisonTitle}
      />
      <p className="preparation-check__status">
        <CircleCheck aria-hidden="true" size={20} strokeWidth={2} />
        <span>
          <strong>{copy.document.checksPassed}</strong>
          <small>{copy.document.xsdValid}</small>
        </span>
      </p>
      <dl className="facts facts--columns preparation-check__facts">
        <div>
          <dt>{copy.document.grossTotal}</dt>
          <dd>{euros(projection.grossTotal)}</dd>
        </div>
        <div>
          <dt>{copy.document.shopifyPaymentsFeeTotal}</dt>
          <dd>{euros(projection.shopifyPaymentsFeeTotal)}</dd>
        </div>
        <div>
          <dt>{copy.document.sourceTotal}</dt>
          <dd>{euros(projection.sourceTotal)}</dd>
        </div>
        <div>
          <dt>{copy.document.documentTotal}</dt>
          <dd>{euros(projection.total)}</dd>
        </div>
        <div>
          <dt>{copy.document.difference}</dt>
          <dd>{euros(projection.difference)}</dd>
        </div>
        <div>
          <dt>{copy.document.profile}</dt>
          <dd>RF14 · N5 · FPR · {copy.document.profileVersion(projection.profileVersion)}</dd>
        </div>
      </dl>
      <details className="preparation-comparison-details">
        <summary>{copy.document.comparisonDetails}</summary>
        <div className="comparison-grid">
          <ComparisonTable
            title={copy.document.comparisonRecipient}
            rows={projection.comparison.recipient}
          />
          <ComparisonTable
            lineLabels
            title={copy.document.comparisonLines}
            rows={projection.comparison.lines}
          />
          <ComparisonTable
            title={copy.document.comparisonPayment}
            rows={projection.comparison.payment}
          />
          <ComparisonTable
            title={copy.document.comparisonNotes}
            rows={projection.comparison.notes}
          />
          <ComparisonTable
            title={copy.document.comparisonTechnical}
            rows={projection.comparison.technical}
          />
          <details className="technical-details">
            <summary>
              <FileCode2 aria-hidden="true" size={18} strokeWidth={1.8} />
              {copy.document.technicalXml}
            </summary>
            <pre className="code-block">{projection.xml}</pre>
          </details>
        </div>
      </details>
    </section>
  );
}

function ArubaInventoryCard({ projection }: { projection: InvoiceProjection }) {
  return (
    <section
      className={`card preparation-inventory preparation-inventory--${projection.arubaInventory.blocking ? "blocking" : "warning"}`}
      aria-labelledby="inventario-aruba"
    >
      <h2 id="inventario-aruba">{copy.document.arubaInventoryTitle}</h2>
      <p>
        <strong>{copy.settings.arubaInventoryLabels[projection.arubaInventory.status]}</strong>
        {" · "}
        {projection.arubaInventory.lastCompletedAt
          ? copy.document.arubaInventoryUpdated(dateTime(projection.arubaInventory.lastCompletedAt))
          : copy.document.arubaInventoryNever}
      </p>
      <p>
        {projection.arubaInventory.blocking
          ? copy.document.arubaInventoryBlockingHelp
          : copy.document.arubaInventoryWarningHelp}
      </p>
      <Link className="button button--secondary" to="/">
        {copy.document.openDashboard}
      </Link>
    </section>
  );
}

function ApprovalCard({
  canApprove,
  canShowApproval,
  caseReady,
  csrfToken,
  hasUnsavedChanges,
  publicNumber,
  projection,
}: {
  canApprove: boolean;
  canShowApproval: boolean;
  caseReady: boolean;
  csrfToken: string;
  hasUnsavedChanges: boolean;
  publicNumber: string;
  projection: InvoiceProjection;
}) {
  return (
    <section
      className={`card preparation-approval${canShowApproval ? "" : " preparation-approval--compact"}`}
      aria-labelledby="approvazione-fattura"
    >
      <DetailSectionHeader
        description={copy.document.approvalHelp}
        icon={<CircleCheck size={22} strokeWidth={1.8} />}
        title={copy.document.approvalTitle}
      />
      {hasUnsavedChanges ? (
        <p className="notice">{copy.document.saveChangesBeforeApproval}</p>
      ) : !caseReady ? (
        <p className="warning">{copy.document.resolveChecksBeforeApproval}</p>
      ) : projection.requiresResave ? (
        <p className="notice">{copy.document.resaveAfterDateChange}</p>
      ) : !canApprove ? (
        <p className="notice">{copy.document.ownerOnly}</p>
      ) : projection.arubaInventory.blocking ? (
        <p className="warning">{copy.document.arubaInventoryApprovalBlocked}</p>
      ) : null}
      {canShowApproval ? (
        <Form method="post" className="preparation-approval__form">
          <input type="hidden" name="csrf" value={csrfToken} />
          <input type="hidden" name="intent" value="approve-document" />
          <input type="hidden" name="revision" value={projection.caseRevision} />
          <input type="hidden" name="draftVersion" value={projection.draftVersion} />
          <input type="hidden" name="projectionSha256" value={projection.projectionSha256} />
          <input type="hidden" name="arubaMode" value={projection.arubaMode} />
          <input type="hidden" name="emailModeVersion" value={projection.customerEmail.version} />
          <fieldset>
            <legend>{copy.document.customerEmailTitle}</legend>
            <dl className="facts facts--columns">
              <div>
                <dt>{copy.document.emailMode}</dt>
                <dd>
                  {projection.customerEmail.mode === "AUTOMATIC"
                    ? copy.document.emailAutomatic
                    : projection.customerEmail.mode === "DISABLED"
                      ? copy.document.emailDisabled
                      : copy.document.emailManual}
                </dd>
              </div>
              <div>
                <dt>{copy.document.emailSender}</dt>
                <dd>{projection.customerEmail.sender}</dd>
              </div>
              <div>
                <dt>{copy.document.emailRecipient}</dt>
                <dd>{projection.customerEmail.recipient ?? copy.common.unavailable}</dd>
              </div>
              <div>
                <dt>{copy.document.emailSubject}</dt>
                <dd>{projection.customerEmail.subject}</dd>
              </div>
              <div>
                <dt>{copy.document.emailBody}</dt>
                <dd>{projection.customerEmail.body}</dd>
              </div>
              <div>
                <dt>{copy.document.emailAttachment}</dt>
                <dd>{projection.customerEmail.attachment}</dd>
              </div>
            </dl>
            {projection.customerEmail.mode === "DISABLED" ? (
              <>
                <input name="emailChoice" type="hidden" value="SKIP" />
                <p className="notice">{copy.document.emailDisabledHelp}</p>
              </>
            ) : (
              <>
                <label className="checkbox-row">
                  <input
                    defaultChecked={
                      projection.customerEmail.mode === "AUTOMATIC" &&
                      Boolean(projection.customerEmail.recipient)
                    }
                    name="emailChoice"
                    type="radio"
                    value="SEND"
                  />
                  {copy.document.emailSend}
                </label>
                <label className="checkbox-row">
                  <input
                    defaultChecked={
                      projection.customerEmail.mode !== "AUTOMATIC" ||
                      !projection.customerEmail.recipient
                    }
                    name="emailChoice"
                    type="radio"
                    value="SKIP"
                  />
                  {copy.document.emailSkip}
                </label>
              </>
            )}
          </fieldset>
          {projection.paymentPending ? (
            <label className="checkbox-row">
              <input name="confirmPending" required type="checkbox" value="yes" />
              {copy.document.confirmPending}
            </label>
          ) : null}
          {projection.difference !== 0 ? (
            <label className="checkbox-row">
              <input name="confirmDifference" required type="checkbox" value="yes" />
              {copy.document.confirmDifference}
            </label>
          ) : null}
          <fieldset className="preparation-approval__confirmation">
            <legend>{copy.document.finalConfirmation}</legend>
            <dl className="facts facts--columns">
              <div>
                <dt>{copy.document.confirmDocument}</dt>
                <dd>{copy.preparation.title(publicNumber)}</dd>
              </div>
              <div>
                <dt>{copy.document.confirmRecipient}</dt>
                <dd>{projection.comparison.recipient[0]?.draft}</dd>
              </div>
              <div>
                <dt>{copy.document.confirmTotal}</dt>
                <dd>{euros(projection.total)}</dd>
              </div>
              <div>
                <dt>{copy.document.confirmProfile}</dt>
                <dd>RF14 · N5 · FPR · {copy.document.profileVersion(projection.profileVersion)}</dd>
              </div>
              <div>
                <dt>{copy.document.confirmPayment}</dt>
                <dd>
                  {paymentStatusLabels[projection.paymentStatus]} · {projection.paymentMethod}
                </dd>
              </div>
            </dl>
            <p className="warning">{copy.document.irreversibleNumbering}</p>
          </fieldset>
          <button className="button preparation-approval__submit" type="submit">
            {copy.document.approve}
          </button>
        </Form>
      ) : null}
    </section>
  );
}

function InvoiceDocument({
  canApprove,
  caseReady,
  customerDirty,
  csrfToken,
  activity,
  publicNumber,
  projection,
}: {
  canApprove: boolean;
  caseReady: boolean;
  customerDirty: boolean;
  csrfToken: string;
  activity: ReactNode;
  publicNumber: string;
  projection: InvoiceProjection;
}) {
  const [draftDirty, setDraftDirty] = useState(false);
  const inventoryNeedsAttention = projection.arubaInventory.status !== "HEALTHY";
  const hasUnsavedChanges = draftDirty || customerDirty;
  const canShowApproval =
    !projection.approved &&
    canApprove &&
    caseReady &&
    !hasUnsavedChanges &&
    !projection.requiresResave &&
    !projection.arubaInventory.blocking;
  const showInventory = !projection.approved && inventoryNeedsAttention;
  const showApproval = !projection.approved;
  const workflowLayout = projection.approved
    ? "preparation-workflow-grid--activity-only"
    : showInventory
      ? canShowApproval
        ? "preparation-workflow-grid--with-inventory preparation-workflow-grid--expanded-approval"
        : "preparation-workflow-grid--with-inventory preparation-workflow-grid--compact-approval"
      : "preparation-workflow-grid--without-inventory";
  return (
    <>
      {!projection.approved ? (
        <InvoiceDraftEditor
          csrfToken={csrfToken}
          dirty={draftDirty}
          onDirty={() => setDraftDirty(true)}
          projection={projection}
        />
      ) : null}
      <InvoiceComparisonCard projection={projection} />
      <div className={`preparation-workflow-grid section-gap ${workflowLayout}`}>
        {showInventory ? <ArubaInventoryCard projection={projection} /> : null}
        {showApproval ? (
          <ApprovalCard
            canApprove={canApprove}
            canShowApproval={canShowApproval}
            caseReady={caseReady}
            csrfToken={csrfToken}
            hasUnsavedChanges={hasUnsavedChanges}
            projection={projection}
            publicNumber={publicNumber}
          />
        ) : null}
        {activity}
      </div>
    </>
  );
}

function ActivityCard({
  audit,
}: {
  audit: Array<{ id: string; action: string; created_at: string; reason: string | null }>;
}) {
  return (
    <section className="card preparation-activity">
      <h2>{copy.preparation.activity}</h2>
      {audit.length ? (
        <ol className="timeline">
          {audit.map((event) => (
            <li key={event.id}>
              <strong>{auditActionLabel(event.action) ?? copy.activity.recorded}</strong>
              <span>{dateTime(event.created_at)}</span>
              {event.reason ? <span>{event.reason}</span> : null}
            </li>
          ))}
        </ol>
      ) : (
        <p>{copy.preparation.noActivity}</p>
      )}
    </section>
  );
}

export default function BillingCaseDetail() {
  const { username, canApprove, csrfToken, billingCase, projection, storagePending } =
    useLoaderData<typeof loader>();
  const error = useActionData<typeof action>();
  const [customerDirty, setCustomerDirty] = useState(false);
  const total = billingCase.orders.reduce((sum, order) => sum + order.billable_amount, 0);
  const editable = ["DRAFT", "READY", "NEEDS_REVIEW"].includes(billingCase.status);
  const revisionField = <input type="hidden" name="revision" value={billingCase.revision} />;
  const csrfField = <input type="hidden" name="csrf" value={csrfToken} />;
  return (
    <AppShell username={username} canApprove={canApprove} csrfToken={csrfToken}>
      <div className="title-block">
        <p className="eyebrow">{copy.preparation.eyebrow}</p>
        <h1>{copy.preparation.title(billingCase.public_number)}</h1>
        <p>
          {billingCase.customer_name} · {date(billingCase.local_order_date)} · {euros(total)}
        </p>
      </div>
      {error ? (
        <p className="error" role="alert">
          {error.message}
        </p>
      ) : null}
      {storagePending ? (
        <p className="warning" role="status">
          {copy.document.storagePending}
        </p>
      ) : null}
      {billingCase.status === "NEEDS_REVIEW" ? (
        <p className="warning" role="status">
          {copy.preparation.reviewWarning}
        </p>
      ) : null}
      {billingCase.status === "DO_NOT_TRANSMIT" ? (
        <p className="warning" role="status">
          {billingCase.do_not_transmit_reason ?? copy.preparation.notTransmittedDefault}
        </p>
      ) : null}
      {billingCase.anomalies.length ? (
        <section className="card section-gap" aria-labelledby="anomalie">
          <h2 id="anomalie">{copy.preparation.checksTitle}</h2>
          <ul className="plain-list">
            {billingCase.anomalies.map((code) => (
              <li key={code}>
                <strong>{anomalyLabels[code]?.title ?? "Verifica richiesta"}</strong>
                <span>{anomalyLabels[code]?.action ?? copy.preparation.checkFallback}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div
        className={`detail-grid preparation-overview${billingCase.anomalies.length ? " section-gap" : ""}`}
      >
        <section className="card">
          <h2>{copy.preparation.includedOrders}</h2>
          <ul className="plain-list">
            {billingCase.orders.map((order) => (
              <li key={order.id}>
                <Link to={`/ordini/${order.id}`}>
                  {order.provider === "SHOPIFY" ? "Shopify" : "eBay"} {order.display_number}
                </Link>
                <span>
                  {paymentStatusLabels[order.payment_status] ?? "Pagamento da verificare"} ·{" "}
                  {euros(order.billable_amount)}
                  {order.deducted_shopify_payments_fee_amount > 0
                    ? ` · commissione Shopify Payments −${euros(order.deducted_shopify_payments_fee_amount)}`
                    : ""}
                </span>
                {editable && billingCase.orders.length > 1 ? (
                  <Form method="post">
                    {csrfField}
                    {revisionField}
                    <input type="hidden" name="intent" value="separate-order" />
                    <input type="hidden" name="orderId" value={order.id} />
                    <button className="button button--secondary" type="submit">
                      Separa dalla preparazione
                    </button>
                  </Form>
                ) : null}
              </li>
            ))}
          </ul>
          {editable && billingCase.addableOrders.length ? (
            <Form method="post" className="inline-form section-gap">
              {csrfField}
              {revisionField}
              <input type="hidden" name="intent" value="add-order" />
              <label>
                Aggiungi un ordine compatibile
                <select name="orderId">
                  {billingCase.addableOrders.map((order) => (
                    <option key={order.id} value={order.id}>
                      {order.provider === "SHOPIFY" ? "Shopify" : "eBay"} {order.display_number} ·{" "}
                      {euros(order.billable_amount)}
                    </option>
                  ))}
                </select>
              </label>
              <button className="button button--secondary" type="submit">
                Aggiungi
              </button>
            </Form>
          ) : null}
        </section>
        <section className="card">
          <h2>{copy.preparation.summary}</h2>
          <dl className="facts">
            <div>
              <dt>{copy.preparation.currentStatus}</dt>
              <dd>{billingCaseStatusLabels[billingCase.status] ?? copy.common.unknownStatus}</dd>
            </div>
            <div>
              <dt>{copy.preparation.currency}</dt>
              <dd>{billingCase.currency}</dd>
            </div>
            <div>
              <dt>{copy.preparation.orders}</dt>
              <dd>{billingCase.orders.length}</dd>
            </div>
            <div>
              <dt>{copy.preparation.customerRecord}</dt>
              <dd>
                {billingCase.customer_corrected_at
                  ? `Corretta il ${dateTime(billingCase.customer_corrected_at)}`
                  : copy.preparation.customerRecordOriginal}
              </dd>
            </div>
          </dl>
          {billingCase.status === "DO_NOT_TRANSMIT" && !billingCase.reactivation_blocker ? (
            <Form method="post" className="section-gap">
              {csrfField}
              {revisionField}
              <input type="hidden" name="intent" value="reactivate" />
              <button className="button button--secondary" type="submit">
                {copy.preparation.reactivate}
              </button>
            </Form>
          ) : billingCase.status === "DO_NOT_TRANSMIT" ? (
            <p className="notice section-gap">
              {reactivationBlockerMessages[billingCase.reactivation_blocker ?? ""] ??
                copy.preparation.archivedOnly}
            </p>
          ) : editable ? (
            <Form method="post" className="section-gap">
              {csrfField}
              {revisionField}
              <input type="hidden" name="intent" value="do-not-transmit" />
              <div className="field-with-help">
                <label>
                  {copy.preparation.reason}
                  <input
                    aria-describedby={error ? "case-error reason-help" : "reason-help"}
                    aria-invalid={error ? true : undefined}
                    maxLength={500}
                    name="reason"
                    required
                  />
                </label>
                <small className="field-help" id="reason-help">
                  {copy.preparation.reasonHelp}
                </small>
              </div>
              {error ? (
                <p className="error" id="case-error">
                  {error.message}
                </p>
              ) : null}
              <button className="button button--warning" type="submit">
                {copy.preparation.doNotTransmit}
              </button>
            </Form>
          ) : null}
        </section>
      </div>

      {editable ? (
        <CustomerEditor
          csrfToken={csrfToken}
          customer={billingCase.customer_snapshot_json}
          onDirty={() => setCustomerDirty(true)}
          revision={billingCase.revision}
        />
      ) : null}
      {projection && "profileMissing" in projection && projection.profileMissing ? (
        <p className="warning section-gap">{copy.document.profileMissing}</p>
      ) : projection && "error" in projection ? (
        <p className="warning section-gap">{projection.error}</p>
      ) : projection && "lines" in projection ? (
        <InvoiceDocument
          activity={<ActivityCard audit={billingCase.audit} />}
          canApprove={canApprove}
          caseReady={billingCase.status === "READY"}
          customerDirty={customerDirty}
          csrfToken={csrfToken}
          projection={projection}
          publicNumber={billingCase.public_number}
        />
      ) : null}
      <SourceRevisionReview
        csrfToken={csrfToken}
        revision={billingCase.revision}
        revisions={billingCase.revisions}
        showConfirmation={billingCase.anomalies.includes("SOURCE_CONFLICT")}
      />
      {projection && "lines" in projection ? null : (
        <div className="section-gap">
          <ActivityCard audit={billingCase.audit} />
        </div>
      )}
    </AppShell>
  );
}
