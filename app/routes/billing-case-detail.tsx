import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/billing-case-detail";

import { actionResult } from "../action";
import { AppShell } from "../components/app-shell";
import { CustomerEditor } from "../components/customer-editor";
import {
  anomalyLabels,
  auditActionLabel,
  billingCaseStatusLabels,
  copy,
  paymentStatusLabels,
  reactivationBlockerMessages,
} from "../copy.it";
import { date, dateTime, euros } from "../format";
import { assertCsrf, requestId, requireSessionUser } from "../../src/db/auth.server.ts";
import { readForm } from "../../src/http.server.ts";
import { decimalToCents } from "../../src/orders.ts";
import { AppError } from "../../src/errors.ts";
import {
  approveInvoice,
  getInvoiceProjection,
  saveInvoiceDraft,
} from "../../src/db/documents.server.ts";
import {
  addOrderToBillingCase,
  correctBillingCaseCustomer,
  getBillingCase,
  separateOrderFromBillingCase,
  updateBillingCaseTransmission,
} from "../../src/db/orders.server.ts";

interface Actor {
  id: number;
  canApprove: boolean;
  requestId: string;
}

function runIntent(
  intent: string | null,
  caseId: string,
  form: URLSearchParams,
  revision: string | null,
  actor: Actor,
) {
  if (intent === "save-document") {
    let lines;
    try {
      const orderIds = form.getAll("documentOrderId");
      const descriptions = form.getAll("documentDescription");
      const quantities = form.getAll("documentQuantity");
      const amounts = form.getAll("documentUnitAmount");
      lines = orderIds.map((orderId, index) => ({
        orderId,
        description: descriptions[index],
        quantity: Number(quantities[index]),
        unitAmount: decimalToCents(amounts[index] ?? ""),
      }));
    } catch {
      throw new AppError("DOCUMENT_INVALID", 422);
    }
    return saveInvoiceDraft(
      caseId,
      {
        caseRevision: revision,
        draftVersion: form.get("draftVersion"),
        differenceReason: form.get("differenceReason"),
        paymentStatus: form.get("paymentStatus"),
        paymentMethod: form.get("paymentMethod"),
        causale: form.get("causale"),
        notes: form.get("notes"),
        lines,
      },
      actor,
    );
  }
  if (intent === "approve-document") {
    return approveInvoice(
      caseId,
      {
        caseRevision: revision,
        draftVersion: form.get("draftVersion"),
        projectionSha256: form.get("projectionSha256"),
        confirmApproval: form.get("confirmApproval") === "yes",
        confirmPending: form.get("confirmPending") === "yes",
        confirmDifference: form.get("confirmDifference") === "yes",
        arubaMode: form.get("arubaMode"),
      },
      actor,
    );
  }
  if (intent === "do-not-transmit") {
    return updateBillingCaseTransmission(caseId, form.get("reason") ?? "", revision, actor);
  }
  if (intent === "reactivate") {
    return updateBillingCaseTransmission(caseId, null, revision, actor);
  }
  if (intent === "separate-order") {
    return separateOrderFromBillingCase(caseId, form.get("orderId") ?? "", revision, actor);
  }
  if (intent === "add-order") {
    return addOrderToBillingCase(caseId, form.get("orderId") ?? "", revision, actor);
  }
  if (intent !== "correct-customer") return Promise.resolve("unknown" as const);
  const types = form.getAll("taxType");
  const countries = form.getAll("taxCountryCode");
  return correctBillingCaseCustomer(
    caseId,
    {
      kind: form.get("kind"),
      displayName: form.get("displayName"),
      firstName: form.get("firstName"),
      lastName: form.get("lastName"),
      companyName: form.get("companyName"),
      email: form.get("email"),
      certifiedEmail: form.get("certifiedEmail"),
      recipientCode: form.get("recipientCode"),
      phone: form.get("phone"),
      billingAddress: {
        line1: form.get("line1"),
        line2: form.get("line2"),
        postalCode: form.get("postalCode"),
        city: form.get("city"),
        province: form.get("province"),
        countryCode: form.get("countryCode"),
      },
      // Un valore vuoto rimuove la riga; tutte le altre sopravvivono alla correzione.
      taxIdentifiers: form.getAll("taxValue").flatMap((value, index) =>
        value.trim()
          ? [
              {
                type: types[index],
                value: value.trim(),
                countryCode: countries[index],
                sourceField: "correzione-manuale",
              },
            ]
          : [],
      ),
    },
    revision,
    form.get("reason"),
    actor,
  );
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const billingCase = await getBillingCase(params.caseId);
  if (!billingCase) throw new Response("Preparazione non trovata", { status: 404 });
  const projection = await getInvoiceProjection(params.caseId).catch((error: unknown) => {
    if (error instanceof AppError) return { error: error.message } as const;
    throw error;
  });
  return {
    username: user.username,
    canApprove: user.canApprove,
    csrfToken: user.csrfToken,
    billingCase,
    projection,
    storagePending: new URL(request.url).searchParams.get("archiviazione") === "pendente",
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  return actionResult(async () => {
    const user = await requireSessionUser(request);
    const form = await readForm(request);
    assertCsrf(user, form.get("csrf") ?? "");
    const outcome = await runIntent(form.get("intent"), params.caseId, form, form.get("revision"), {
      id: user.id,
      canApprove: user.canApprove,
      requestId: requestId(request),
    });
    if (outcome === "unknown") throw new Response("Azione non riconosciuta", { status: 400 });
    if (outcome === null) throw new Response("Preparazione non trovata", { status: 404 });
    const storagePending =
      typeof outcome === "object" &&
      outcome !== null &&
      "storagePending" in outcome &&
      outcome.storagePending === true;
    return redirect(
      `/ordini/preparazione/${params.caseId}${storagePending ? "?archiviazione=pendente" : ""}`,
    );
  });
}

type InvoiceProjection = Extract<
  NonNullable<Awaited<ReturnType<typeof getInvoiceProjection>>>,
  { profileMissing: false }
>;

interface ComparisonRow {
  field: string;
  source: string;
  draft: string;
  projected: string;
}

function ComparisonTable({
  title,
  rows,
  lineLabels = false,
}: {
  title: string;
  rows: ComparisonRow[];
  lineLabels?: boolean;
}) {
  const labels = copy.document.comparisonLabels as Record<string, string>;
  return (
    <div className="table-wrap section-gap">
      <table>
        <caption>{title}</caption>
        <thead>
          <tr>
            <th>{copy.document.comparisonField}</th>
            <th>{copy.document.comparisonSource}</th>
            <th>{copy.document.comparisonDraft}</th>
            <th>{copy.document.comparisonProjection}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.field}>
              <th scope="row">
                {lineLabels ? copy.document.comparisonLine(row.field) : labels[row.field]}
              </th>
              <td data-label={copy.document.comparisonSource}>{row.source}</td>
              <td data-label={copy.document.comparisonDraft}>{row.draft}</td>
              <td data-label={copy.document.comparisonProjection}>{row.projected}</td>
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
            <div className="table-wrap section-gap">
              <table>
                <thead>
                  <tr>
                    <th>{copy.document.description}</th>
                    <th>{copy.document.quantity}</th>
                    <th>{copy.document.unitAmount}</th>
                  </tr>
                </thead>
                <tbody>
                  {projection.lines.map((line) => (
                    <tr key={line.orderId}>
                      <td data-label={copy.document.description}>
                        <input type="hidden" name="documentOrderId" value={line.orderId} />
                        <input
                          aria-label={`${copy.document.description} ${line.orderId}`}
                          defaultValue={line.description}
                          maxLength={1000}
                          name="documentDescription"
                          required
                        />
                      </td>
                      <td data-label={copy.document.quantity}>
                        <input
                          aria-label={`${copy.document.quantity} ${line.orderId}`}
                          defaultValue={line.quantity}
                          min={1}
                          name="documentQuantity"
                          required
                          type="number"
                        />
                      </td>
                      <td data-label={copy.document.unitAmount}>
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
      <section className="card section-gap" aria-labelledby="comparatore-fiscale">
        <h2 id="comparatore-fiscale">{copy.document.comparisonTitle}</h2>
        <p>{copy.document.xsdValid}</p>
        <dl className="facts facts--columns">
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
  const total = billingCase.orders.reduce((sum, order) => sum + order.gross_amount, 0);
  const editable = ["DRAFT", "READY", "NEEDS_REVIEW"].includes(billingCase.status);
  const revisionField = <input type="hidden" name="revision" value={billingCase.revision} />;
  const csrfField = <input type="hidden" name="csrf" value={csrfToken} />;
  return (
    <AppShell username={username} csrfToken={csrfToken}>
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
                  {euros(order.gross_amount)}
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
                      {euros(order.gross_amount)}
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
