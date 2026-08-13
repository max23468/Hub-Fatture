import { data, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/documents";

import { AppShell } from "../components/app-shell";
import { DocumentsView } from "../components/documents-view";
import { ViewNavigation } from "../components/view-navigation";
import { copy } from "../copy.it";
import { dateTime } from "../format";
import { privateRouteMeta } from "../metadata";
import { ARUBA_IMPORT_MAX_BYTES } from "../../src/aruba.ts";
import { assertCsrf, requestId, requireSessionUser } from "../../src/db/auth.server.ts";
import {
  authorizeArubaPermit,
  createBatchForDocuments,
  importOfficialArubaFile,
  issueHelperToken,
  listArubaBatches,
  listOfficialArubaFiles,
  listUnbatchedApprovedDocuments,
  prepareCanaryArubaBatch,
  retryArubaBatch,
} from "../../src/db/aruba.server.ts";
import {
  documentArchiveSummary,
  listDocuments,
  type DocumentListSortKey,
} from "../../src/db/documents.server.ts";
import {
  getCustomerEmailSettings,
  listEmailDeliveries,
  retryCustomerEmail,
} from "../../src/db/email.server.ts";
import { AppError, publicError } from "../../src/errors.ts";
import { readForm, readMultipartForm } from "../../src/http.server.ts";
import { pageNumber, postgresDateSchema } from "../../src/orders.ts";
import { parseSort } from "../table-sort";

const documentSortKeys = ["documento", "cliente", "data", "totale", "stato", "email"] as const;

export function meta({ error }: Route.MetaArgs) {
  return privateRouteMeta("documents", { error });
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const url = new URL(request.url);
  const requestedView = url.searchParams.get("vista") ?? "tutti";
  const view = ["tutti", "fatture", "note-credito", "da-trasmettere", "da-riconciliare"].includes(
    requestedView,
  )
    ? requestedView
    : "tutti";
  const requestedKind = url.searchParams.get("tipo") ?? "";
  const requestedStatus = url.searchParams.get("stato") ?? "";
  const requestedArubaStatus = url.searchParams.get("trasmissione") ?? "";
  const requestedDateFrom = url.searchParams.get("dal") ?? "";
  const requestedDateTo = url.searchParams.get("al") ?? "";
  const parsedDateFrom = postgresDateSchema.safeParse(requestedDateFrom);
  const parsedDateTo = postgresDateSchema.safeParse(requestedDateTo);
  const allowedArubaStatuses = ["NOT_PREPARED", ...Object.keys(copy.documents.arubaBatchStatus)];
  const kindByView: Record<string, "INVOICE" | "CREDIT_NOTE" | undefined> = {
    fatture: "INVOICE",
    "note-credito": "CREDIT_NOTE",
  };
  const transmissionByView: Record<string, "TO_SEND" | "RECONCILIATION_REQUIRED" | undefined> = {
    "da-trasmettere": "TO_SEND",
    "da-riconciliare": "RECONCILIATION_REQUIRED",
  };
  const transmission = transmissionByView[view];
  const filters = {
    query: url.searchParams.get("q")?.trim() ?? "",
    kind:
      kindByView[view] ??
      (view === "tutti" && ["INVOICE", "CREDIT_NOTE"].includes(requestedKind) ? requestedKind : ""),
    status: ["DRAFT", "APPROVED"].includes(requestedStatus) ? requestedStatus : "",
    arubaStatus:
      !transmission && allowedArubaStatuses.includes(requestedArubaStatus)
        ? requestedArubaStatus
        : "",
    dateFrom: parsedDateFrom.success ? parsedDateFrom.data : "",
    dateTo: parsedDateTo.success ? parsedDateTo.data : "",
  };
  const page = pageNumber(url.searchParams.get("pagina") ?? 1);
  const sort = parseSort(
    url.searchParams.get("ordina"),
    url.searchParams.get("direzione"),
    documentSortKeys,
    { key: "data" as DocumentListSortKey, direction: "desc" },
  );
  const [documents, summary, batches, unbatched] = await Promise.all([
    listDocuments({
      query: filters.query || undefined,
      kind: filters.kind ? (filters.kind as "INVOICE" | "CREDIT_NOTE") : undefined,
      status: filters.status ? (filters.status as "DRAFT" | "APPROVED") : undefined,
      arubaStatus: filters.arubaStatus || undefined,
      transmission,
      dateFrom: filters.dateFrom || undefined,
      dateTo: filters.dateTo || undefined,
      page,
      sort,
    }),
    documentArchiveSummary(),
    listArubaBatches(),
    listUnbatchedApprovedDocuments(),
  ]);
  const documentIds = documents.rows.map((document) => document.id);
  const [officialFiles, emailDeliveries, customerEmail] = await Promise.all([
    listOfficialArubaFiles(documentIds),
    listEmailDeliveries(documentIds),
    getCustomerEmailSettings(),
  ]);
  return {
    username: user.username,
    canApprove: user.canApprove,
    csrfToken: user.csrfToken,
    documents,
    batches,
    unbatched,
    officialFiles,
    emailDeliveries,
    emailEnabled: customerEmail.mode !== "DISABLED",
    filters,
    page,
    summary,
    sort,
    view,
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
      await authorizeArubaPermit(
        form.get("batchId") ?? "",
        actor,
        form.get("confirmCanary") === "yes",
      );
      return redirect("/documenti?permesso=creato");
    }
    if (form.get("intent") === "prepare-canary-aruba-batch") {
      if (form.get("confirmCanary") !== "yes") {
        throw new AppError("ARUBA_PERMIT_INVALID", 422);
      }
      await prepareCanaryArubaBatch(form.get("batchId") ?? "", actor);
      return redirect("/documenti?batch=creato");
    }
    if (form.get("intent") === "retry-aruba-batch") {
      await retryArubaBatch(form.get("batchId") ?? "", actor, form.get("confirmCanary") === "yes");
      return redirect("/documenti?batch=creato");
    }
    if (form.get("intent") === "retry-customer-email") {
      await retryCustomerEmail(
        form.get("documentId") ?? "",
        actor,
        form.get("confirmUncertain") === "yes",
      );
      return redirect("/documenti?email=preparata");
    }
    throw new Response("Azione non riconosciuta", { status: 400 });
  } catch (error) {
    if (error instanceof Response) throw error;
    const result = publicError(error);
    return data(result, { status: result.status });
  }
}

export default function Documents() {
  const {
    username,
    canApprove,
    csrfToken,
    documents,
    batches,
    unbatched,
    officialFiles,
    emailDeliveries,
    emailEnabled,
    filters,
    page,
    summary,
    sort,
    view,
    batchCreated,
    fileImported,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const helper = actionData && "helper" in actionData ? actionData.helper : null;
  const error = actionData && "message" in actionData ? actionData.message : null;

  return (
    <AppShell canApprove={canApprove} csrfToken={csrfToken} username={username}>
      <div className="title-block">
        <p className="eyebrow">{copy.documents.eyebrow}</p>
        <h1>{copy.documents.title}</h1>
        <p>{copy.documents.intro}</p>
      </div>
      <ViewNavigation
        active={view}
        items={[
          { label: copy.documents.all, to: "/documenti", value: "tutti" },
          {
            label: copy.documents.invoices,
            to: "/documenti?vista=fatture",
            value: "fatture",
          },
          {
            label: copy.documents.creditNotes,
            to: "/documenti?vista=note-credito",
            value: "note-credito",
          },
          {
            label: copy.documents.toSend,
            to: "/documenti?vista=da-trasmettere",
            value: "da-trasmettere",
          },
          {
            label: copy.documents.toReconcile,
            to: "/documenti?vista=da-riconciliare",
            value: "da-riconciliare",
          },
        ]}
        label={copy.documents.viewsLabel}
      />
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
        <section aria-labelledby="helper-code" className="notice" role="status">
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
      <DocumentsView
        batches={batches}
        canApprove={canApprove}
        csrfToken={csrfToken}
        documents={documents}
        emailDeliveries={emailDeliveries}
        emailEnabled={emailEnabled}
        filters={filters}
        officialFiles={officialFiles}
        page={page}
        summary={summary}
        sort={sort}
        unbatched={unbatched}
        view={view}
      />
    </AppShell>
  );
}
