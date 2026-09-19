import { BadgeEuro, CircleCheck, FileCode2, Mail } from "lucide-react";
import { Form } from "react-router";

import type { listBillingCaseCreditNoteDrafts } from "../../src/db/refunds.server.ts";
import { ComparisonTable } from "./comparison-table";
import { DetailSectionHeader } from "./detail-section-header";
import { copy } from "../copy.it";
import { date, euros } from "../format";

type CreditNoteDraft = Awaited<ReturnType<typeof listBillingCaseCreditNoteDrafts>>[number];

function CreditNoteApproval({ csrfToken, note }: { csrfToken: string; note: CreditNoteDraft }) {
  return (
    <Form className="credit-note-approval section-gap" method="post">
      <input type="hidden" name="csrf" value={csrfToken} />
      <input type="hidden" name="intent" value="approve-credit-note" />
      <input type="hidden" name="documentId" value={note.id} />
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
                    note.customerEmail.mode === "AUTOMATIC" && Boolean(note.customerEmail.recipient)
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
          <p className="field-help">
            <strong>{`${copy.document.arubaPath}:`}</strong>{" "}
            {copy.document.arubaModeSummary(note.arubaMode)}
          </p>
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
  );
}

/** Una nota di credito in bozza si rivede e si approva nella preparazione della fattura. */
export function CreditNoteDraftPanel({
  canApprove,
  csrfToken,
  note,
}: {
  canApprove: boolean;
  csrfToken: string;
  note: CreditNoteDraft;
}) {
  return (
    <section
      aria-labelledby={`nota-credito-${note.id}`}
      className="dashboard-panel credit-note-draft section-gap"
    >
      <div className="title-block">
        <p className="eyebrow">{copy.creditNote.eyebrow}</p>
        <h2 id={`nota-credito-${note.id}`}>{copy.creditNote.title}</h2>
        <p>{copy.creditNote.sourceInvoice(note.invoiceNumber, date(note.invoiceDate))}</p>
      </div>
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
      <div className="credit-note-comparator section-gap">
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
      </div>
      {canApprove ? <CreditNoteApproval csrfToken={csrfToken} note={note} /> : null}
    </section>
  );
}
