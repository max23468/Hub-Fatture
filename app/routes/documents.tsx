import { data, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/documents";

import { AppShell } from "../components/app-shell";
import { DocumentsView } from "../components/documents-view";
import { ViewNavigation } from "../components/view-navigation";
import { copy } from "../copy.it";
import { date, dateTime, euros } from "../format";
import { privateRouteMeta } from "../metadata";
import { ARUBA_IMPORT_MAX_BYTES } from "../../src/aruba.ts";
import { assertCsrf, requestId, requireSessionUser } from "../../src/db/auth.server.ts";
import {
  createBatchForDocuments,
  importOfficialArubaFile,
  listArubaBatches,
  listOfficialArubaFiles,
  listUnbatchedApprovedDocuments,
  getArubaSettings,
} from "../../src/db/aruba.server.ts";
import {
  documentArchiveSummary,
  listDocuments,
  type DocumentListSortKey,
} from "../../src/db/document-archive.server.ts";
import {
  getCustomerEmailSettings,
  listEmailDeliveries,
  retryCustomerEmail,
} from "../../src/db/email.server.ts";
import { publicError } from "../../src/errors.ts";
import {
  authorizeArubaApiCanary,
  authorizeArubaApiDryRunQualification,
  confirmArubaApiBatch,
} from "../../src/db/aruba-api-outbound.server.ts";
import { listRemoteDocumentsPage } from "../../src/db/aruba-inventory-queries.server.ts";
import { readForm, readMultipartForm } from "../../src/http.server.ts";
import { pageNumber, postgresDateSchema } from "../../src/orders.ts";
import { Pager } from "../components/pager";
import { parseSort } from "../table-sort";

const documentSortKeys = ["documento", "cliente", "data", "totale", "stato", "email"] as const;

export function meta({ error }: Route.MetaArgs) {
  return privateRouteMeta("documents", { error });
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const url = new URL(request.url);
  const requestedView = url.searchParams.get("vista") ?? "tutti";
  const view = ["tutti", "fatture", "note-credito", "da-trasmettere", "inventario-aruba"].includes(
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
  const transmissionByView: Record<string, "TO_SEND" | undefined> = {
    "da-trasmettere": "TO_SEND",
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
  const [documents, summary, batches, unbatched, remoteDocuments, arubaSettings] =
    await Promise.all([
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
      view === "inventario-aruba"
        ? listRemoteDocumentsPage({ query: filters.query || undefined, page })
        : Promise.resolve({ rows: [], hasNext: false, total: 0 }),
      getArubaSettings(),
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
    arubaDowngradeRequired: arubaSettings.mode.value !== arubaSettings.effectiveMode,
    arubaConfiguredMode: arubaSettings.mode.value,
    officialFiles,
    emailDeliveries,
    emailEnabled: customerEmail.mode !== "DISABLED",
    filters,
    page,
    summary,
    sort,
    view,
    remoteDocuments,
    batchCreated: url.searchParams.get("batch") === "creato",
    dryRunAuthorized: url.searchParams.get("batch") === "dry-run-autorizzato",
    canaryAuthorized: url.searchParams.get("batch") === "invio-pilota-autorizzato",
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
      await createBatchForDocuments(
        form.getAll("documentId"),
        actor,
        form.get("confirmArubaDowngrade") === "yes",
      );
      return redirect("/documenti?batch=creato");
    }
    if (form.get("intent") === "confirm-aruba-api-batch") {
      await confirmArubaApiBatch(form.get("batchId") ?? "", actor);
      return redirect("/documenti?batch=confermato");
    }
    if (form.get("intent") === "authorize-aruba-dry-run") {
      await authorizeArubaApiDryRunQualification(
        form.get("batchId") ?? "",
        actor,
        form.get("confirmDryRunQualification") === "yes",
      );
      return redirect("/documenti?batch=dry-run-autorizzato");
    }
    if (form.get("intent") === "authorize-aruba-canary") {
      await authorizeArubaApiCanary(
        form.get("batchId") ?? "",
        actor,
        form.get("confirmCanary") === "yes",
      );
      return redirect("/documenti?batch=invio-pilota-autorizzato");
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
    arubaConfiguredMode,
    arubaDowngradeRequired,
    officialFiles,
    emailDeliveries,
    emailEnabled,
    filters,
    page,
    summary,
    sort,
    view,
    batchCreated,
    dryRunAuthorized,
    canaryAuthorized,
    fileImported,
    remoteDocuments,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
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
            label: copy.documents.arubaInventory,
            to: "/documenti?vista=inventario-aruba",
            value: "inventario-aruba",
          },
        ]}
        label={copy.documents.viewsLabel}
        mobileLayout="grid"
      />
      {batchCreated ? (
        <p className="notice" role="status">
          {copy.documents.batchCreated}
        </p>
      ) : null}
      {dryRunAuthorized ? (
        <p className="notice notice--success" role="status">
          {copy.documents.dryRunQualificationAuthorized}
        </p>
      ) : null}
      {canaryAuthorized ? (
        <p className="notice notice--success" role="status">
          {copy.documents.canaryAuthorized}
        </p>
      ) : null}
      {fileImported ? (
        <p className="notice" role="status">
          {copy.documents.fileImported}
        </p>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {view === "inventario-aruba" ? (
        <section
          className="dashboard-panel remote-documents-panel section-gap"
          aria-labelledby="remote-documents-title"
        >
          <h2 id="remote-documents-title">{copy.documents.remoteDocumentsTitle}</h2>
          <p>{copy.documents.remoteDocumentsHelp}</p>
          <p aria-live="polite" className="filter-summary">
            <span>{copy.documents.remoteResults(remoteDocuments.total)}</span>
          </p>
          {remoteDocuments.rows.length ? (
            <div className="table-wrap remote-documents-table-wrap">
              <table className="data-table remote-documents-table">
                <thead>
                  <tr>
                    <th>{copy.documents.document}</th>
                    <th>{copy.documents.date}</th>
                    <th>{copy.documents.total}</th>
                    <th>{copy.documents.arubaStatus}</th>
                    <th>{copy.documents.matchStatus}</th>
                    <th>{copy.documents.remoteLastReadback}</th>
                    <th>{copy.documents.control}</th>
                  </tr>
                </thead>
                <tbody>
                  {remoteDocuments.rows.map((remote) => (
                    <tr id={`documento-aruba-${remote.id}`} key={remote.id}>
                      <td data-label={copy.documents.document}>
                        {remote.document_type} {remote.series ?? ""}{" "}
                        {remote.fiscal_number ?? remote.remote_id}
                      </td>
                      <td data-label={copy.documents.date}>{date(remote.document_date)}</td>
                      <td data-label={copy.documents.total}>{euros(remote.total_amount)}</td>
                      <td data-label={copy.documents.arubaStatus}>
                        {copy.documents.remoteStatusLabels[remote.remote_status] ??
                          remote.remote_status}
                      </td>
                      <td data-label={copy.documents.matchStatus}>
                        {copy.documents.matchStatusLabels[remote.match_status] ??
                          remote.match_status}
                      </td>
                      <td data-label={copy.documents.remoteLastReadback}>
                        {dateTime(remote.last_observed_at)}
                      </td>
                      <td data-label={copy.documents.control}>
                        {remote.requires_control ? (
                          <Link
                            className="dashboard-row-link"
                            to={`/controlli?id=${encodeURIComponent(`ARUBA_REMOTE:${remote.id}`)}`}
                          >
                            {copy.documents.openControl}
                          </Link>
                        ) : (
                          <span>{copy.documents.inventoryOnly}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>
              {filters.query
                ? copy.documents.noRemoteSearchResults(filters.query)
                : copy.documents.noRemoteDocuments}
            </p>
          )}
          <Pager basePath="/documenti" hasNext={remoteDocuments.hasNext} page={page} />
        </section>
      ) : (
        <DocumentsView
          arubaConfiguredMode={arubaConfiguredMode}
          arubaDowngradeRequired={arubaDowngradeRequired}
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
      )}
    </AppShell>
  );
}
