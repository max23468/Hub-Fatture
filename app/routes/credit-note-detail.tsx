import { data, Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/credit-note-detail";

import { AppShell } from "../components/app-shell";
import { copy } from "../copy.it";
import { date, euros } from "../format";
import { assertCsrf, requestId, requireSessionUser } from "../../src/db/auth.server.ts";
import { approveCreditNote, getCreditNoteProjection } from "../../src/db/refunds.server.ts";
import { publicError } from "../../src/errors.ts";
import { readForm } from "../../src/http.server.ts";

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
    <AppShell username={username} csrfToken={csrfToken}>
      <div className="title-block">
        <p className="eyebrow">Nota di credito</p>
        <h1>Bozza TD04</h1>
        <p>
          Fattura originaria {note.invoiceNumber} del {date(note.invoiceDate)}
        </p>
      </div>
      {error ? (
        <p className="error" role="alert">
          {error.message}
        </p>
      ) : null}
      <section className="card">
        <h2>Residuo accreditabile</h2>
        <dl className="facts facts--columns">
          <div>
            <dt>Totale fattura</dt>
            <dd>{euros(note.invoiceTotal)}</dd>
          </div>
          <div>
            <dt>Totale note</dt>
            <dd>{euros(note.creditedAmount)}</dd>
          </div>
          <div>
            <dt>Residuo dopo questa bozza</dt>
            <dd>{euros(note.remainder)}</dd>
          </div>
          <div>
            <dt>Totale bozza</dt>
            <dd>{euros(note.total)}</dd>
          </div>
        </dl>
      </section>
      <section className="card section-gap">
        <h2>Comparatore fiscale</h2>
        <p>{copy.document.xsdValid}</p>
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
        <ComparisonTable title="Fattura originaria" rows={note.comparison.notes} />
        <ComparisonTable
          title={copy.document.comparisonTechnical}
          rows={note.comparison.technical}
        />
        <details className="section-gap">
          <summary>Mostra XML tecnico</summary>
          <pre className="code-block">{note.xml}</pre>
        </details>
      </section>
      {note.status === "DRAFT" && canApprove ? (
        <Form className="card section-gap" method="post">
          <input type="hidden" name="csrf" value={csrfToken} />
          <input type="hidden" name="draftVersion" value={note.draftVersion} />
          <input type="hidden" name="projectionSha256" value={note.projectionSha256} />
          <input type="hidden" name="arubaMode" value={note.arubaMode} />
          <input type="hidden" name="emailModeVersion" value={note.customerEmail.version} />
          <h2>{copy.document.customerEmailTitle}</h2>
          <dl className="facts facts--columns">
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
          <label className="checkbox-row section-gap">
            <input name="confirmApproval" required type="checkbox" value="yes" />
            Confermo rimborsi, riferimenti alla fattura, totale e numerazione irreversibile.
          </label>
          <button className="button" type="submit">
            Approva, numera e prepara per Aruba
          </button>
        </Form>
      ) : null}
      <p className="section-gap">
        <Link to="/documenti">Torna ai documenti</Link>
      </p>
    </AppShell>
  );
}
