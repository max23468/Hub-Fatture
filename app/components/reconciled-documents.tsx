import { Link } from "react-router";

import type { ReconciledSourceDocument } from "../../src/db/invoice-source-preparations.server.ts";
import { fiscalNumberLabel } from "../../src/fiscal-number.ts";
import { copy } from "../copy.it";
import { euros } from "../format";

export function ReconciledDocuments({ documents }: { documents: ReconciledSourceDocument[] }) {
  if (!documents.length) return null;
  return (
    <section className="card section-gap" aria-labelledby="fatture-collegate">
      <h2 id="fatture-collegate">{copy.preparation.invoicedTitle}</h2>
      <p>{copy.preparation.invoicedHelp}</p>
      <ul className="plain-list">
        {documents.map((document) => (
          <li key={document.id}>
            <strong>
              {fiscalNumberLabel(document.series, document.fiscal_year, document.fiscal_number)} ·{" "}
              {euros(document.total_amount)}
            </strong>
            <span>
              {document.orders.map((order, index) => (
                <span key={order.id}>
                  {index ? " · " : null}
                  <Link to={`/ordini/${order.id}`}>
                    {order.provider === "SHOPIFY" ? "Shopify" : "eBay"} {order.display_number}
                  </Link>
                </span>
              ))}
            </span>
            <Link to={`/ordini/preparazione/${document.billing_case_id}`}>
              {copy.preparation.archivedPreparation(document.public_number)}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
