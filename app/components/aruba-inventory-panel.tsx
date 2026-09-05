import { Link } from "react-router";

import type { listRemoteDocumentsPage } from "../../src/db/aruba-inventory-queries.server.ts";
import { copy } from "../copy.it";
import { date, dateTime, euros } from "../format";
import { ArubaDocumentSearch } from "./aruba-document-search";
import { Pager } from "./pager";

type RemoteDocuments = Awaited<ReturnType<typeof listRemoteDocumentsPage>>;
type RemoteDocument = RemoteDocuments["rows"][number];

function ArubaInventoryRow({ remote }: { remote: RemoteDocument }) {
  return (
    <tr id={`documento-aruba-${remote.id}`}>
      <td data-label={copy.documents.document}>
        <strong>
          {remote.document_type} {remote.series ?? ""} {remote.fiscal_number ?? remote.remote_id}
        </strong>
        {remote.provider_filename ? <small>{remote.provider_filename}</small> : null}
        {remote.provider_sdi_id ? (
          <small>
            {copy.documents.sdiId}: {remote.provider_sdi_id}
          </small>
        ) : null}
      </td>
      <td data-label={copy.documents.date}>{date(remote.document_date)}</td>
      <td data-label={copy.documents.total}>{euros(remote.total_amount)}</td>
      <td data-label={copy.documents.arubaStatus}>
        {copy.documents.remoteStatusLabels[remote.remote_status] ?? remote.remote_status}
      </td>
      <td data-label={copy.documents.matchStatus}>
        {remote.identity_excluded
          ? "Escluso dai collegamenti"
          : (copy.documents.matchStatusLabels[remote.match_status] ?? remote.match_status)}
      </td>
      <td data-label={copy.documents.remoteLastReadback}>{dateTime(remote.last_observed_at)}</td>
      <td data-label={copy.documents.control}>
        {remote.requires_control ? (
          <Link
            className="dashboard-row-link"
            to={`/controlli?id=${encodeURIComponent(`ARUBA_REMOTE:${remote.control_remote_id}`)}`}
          >
            {copy.documents.openControl}
          </Link>
        ) : (
          <span>{copy.documents.inventoryOnly}</span>
        )}
      </td>
    </tr>
  );
}

export function ArubaInventoryPanel({
  canApprove,
  csrfToken,
  page,
  query,
  remoteDocuments,
}: {
  canApprove: boolean;
  csrfToken: string;
  page: number;
  query: string;
  remoteDocuments: RemoteDocuments;
}) {
  return (
    <section
      className="dashboard-panel remote-documents-panel section-gap"
      aria-labelledby="remote-documents-title"
    >
      <h2 id="remote-documents-title">{copy.documents.remoteDocumentsTitle}</h2>
      <p>{copy.documents.remoteDocumentsHelp}</p>
      {canApprove ? <ArubaDocumentSearch csrfToken={csrfToken} /> : null}
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
                <ArubaInventoryRow key={remote.id} remote={remote} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>
          {query ? copy.documents.noRemoteSearchResults(query) : copy.documents.noRemoteDocuments}
        </p>
      )}
      <Pager basePath="/documenti" hasNext={remoteDocuments.hasNext} page={page} />
    </section>
  );
}
