import { Form, Link, useActionData, useLoaderData } from "react-router";

import { AppShell } from "../components/app-shell";
import { ComparisonTable } from "../components/comparison-table";
import { CustomerEditor } from "../components/customer-editor";
import { SortableHeader, useSortableRows } from "../components/sortable-table";
import {
  anomalyLabels,
  auditActionLabel,
  billingCaseStatusLabels,
  copy,
  paymentStatusLabels,
  reactivationBlockerMessages,
} from "../copy.it";
import { date, dateTime, euros } from "../format";
import type { SortValue } from "../table-sort";
import type { getInvoiceProjection } from "../../src/db/documents.server.ts";
import { action, loader } from "./billing-case-detail.server.ts";

export { action, loader };

type InvoiceProjection = Extract<
  NonNullable<Awaited<ReturnType<typeof getInvoiceProjection>>>,
  { profileMissing: false }
>;

type InvoiceLine = InvoiceProjection["lines"][number];
type InvoiceLineSortKey = "description" | "quantity" | "unitAmount";

function invoiceLineValue(line: InvoiceLine, key: InvoiceLineSortKey): SortValue {
  return line[key];
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

function InvoiceDocument({
  canApprove,
  csrfToken,
  publicNumber,
  projection,
}: {
  canApprove: boolean;
  csrfToken: string;
  publicNumber: string;
  projection: InvoiceProjection;
}) {
  return (
    <>
      {!projection.approved ? (
        <section className="card section-gap" aria-labelledby="bozza-fiscale">
          <h2 id="bozza-fiscale">{copy.document.draftTitle}</h2>
          <p>{copy.document.draftIntro}</p>
          <Form method="post">
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
            <label className="section-gap">
              {copy.document.causale}
              <input defaultValue={projection.causale} maxLength={200} name="causale" />
            </label>
            <label className="section-gap">
              {copy.document.notes}
              <input defaultValue={projection.notes} maxLength={200} name="notes" />
            </label>
            <label className="section-gap">
              {copy.document.differenceReason}
              <input
                defaultValue={projection.differenceReason}
                maxLength={500}
                name="differenceReason"
              />
            </label>
            <button className="button section-gap" type="submit">
              {copy.document.saveDraft}
            </button>
          </Form>
        </section>
      ) : null}
      <section className="card comparison-grid section-gap" aria-labelledby="comparatore-fiscale">
        <h2 id="comparatore-fiscale">{copy.document.comparisonTitle}</h2>
        <p>{copy.document.xsdValid}</p>
        <dl className="facts facts--columns">
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
        <ComparisonTable title={copy.document.comparisonNotes} rows={projection.comparison.notes} />
        <ComparisonTable
          title={copy.document.comparisonTechnical}
          rows={projection.comparison.technical}
        />
        <details className="section-gap">
          <summary>{copy.document.technicalXml}</summary>
          <pre className="code-block">{projection.xml}</pre>
        </details>
        {!projection.approved && projection.draftVersion === 0 ? (
          <p className="notice section-gap">{copy.document.saveBeforeApproval}</p>
        ) : !projection.approved && projection.requiresResave ? (
          <p className="notice section-gap">{copy.document.resaveAfterDateChange}</p>
        ) : !projection.approved && !canApprove ? (
          <p className="notice section-gap">{copy.document.ownerOnly}</p>
        ) : !projection.approved ? (
          <Form method="post" className="section-gap">
            <input type="hidden" name="csrf" value={csrfToken} />
            <input type="hidden" name="intent" value="approve-document" />
            <input type="hidden" name="revision" value={projection.caseRevision} />
            <input type="hidden" name="draftVersion" value={projection.draftVersion} />
            <input type="hidden" name="projectionSha256" value={projection.projectionSha256} />
            <input type="hidden" name="arubaMode" value={projection.arubaMode} />
            <input type="hidden" name="emailModeVersion" value={projection.customerEmail.version} />
            <fieldset className="section-gap">
              <legend>{copy.document.customerEmailTitle}</legend>
              <dl className="facts facts--columns">
                <div>
                  <dt>{copy.document.emailMode}</dt>
                  <dd>
                    {projection.customerEmail.mode === "AUTOMATIC"
                      ? copy.document.emailAutomatic
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
            <fieldset className="section-gap">
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
                  <dd>
                    RF14 · N5 · FPR · {copy.document.profileVersion(projection.profileVersion)}
                  </dd>
                </div>
                <div>
                  <dt>{copy.document.confirmPayment}</dt>
                  <dd>
                    {paymentStatusLabels[projection.paymentStatus]} · {projection.paymentMethod}
                  </dd>
                </div>
                <div>
                  <dt>{copy.document.confirmHelper}</dt>
                  <dd>
                    {projection.arubaMode === "AUTOMATIC"
                      ? copy.document.automaticHelperMode
                      : copy.document.assistedHelperMode}
                  </dd>
                </div>
              </dl>
              <p className="warning">{copy.document.irreversibleNumbering}</p>
              <label className="checkbox-row">
                <input name="confirmApproval" required type="checkbox" value="yes" />
                {copy.document.confirmApproval}
              </label>
            </fieldset>
            <button className="button" type="submit">
              {copy.document.approve}
            </button>
          </Form>
        ) : null}
      </section>
    </>
  );
}

export default function BillingCaseDetail() {
  const { username, canApprove, csrfToken, billingCase, projection, storagePending } =
    useLoaderData<typeof loader>();
  const error = useActionData<typeof action>();
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

      <div className={`detail-grid${billingCase.anomalies.length ? " section-gap" : ""}`}>
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
          revision={billingCase.revision}
        />
      ) : null}
      {projection && "profileMissing" in projection && projection.profileMissing ? (
        <p className="warning section-gap">{copy.document.profileMissing}</p>
      ) : projection && "error" in projection ? (
        <p className="warning section-gap">{projection.error}</p>
      ) : projection && "lines" in projection ? (
        <InvoiceDocument
          canApprove={canApprove}
          csrfToken={csrfToken}
          projection={projection}
          publicNumber={billingCase.public_number}
        />
      ) : null}
      {billingCase.revisions.length ? (
        <section className="card section-gap">
          <h2>{copy.preparation.changesTitle}</h2>
          <p>{copy.preparation.changesIntro}</p>
          <ol className="timeline">
            {billingCase.revisions.map(
              (revision: { id: string; display_number: string; created_at: string }) => (
                <li key={revision.id}>
                  <strong>Ordine {revision.display_number}</strong>
                  <span>
                    {dateTime(revision.created_at)} · {copy.preparation.changedOrderData}
                  </span>
                </li>
              ),
            )}
          </ol>
        </section>
      ) : null}
      <section className="card section-gap">
        <h2>{copy.preparation.activity}</h2>
        {billingCase.audit.length ? (
          <ol className="timeline">
            {billingCase.audit.map((event) => (
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
    </AppShell>
  );
}
