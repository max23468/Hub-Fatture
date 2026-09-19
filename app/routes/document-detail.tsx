import { ArrowLeft } from "lucide-react";
import { data, Link, redirect, useActionData, useLoaderData, useLocation } from "react-router";
import type { Route } from "./+types/document-detail";

import { AppShell } from "../components/app-shell";
import { DocumentDetailView } from "../components/document-detail-view";
import { stateTone, transmissionLabel } from "../components/documents-view";
import { copy } from "../copy.it";
import { date, euros } from "../format";
import { privateRouteMeta } from "../metadata";
import { ARUBA_IMPORT_MAX_BYTES } from "../../src/aruba.ts";
import { requestArubaSubmissionReadback } from "../../src/db/aruba-api-readback.server.ts";
import { importOfficialArubaFile } from "../../src/db/aruba.server.ts";
import { assertCsrf, requestId, requireSessionUser } from "../../src/db/auth.server.ts";
import { getDocumentDetail } from "../../src/db/document-detail.server.ts";
import { getCustomerEmailSettings, retryCustomerEmail } from "../../src/db/email.server.ts";
import { publicError } from "../../src/errors.ts";
import { readForm, readMultipartForm } from "../../src/http.server.ts";

export function meta({ error, loaderData }: Route.MetaArgs) {
  return privateRouteMeta("document", {
    error,
    title: loaderData ? documentTitle(loaderData.document) : undefined,
  });
}

function documentTitle(document: { fiscal_label: string | null; public_number: string }) {
  return document.fiscal_label ?? copy.documents.draftLabel(document.public_number);
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const [document, customerEmail] = await Promise.all([
    getDocumentDetail(params.documentId),
    getCustomerEmailSettings(),
  ]);
  if (!document) throw new Response("Documento non trovato", { status: 404 });
  const url = new URL(request.url);
  return {
    username: user.username,
    canApprove: user.canApprove,
    csrfToken: user.csrfToken,
    document,
    emailEnabled: customerEmail.mode !== "DISABLED",
    fileImported: url.searchParams.get("file") === "importato",
    arubaRefreshRequested: url.searchParams.get("aruba") === "aggiornamento-richiesto",
    emailPrepared: url.searchParams.get("email") === "preparata",
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const documentPath = `/documenti/${params.documentId}`;
  try {
    const user = await requireSessionUser(request);
    const actor = { id: user.id, canApprove: user.canApprove, requestId: requestId(request) };
    if (request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) {
      const form = await readMultipartForm(request, {
        maxBytes: ARUBA_IMPORT_MAX_BYTES + 64 * 1024,
      });
      assertCsrf(user, String(form.get("csrf") ?? ""));
      const file = form.get("file");
      if (!(file instanceof File)) throw new Response("File mancante", { status: 422 });
      await importOfficialArubaFile(
        params.documentId,
        form.get("fileKind"),
        Buffer.from(await file.arrayBuffer()),
        actor,
      );
      return redirect(`${documentPath}?file=importato`);
    }
    const form = await readForm(request);
    assertCsrf(user, form.get("csrf") ?? "");
    if (form.get("intent") === "retry-customer-email") {
      await retryCustomerEmail(
        params.documentId,
        actor,
        form.get("confirmUncertain") === "yes",
        form.get("newRecipient") ?? undefined,
      );
      return redirect(`${documentPath}?email=preparata`);
    }
    if (form.get("intent") === "refresh-aruba-status") {
      await requestArubaSubmissionReadback(params.documentId, actor);
      return redirect(`${documentPath}?aruba=aggiornamento-richiesto`);
    }
    throw new Response("Azione non riconosciuta", { status: 400 });
  } catch (error) {
    if (error instanceof Response) throw error;
    const result = publicError(error);
    return data(result, { status: result.status });
  }
}

export default function DocumentDetailPage() {
  const {
    username,
    canApprove,
    csrfToken,
    document,
    emailEnabled,
    fileImported,
    arubaRefreshRequested,
    emailPrepared,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const location = useLocation();
  const from = (location.state as { from?: unknown } | null)?.from;
  const backTo = `/documenti${typeof from === "string" ? from : ""}`;
  const notice = fileImported
    ? copy.documents.fileImported
    : arubaRefreshRequested
      ? copy.documents.arubaRefreshRequested
      : emailPrepared
        ? copy.documentDetail.emailPrepared
        : null;
  return (
    <AppShell canApprove={canApprove} csrfToken={csrfToken} username={username}>
      <Link className="dashboard-row-link detail-back-link" to={backTo}>
        <ArrowLeft aria-hidden="true" size={17} strokeWidth={1.8} />
        {copy.documentDetail.back}
      </Link>
      <div className="title-block dashboard-title detail-page-title">
        <p className="eyebrow">
          {document.kind === "CREDIT_NOTE" ? copy.documents.creditNote : copy.documents.invoice}
        </p>
        <h1>{documentTitle(document)}</h1>
        <p>
          {document.customer_name} · {date(document.document_date)} · {euros(document.total_amount)}
        </p>
      </div>
      <section aria-label={copy.documentDetail.summaryLabel} className="dashboard-panel">
        <dl className="facts document-detail-facts">
          <div>
            <dt>{copy.documents.status}</dt>
            <dd>
              <span className={`document-state document-state--${stateTone(document)}`}>
                {document.status === "APPROVED" ? copy.documents.approved : copy.documents.draft}
              </span>{" "}
              {transmissionLabel(document)}
            </dd>
          </div>
          <div>
            <dt>{copy.documents.origin}</dt>
            <dd>
              {document.origin === "ARUBA_HISTORY"
                ? copy.documents.originAruba
                : copy.documents.originLocal}
            </dd>
          </div>
        </dl>
      </section>
      {notice ? (
        <p className="notice notice--success section-gap" role="status">
          {notice}
        </p>
      ) : null}
      {actionData && "message" in actionData ? (
        <p className="error section-gap" role="alert">
          {actionData.message}
        </p>
      ) : null}
      <DocumentDetailView
        canApprove={canApprove}
        csrfToken={csrfToken}
        document={document}
        emailEnabled={emailEnabled}
      />
    </AppShell>
  );
}
