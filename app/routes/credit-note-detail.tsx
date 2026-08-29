import { ArrowLeft, BadgeEuro, CircleCheck, FileCode2, Mail } from "lucide-react";
import { data, Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/credit-note-detail";

import { AppShell } from "../components/app-shell";
import { ComparisonTable } from "../components/comparison-table";
import { DetailSectionHeader } from "../components/detail-section-header";
import { copy } from "../copy.it";
import { date, euros } from "../format";
import { privateRouteMeta } from "../metadata";
import { assertCsrf, requestId, requireSessionUser } from "../../src/db/auth.server.ts";
import { approveCreditNote, getCreditNoteProjection } from "../../src/db/refunds.server.ts";
import { publicError } from "../../src/errors.ts";
import { readForm } from "../../src/http.server.ts";

export function meta({ error }: Route.MetaArgs) {
  return privateRouteMeta("creditNote", { error });
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const note = await getCreditNoteProjection(params.documentId);
  if (!note) throw new Response("Nota di credito non trovata", { status: 404 });
  return {
    username: user.username,
    canApprove: user.canApprove,
    csrfToken: user.csrfToken,
    note,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  try {
    const user = await requireSessionUser(request);
    const form = await readForm(request);
    assertCsrf(user, form.get("csrf") ?? "");
    await approveCreditNote(
      params.documentId,
      {
        draftVersion: form.get("draftVersion"),
        projectionSha256: form.get("projectionSha256"),
        confirmApproval: form.get("confirmApproval") === "yes",
        arubaMode: form.get("arubaMode"),
        confirmArubaDowngrade: form.get("confirmArubaDowngrade") === "yes",
        emailChoice: form.get("emailChoice"),
        emailModeVersion: form.get("emailModeVersion"),
      },
      { id: user.id, canApprove: user.canApprove, requestId: requestId(request) },
    );
    return redirect("/documenti");
  } catch (error) {
    if (error instanceof Response) throw error;
    const result = publicError(error);
    return data(result, { status: result.status });
  }
}

export default function CreditNoteDetail() {
  const { username, canApprove, csrfToken, note } = useLoaderData<typeof loader>();
  const error = useActionData<typeof action>();
  return (
    <AppShell username={username} canApprove={canApprove} csrfToken={csrfToken}>
      <div className="title-block dashboard-title detail-page-title">
        <p className="eyebrow">{copy.creditNote.eyebrow}</p>
        <h1>{copy.creditNote.title}</h1>
        <p>{copy.creditNote.sourceInvoice(note.invoiceNumber, date(note.invoiceDate))}</p>
      </div>
      {error ? (
        <p className="error" role="alert">
          {error.message}
        </p>
      ) : null}
      <section className="dashboard-panel credit-note-balance">
        <DetailSectionHeader
          description={copy.creditNote.balanceHelp}
          icon={<BadgeEuro size={22} strokeWidth={1.8} />}
          title={copy.creditNote.balanceTitle}
        />
        <dl className="credit-note-balance__facts">
          <div>
            <dt>{copy.creditNote.invoiceTotal}</dt>
            <dd>{euros(note.invoiceTotal)}</dd>
          </div>
          <div>
            <dt>{copy.creditNote.creditedTotal}</dt>
            <dd>{euros(note.creditedAmount)}</dd>
          </div>
          <div>
            <dt>{copy.creditNote.remainingAfterDraft}</dt>
            <dd>{euros(note.remainder)}</dd>
          </div>
          <div>
            <dt>{copy.creditNote.draftTotal}</dt>
            <dd>{euros(note.total)}</dd>
          </div>
        </dl>
      </section>
      <section className="dashboard-panel credit-note-comparator section-gap">
        <DetailSectionHeader
          description={copy.creditNote.comparisonHelp}
          icon={<CircleCheck size={22} strokeWidth={1.8} />}
          title={copy.creditNote.comparisonTitle}
        />
        <p className="notice comparison-status">{copy.document.xsdValid}</p>
        <div className="comparison-grid">
          <ComparisonTable
            title={copy.document.comparisonRecipient}
            rows={note.comparison.recipient}
          />
          <ComparisonTable
            lineLabels
            title={copy.document.comparisonLines}
            rows={note.comparison.lines}
          />
          <ComparisonTable title={copy.document.comparisonPayment} rows={note.comparison.payment} />
          <ComparisonTable
            title={copy.creditNote.sourceInvoiceComparison}
            rows={note.comparison.notes}
          />
          <ComparisonTable
            title={copy.document.comparisonTechnical}
            rows={note.comparison.technical}
          />
        </div>
        <details className="technical-details">
          <summary>
            <FileCode2 aria-hidden="true" size={18} strokeWidth={1.8} />
            {copy.document.technicalXml}
          </summary>
          <pre className="code-block">{note.xml}</pre>
        </details>
      </section>
      {note.status === "DRAFT" && canApprove ? (
        <Form className="dashboard-panel credit-note-approval section-gap" method="post">
          <input type="hidden" name="csrf" value={csrfToken} />
          <input type="hidden" name="draftVersion" value={note.draftVersion} />
          <input type="hidden" name="projectionSha256" value={note.projectionSha256} />
          <input type="hidden" name="arubaMode" value={note.arubaMode} />
          <input type="hidden" name="emailModeVersion" value={note.customerEmail.version} />
          <DetailSectionHeader
            description={copy.creditNote.approvalHelp}
            icon={<Mail size={22} strokeWidth={1.8} />}
            title={copy.creditNote.approvalTitle}
          />
          <div className="credit-note-approval__grid">
            <div>
              <h3>{copy.document.customerEmailTitle}</h3>
              <dl className="facts credit-note-email-facts">
                <div>
                  <dt>{copy.document.emailSender}</dt>
                  <dd>{note.customerEmail.sender}</dd>
                </div>
                <div>
                  <dt>{copy.document.emailRecipient}</dt>
                  <dd>{note.customerEmail.recipient ?? copy.common.unavailable}</dd>
                </div>
                <div>
                  <dt>{copy.document.emailSubject}</dt>
                  <dd>{note.customerEmail.subject}</dd>
                </div>
                <div>
                  <dt>{copy.document.emailBody}</dt>
                  <dd>{note.customerEmail.body}</dd>
                </div>
                <div>
                  <dt>{copy.document.emailAttachment}</dt>
                  <dd>{note.customerEmail.attachment}</dd>
                </div>
              </dl>
            </div>
            <fieldset className="credit-note-approval__options">
              <legend>{copy.document.customerEmailTitle}</legend>
              {note.customerEmail.mode === "DISABLED" ? (
                <>
                  <input name="emailChoice" type="hidden" value="SKIP" />
                  <p className="notice">{copy.document.emailDisabledHelp}</p>
                </>
              ) : (
                <>
                  <label className="checkbox-row">
                    <input
                      defaultChecked={
                        note.customerEmail.mode === "AUTOMATIC" &&
                        Boolean(note.customerEmail.recipient)
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
                        note.customerEmail.mode !== "AUTOMATIC" || !note.customerEmail.recipient
                      }
                      name="emailChoice"
                      type="radio"
                      value="SKIP"
                    />
                    {copy.document.emailSkip}
                  </label>
                </>
              )}
              <label className="checkbox-row credit-note-confirmation">
                <input name="confirmApproval" required type="checkbox" value="yes" />
                {copy.creditNote.confirmation}
              </label>
              {note.arubaDowngradeRequired ? (
                <label className="checkbox-row">
                  <input name="confirmArubaDowngrade" required type="checkbox" value="yes" />
                  {copy.document.confirmArubaDowngrade(note.arubaConfiguredMode)}
                </label>
              ) : null}
              <button className="button" type="submit">
                {copy.creditNote.approve}
              </button>
            </fieldset>
          </div>
        </Form>
      ) : null}
      <Link className="dashboard-row-link detail-back-link section-gap" to="/documenti">
        <ArrowLeft aria-hidden="true" size={17} strokeWidth={1.8} />
        {copy.creditNote.back}
      </Link>
    </AppShell>
  );
}
