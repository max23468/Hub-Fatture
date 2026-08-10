import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/documents";

import { AppShell } from "../components/app-shell";
import { copy } from "../copy.it";
import { date, euros } from "../format";
import { requireSessionUser } from "../../src/db/auth.server.ts";
import { listDocuments } from "../../src/db/documents.server.ts";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  return {
    username: user.username,
    csrfToken: user.csrfToken,
    documents: await listDocuments(),
  };
}

export default function Documents() {
  const { username, csrfToken, documents } = useLoaderData<typeof loader>();
  return (
    <AppShell username={username} csrfToken={csrfToken}>
      <div className="title-block">
        <p className="eyebrow">{copy.documents.eyebrow}</p>
        <h1>{copy.documents.title}</h1>
        <p>{copy.documents.intro}</p>
      </div>
      {documents.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{copy.documents.number}</th>
                <th>{copy.documents.customer}</th>
                <th>{copy.documents.date}</th>
                <th>{copy.documents.total}</th>
                <th>{copy.documents.status}</th>
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
                  <td data-label={copy.documents.file}>
                    {document.xml_sha256 ? (
                      <a href={`/documenti/${document.id}/xml`}>{copy.documents.downloadXml}</a>
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
    </AppShell>
  );
}
