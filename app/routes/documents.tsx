import { data, Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/documents";

import { AppShell } from "../components/app-shell";
import { copy } from "../copy.it";
import { date, dateTime, euros } from "../format";
import { ARUBA_IMPORT_MAX_BYTES } from "../../src/aruba.ts";
import { assertCsrf, requestId, requireSessionUser } from "../../src/db/auth.server.ts";
import {
  authorizeArubaPermit,
  createBatchForDocuments,
  importOfficialArubaFile,
  issueHelperToken,
  listArubaBatches,
  listUnbatchedApprovedDocuments,
  retryArubaBatch,
} from "../../src/db/aruba.server.ts";
import { listDocuments } from "../../src/db/documents.server.ts";
import { publicError } from "../../src/errors.ts";
import { readForm, readMultipartForm } from "../../src/http.server.ts";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const url = new URL(request.url);
  const [documents, batches, unbatched] = await Promise.all([
    listDocuments(),
    listArubaBatches(),
    listUnbatchedApprovedDocuments(),
  ]);
  return {
    username: user.username,
    canApprove: user.canApprove,
    csrfToken: user.csrfToken,
    documents,
    batches,
    unbatched,
    batchCreated: url.searchParams.get("batch") === "creato",
    fileImported: url.searchParams.get("file") === "importato",
  };
}

export async function action({ request }: Route.ActionArgs) {
  try {
    const user = await requireSessionUser(request);
    const actor = {
      id: user.id,
      canApprove: user.canApprove,
      requestId: requestId(request),
    };
    if (request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) {
      const form = await readMultipartForm(request, {
        maxBytes: ARUBA_IMPORT_MAX_BYTES + 64 * 1024,
      });
      assertCsrf(user, String(form.get("csrf") ?? ""));
      const file = form.get("file");
      if (!(file instanceof File)) throw new Response("File mancante", { status: 422 });
      await importOfficialArubaFile(
        String(form.get("documentId") ?? ""),
        form.get("fileKind"),
        Buffer.from(await file.arrayBuffer()),
        actor,
      );
      return redirect("/documenti?file=importato");
    }
    const form = await readForm(request);
    assertCsrf(user, form.get("csrf") ?? "");
    if (form.get("intent") === "create-aruba-batch") {
      await createBatchForDocuments(form.getAll("documentId"), actor);
      return redirect("/documenti?batch=creato");
    }
    if (form.get("intent") === "issue-helper-token") {
      return data({ helper: await issueHelperToken(form.get("batchId") ?? "", actor) });
    }
    if (form.get("intent") === "authorize-aruba-permit") {
      await authorizeArubaPermit(form.get("batchId") ?? "", actor);
      return redirect("/documenti?permesso=creato");
    }
    if (form.get("intent") === "retry-aruba-batch") {
      await retryArubaBatch(form.get("batchId") ?? "", actor);
      return redirect("/documenti?batch=creato");
    }
    throw new Response("Azione non riconosciuta", { status: 400 });
  } catch (error) {
    if (error instanceof Response) throw error;
    const result = publicError(error);
    return data(result, { status: result.status });
  }
}

function ImportForm({ csrfToken, documentId }: { csrfToken: string; documentId: string }) {
  return (
    <details>
      <summary>{copy.documents.importOfficial}</summary>
      <Form className="section-gap" encType="multipart/form-data" method="post">
        <input type="hidden" name="csrf" value={csrfToken} />
        <input type="hidden" name="documentId" value={documentId} />
        <label>
          {copy.documents.fileType}
          <select name="fileKind">
            <option value="ARUBA_XML">XML Aruba</option>
            <option value="ARUBA_P7M">P7M</option>
            <option value="ARUBA_PDF">PDF</option>
            <option value="SDI_NOTIFICATION">Notifica SdI</option>
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

export default function Documents() {
  const {
    username,
    canApprove,
    csrfToken,
    documents,
    batches,
    unbatched,
    batchCreated,
    fileImported,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const helper = actionData && "helper" in actionData ? actionData.helper : null;
  const error = actionData && "message" in actionData ? actionData.message : null;
  return (
    <AppShell username={username} csrfToken={csrfToken}>
      <div className="title-block">
        <p className="eyebrow">{copy.documents.eyebrow}</p>
        <h1>{copy.documents.title}</h1>
        <p>{copy.documents.intro}</p>
      </div>
      {batchCreated ? (
        <p className="notice" role="status">
          {copy.documents.batchCreated}
        </p>
      ) : null}
      {fileImported ? (
        <p className="notice" role="status">
          {copy.documents.fileImported}
        </p>
      ) : null}
      {helper ? (
        <section className="notice" aria-labelledby="helper-code" role="status">
          <h2 id="helper-code">{copy.documents.helperCodeTitle}</h2>
          <p>{copy.documents.helperCodeHelp(dateTime(helper.expiresAt))}</p>
          <code className="code-block">{helper.token}</code>
        </section>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {canApprove && unbatched.length ? (
        <section className="card section-gap">
          <h2>{copy.documents.manualBatchTitle}</h2>
          <p>{copy.documents.manualBatchHelp}</p>
          <Form method="post">
            <input type="hidden" name="csrf" value={csrfToken} />
            <input type="hidden" name="intent" value="create-aruba-batch" />
            {unbatched.map((document) => (
              <label className="checkbox-row" key={document.id}>
                <input name="documentId" type="checkbox" value={document.id} />
                {document.fiscal_label} · {document.customer_name} · {euros(document.total_amount)}
              </label>
            ))}
            <button className="button section-gap" type="submit">
              {copy.documents.createBatch}
            </button>
          </Form>
        </section>
      ) : null}
      {documents.length ? (
        <div className="table-wrap section-gap">
          <table>
            <thead>
              <tr>
                <th>{copy.documents.number}</th>
                <th>{copy.documents.customer}</th>
                <th>{copy.documents.date}</th>
                <th>{copy.documents.total}</th>
                <th>{copy.documents.status}</th>
                <th>{copy.documents.arubaStatus}</th>
                <th>{copy.documents.file}</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((document) => (
                <tr key={document.id}>
                  <td data-label={copy.documents.number}>
                    <Link to={`/ordini/preparazione/${document.billing_case_id}`}>
                      {document.fiscal_label ?? copy.documents.draft}
                    </Link>
                  </td>
                  <td data-label={copy.documents.customer}>{document.customer_name}</td>
                  <td data-label={copy.documents.date}>{date(document.document_date)}</td>
                  <td data-label={copy.documents.total}>{euros(document.total_amount)}</td>
                  <td data-label={copy.documents.status}>
                    {document.status === "APPROVED"
                      ? copy.documents.approved
                      : copy.documents.draft}
                  </td>
                  <td data-label={copy.documents.arubaStatus}>
                    {document.aruba_status
                      ? (copy.documents.arubaBatchStatus[document.aruba_status] ??
                        copy.common.unavailable)
                      : copy.documents.notPrepared}
                  </td>
                  <td data-label={copy.documents.file}>
                    {document.xml_sha256 ? (
                      <>
                        <a href={`/documenti/${document.id}/xml`}>{copy.documents.downloadXml}</a>
                        {canApprove && document.aruba_batch_id ? (
                          <ImportForm csrfToken={csrfToken} documentId={document.id} />
                        ) : null}
                      </>
                    ) : (
                      copy.common.unavailable
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <section className="empty-state">
          <h2>{copy.documents.empty}</h2>
          <p>{copy.documents.emptyHelp}</p>
        </section>
      )}
      {batches.length ? (
        <section className="card section-gap">
          <h2>{copy.documents.batchesTitle}</h2>
          <p>{copy.documents.batchesHelp}</p>
          <ul className="plain-list">
            {batches.map((batch) => (
              <li key={batch.id}>
                <strong>{copy.documents.batchSummary(batch.document_count, batch.mode)}</strong>
                <span>
                  {copy.documents.arubaBatchStatus[batch.status] ?? copy.common.unavailable} ·{" "}
                  {dateTime(batch.created_at)}
                  {batch.last_readback_at
                    ? ` · ${copy.documents.lastReadback(dateTime(batch.last_readback_at))}`
                    : ""}
                </span>
                {canApprove && batch.status !== "CANCELLED" && !batch.can_retry ? (
                  <Form method="post">
                    <input type="hidden" name="csrf" value={csrfToken} />
                    <input type="hidden" name="intent" value="issue-helper-token" />
                    <input type="hidden" name="batchId" value={batch.id} />
                    <button className="button button--secondary" type="submit">
                      {copy.documents.issueHelperCode}
                    </button>
                  </Form>
                ) : null}
                {canApprove &&
                batch.mode === "AUTOMATIC" &&
                !batch.permit_consumed_at &&
                ["PREPARED", "HELPER_ACTIVE", "VALIDATION_FAILED"].includes(batch.status) ? (
                  <Form method="post">
                    <input type="hidden" name="csrf" value={csrfToken} />
                    <input type="hidden" name="intent" value="authorize-aruba-permit" />
                    <input type="hidden" name="batchId" value={batch.id} />
                    <button className="button button--secondary" type="submit">
                      {copy.documents.authorizePermit}
                    </button>
                  </Form>
                ) : null}
                {canApprove && batch.can_retry ? (
                  <Form method="post">
                    <input type="hidden" name="csrf" value={csrfToken} />
                    <input type="hidden" name="intent" value="retry-aruba-batch" />
                    <input type="hidden" name="batchId" value={batch.id} />
                    <button className="button button--secondary" type="submit">
                      {copy.documents.retryBatch}
                    </button>
                  </Form>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </AppShell>
  );
}
