import { data, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/documents";

import { AppShell } from "../components/app-shell";
import { ArubaInventoryPanel } from "../components/aruba-inventory-panel";
import { DocumentsView } from "../components/documents-view";
import { ViewNavigation } from "../components/view-navigation";
import { copy } from "../copy.it";
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
import { documentArchiveSummary, listDocuments } from "../../src/db/document-archive.server.ts";
import type { DocumentListSortKey } from "../../src/db/document-archive-types.server.ts";
import {
  getCustomerEmailSettings,
  listEmailDeliveries,
  retryCustomerEmail,
} from "../../src/db/email.server.ts";
import { publicError } from "../../src/errors.ts";
import { confirmArubaApiBatch } from "../../src/db/aruba-api-outbound.server.ts";
import {
  requestArubaSubmissionReadback,
  requestArubaTargetedLookup,
  requestArubaAdvancedSearch,
} from "../../src/db/aruba-api-readback.server.ts";
import { listRemoteDocumentsPage } from "../../src/db/aruba-inventory-queries.server.ts";
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
    remoteUpdatedFrom: postgresDateSchema.safeParse(url.searchParams.get("aggiornatoDal") ?? "")
      .success
      ? url.searchParams.get("aggiornatoDal")!
      : "",
    remoteUpdatedTo: postgresDateSchema.safeParse(url.searchParams.get("aggiornatoAl") ?? "")
      .success
      ? url.searchParams.get("aggiornatoAl")!
      : "",
    recipientCountry: (url.searchParams.get("paese") ?? "").trim().toUpperCase().slice(0, 2),
    recipientTaxId: (url.searchParams.get("identificativo") ?? "").trim().slice(0, 64),
    origin: ["HUB", "ARUBA_HISTORY"].includes(url.searchParams.get("origine") ?? "")
      ? url.searchParams.get("origine")!
      : "",
    fiscalNumber: (url.searchParams.get("numeroFiscale") ?? "").trim().slice(0, 20),
    providerFilename: (url.searchParams.get("filename") ?? "").trim().slice(0, 255),
    sdiId: (url.searchParams.get("idSdi") ?? "").trim().slice(0, 200),
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
        remoteUpdatedFrom: filters.remoteUpdatedFrom || undefined,
        remoteUpdatedTo: filters.remoteUpdatedTo || undefined,
        recipientCountry: filters.recipientCountry || undefined,
        recipientTaxId: filters.recipientTaxId || undefined,
        origin: filters.origin ? (filters.origin as "HUB" | "ARUBA_HISTORY") : undefined,
        fiscalNumber: filters.fiscalNumber || undefined,
        providerFilename: filters.providerFilename || undefined,
        sdiId: filters.sdiId || undefined,
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
    fileImported: url.searchParams.get("file") === "importato",
    arubaLookupRequested: url.searchParams.get("aruba") === "ricerca-richiesta",
    arubaRefreshRequested: url.searchParams.get("aruba") === "aggiornamento-richiesto",
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
    if (form.get("intent") === "retry-customer-email") {
      await retryCustomerEmail(
        form.get("documentId") ?? "",
        actor,
        form.get("confirmUncertain") === "yes",
        form.get("newRecipient") ?? undefined,
      );
      return redirect("/documenti?email=preparata");
    }
    if (form.get("intent") === "refresh-aruba-status") {
      await requestArubaSubmissionReadback(form.get("documentId") ?? "", actor);
      return redirect("/documenti?aruba=aggiornamento-richiesto");
    }
    if (form.get("intent") === "lookup-aruba-document") {
      await requestArubaTargetedLookup(
        {
          filename:
            form.get("lookupType") === "filename"
              ? (form.get("lookupValue") ?? undefined)
              : undefined,
          idSdi:
            form.get("lookupType") === "idSdi" ? (form.get("lookupValue") ?? undefined) : undefined,
        },
        actor,
      );
      return redirect("/documenti?vista=inventario-aruba&aruba=ricerca-richiesta");
    }
    if (form.get("intent") === "search-aruba-documents") {
      await requestArubaAdvancedSearch(
        {
          creationStart: form.get("creationStart") ?? undefined,
          creationEnd: form.get("creationEnd") ?? undefined,
          modifiedStart: form.get("modifiedStart") ?? undefined,
          modifiedEnd: form.get("modifiedEnd") ?? undefined,
          receiverCountry: form.get("receiverCountry") ?? undefined,
          receiverVatCode: form.get("receiverVatCode") ?? undefined,
          receiverFiscalCode: form.get("receiverFiscalCode") ?? undefined,
          documentType: form.get("remoteDocumentType") ?? undefined,
          status: form.get("remoteStatus") ?? undefined,
        },
        actor,
      );
      return redirect("/documenti?vista=inventario-aruba&aruba=ricerca-richiesta");
    }
    throw new Response("Azione non riconosciuta", { status: 400 });
  } catch (error) {
    if (error instanceof Response) throw error;
    const result = publicError(error);
    return data(result, { status: result.status });
  }
}

function DocumentNotices({
  arubaLookupRequested,
  arubaRefreshRequested,
  batchCreated,
  error,
  fileImported,
}: {
  arubaLookupRequested: boolean;
  arubaRefreshRequested: boolean;
  batchCreated: boolean;
  error: string | null;
  fileImported: boolean;
}) {
  return (
    <>
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
      {arubaLookupRequested || arubaRefreshRequested ? (
        <p className="notice notice--success" role="status">
          {arubaLookupRequested
            ? copy.documents.arubaLookupRequested
            : copy.documents.arubaRefreshRequested}
        </p>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </>
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
    fileImported,
    remoteDocuments,
    arubaLookupRequested,
    arubaRefreshRequested,
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
      <DocumentNotices
        arubaLookupRequested={arubaLookupRequested}
        arubaRefreshRequested={arubaRefreshRequested}
        batchCreated={batchCreated}
        error={error}
        fileImported={fileImported}
      />
      {view === "inventario-aruba" ? (
        <ArubaInventoryPanel
          canApprove={canApprove}
          csrfToken={csrfToken}
          page={page}
          query={filters.query}
          remoteDocuments={remoteDocuments}
        />
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
