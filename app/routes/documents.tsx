import { data, Form, Link, redirect, useActionData, useLoaderData } from "react-router";
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
  authorizeArubaApiDryRunQualification,
  confirmArubaApiBatch,
} from "../../src/db/aruba-api-outbound.server.ts";
import {
  confirmArubaDocumentOutOfScope,
  resolveArubaDocumentMatch,
} from "../../src/db/aruba-inbound.server.ts";
import { importArubaRemoteOfficialFileAsActor } from "../../src/db/aruba-official-file-import.server.ts";
import { listRemoteDocumentsPage } from "../../src/db/aruba-inventory-queries.server.ts";
import { Pager } from "../components/pager";
import { isDatabaseId } from "../../src/db/database-id.ts";
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
  const view = [
    "tutti",
    "fatture",
    "note-credito",
    "da-trasmettere",
    "da-riconciliare",
    "da-collegare",
  ].includes(requestedView)
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
  const requestedPreparation = url.searchParams.get("preparazione") ?? "";
  const focusedPreparation = isDatabaseId(requestedPreparation) ? requestedPreparation : null;
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
      view === "da-collegare"
        ? listRemoteDocumentsPage({
            attentionOnly: true,
            billingCaseId: focusedPreparation ?? undefined,
            query: filters.query || undefined,
            page,
          })
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
    focusedPreparation,
    batchCreated: url.searchParams.get("batch") === "creato",
    dryRunAuthorized: url.searchParams.get("batch") === "dry-run-autorizzato",
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
      if (form.get("intent") === "import-aruba-remote-file") {
        await importArubaRemoteOfficialFileAsActor(
          String(form.get("remoteDocumentId") ?? ""),
          form.get("fileKind"),
          Buffer.from(await file.arrayBuffer()),
          actor,
        );
        return redirect("/documenti?vista=da-collegare&file=importato");
      }
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
    if (form.get("intent") === "retry-customer-email") {
      await retryCustomerEmail(
        form.get("documentId") ?? "",
        actor,
        form.get("confirmUncertain") === "yes",
      );
      return redirect("/documenti?email=preparata");
    }
    if (form.get("intent") === "resolve-aruba-match") {
      await resolveArubaDocumentMatch(
        form.get("remoteDocumentId") ?? "",
        form.get("orderId") ?? "",
        form.get("reason"),
        actor,
      );
      return redirect("/documenti?vista=da-collegare&match=collegato");
    }
    if (form.get("intent") === "confirm-aruba-out-of-scope") {
      await confirmArubaDocumentOutOfScope(
        form.get("remoteDocumentId") ?? "",
        form.get("reason"),
        actor,
      );
      return redirect("/documenti?vista=da-collegare&match=esterno");
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
    fileImported,
    remoteDocuments,
    focusedPreparation,
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
            label: copy.documents.toReconcile,
            to: "/documenti?vista=da-riconciliare",
            value: "da-riconciliare",
          },
          {
            label: copy.documents.toLink,
            to: "/documenti?vista=da-collegare",
            value: "da-collegare",
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
      {view === "da-collegare" ? (
        <section
          className="dashboard-panel remote-documents-panel section-gap"
          aria-labelledby="remote-documents-title"
        >
          <h2 id="remote-documents-title">{copy.documents.remoteDocumentsTitle}</h2>
          <p>{copy.documents.remoteDocumentsHelp}</p>
          <Form
            aria-label={copy.documents.remoteSearchLabel}
            className="filters remote-documents-filters"
            method="get"
            role="search"
          >
            <input name="vista" type="hidden" value="da-collegare" />
            {focusedPreparation ? (
              <input name="preparazione" type="hidden" value={focusedPreparation} />
            ) : null}
            <label>
              {copy.documents.search}
              <input
                defaultValue={filters.query}
                name="q"
                placeholder={copy.documents.remoteSearchPlaceholder}
              />
            </label>
            <button className="button button--secondary" type="submit">
              {copy.documents.filter}
            </button>
            {filters.query ? (
              <Link
                to={
                  focusedPreparation
                    ? `/documenti?vista=da-collegare&preparazione=${focusedPreparation}`
                    : "/documenti?vista=da-collegare"
                }
              >
                {copy.documents.resetFilters}
              </Link>
            ) : null}
          </Form>
          <p aria-live="polite" className="filter-summary">
            <span>{copy.documents.remoteResults(remoteDocuments.total)}</span>
          </p>
          {focusedPreparation ? (
            <div className="notice remote-documents-focus" role="status">
              <span>{copy.documents.focusedPreparationHelp}</span>
              <Link to="/documenti?vista=da-collegare">{copy.documents.showAllCandidates}</Link>
            </div>
          ) : null}
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
                    <th>{copy.documents.actions}</th>
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
                      <td data-label={copy.documents.actions}>
                        {canApprove ? (
                          <div className="table-actions">
                            {!remote.has_xml ? (
                              <Form
                                className="remote-document-action"
                                method="post"
                                encType="multipart/form-data"
                              >
                                <input type="hidden" name="csrf" value={csrfToken} />
                                <input
                                  type="hidden"
                                  name="intent"
                                  value="import-aruba-remote-file"
                                />
                                <input type="hidden" name="remoteDocumentId" value={remote.id} />
                                <input type="hidden" name="fileKind" value="ARUBA_XML" />
                                <label>
                                  XML ufficiale
                                  <input
                                    accept=".xml,application/xml"
                                    name="file"
                                    required
                                    type="file"
                                  />
                                </label>
                                <button className="button button--secondary" type="submit">
                                  Importa XML
                                </button>
                              </Form>
                            ) : null}
                            {remote.has_xml &&
                            ["DELIVERED", "NOT_DELIVERED"].includes(remote.remote_status) &&
                            remote.candidates.length ? (
                              <Form className="remote-document-action" method="post">
                                <input type="hidden" name="csrf" value={csrfToken} />
                                <input type="hidden" name="intent" value="resolve-aruba-match" />
                                <input type="hidden" name="remoteDocumentId" value={remote.id} />
                                <label>
                                  {copy.documents.compatibleOrder}
                                  <select name="orderId" required>
                                    {remote.candidates.map((candidate) => (
                                      <option key={candidate.id} value={candidate.id}>
                                        {candidate.label}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                {remote.candidates.some((candidate) => candidate.guided) ? (
                                  <p className="field-help">{copy.documents.guidedCandidate}</p>
                                ) : null}
                                <label>
                                  {copy.documents.matchReason}
                                  <input minLength={10} maxLength={500} name="reason" required />
                                </label>
                                <button className="button" type="submit">
                                  {copy.documents.confirmMatch}
                                </button>
                              </Form>
                            ) : null}
                            {remote.has_xml &&
                            ["PROFILE_CONFLICT", "UNMATCHED", "AMBIGUOUS"].includes(
                              remote.match_status,
                            ) &&
                            !remote.candidates.length &&
                            ["DELIVERED", "NOT_DELIVERED"].includes(remote.remote_status) ? (
                              <Form className="remote-document-action" method="post">
                                <input type="hidden" name="csrf" value={csrfToken} />
                                <input
                                  type="hidden"
                                  name="intent"
                                  value="confirm-aruba-out-of-scope"
                                />
                                <input type="hidden" name="remoteDocumentId" value={remote.id} />
                                <label>
                                  Motivazione della verifica
                                  <input minLength={20} maxLength={500} name="reason" required />
                                </label>
                                <button className="button button--secondary" type="submit">
                                  Conferma fuori perimetro
                                </button>
                              </Form>
                            ) : null}
                          </div>
                        ) : (
                          <span>{copy.common.unavailable}</span>
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
