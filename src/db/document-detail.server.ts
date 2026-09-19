import { documentInputSchema, fiscalProfileSchema } from "../documents.ts";
import { fiscalNumberLabel } from "../fiscal-number.ts";
import { listOfficialArubaFiles } from "./aruba.server.ts";
import { billingCaseAwaitingActionSql } from "./billing-case-sql.server.ts";
import { getPool } from "./client.server.ts";
import { isDatabaseId } from "./database-id.ts";
import { documentRowsSql } from "./document-archive-rows.server.ts";
import type { DocumentListRow } from "./document-archive-types.server.ts";
import { listEmailDeliveries } from "./email.server.ts";

interface LinkedDocument {
  id: string;
  kind: "INVOICE" | "CREDIT_NOTE";
  status: "DRAFT" | "APPROVED";
  series: string;
  fiscal_year: number | null;
  fiscal_number: number | null;
  document_date: string;
  total_amount: number;
}

interface DocumentDetailRow extends DocumentListRow {
  immutable_snapshot_json: unknown;
  fiscal_profile_snapshot_json: unknown;
  approved_at: string | null;
  billing_case_open: boolean;
  orders: Array<{ id: string; provider: "SHOPIFY" | "EBAY"; display_number: string }>;
  related_documents: LinkedDocument[];
  credit_balance: { invoice_total: number; credited_amount: number } | null;
  refunds: Array<{ id: string; display_number: string; amount: number }>;
  audit: Array<{ id: string; action: string; created_at: string; reason: string | null }>;
}

function linkedFiscalLabel(document: LinkedDocument) {
  return document.fiscal_year && document.fiscal_number
    ? fiscalNumberLabel(document.series, document.fiscal_year, document.fiscal_number)
    : null;
}

/**
 * Il dettaglio di un documento riunisce ciò che è stato emesso e il suo ciclo di trasmissione.
 * Il contenuto fiscale viene dallo snapshot immutabile da cui è stato generato l'XML: la bozza
 * appartiene alla preparazione e qui non viene mai ricostruita.
 */
export async function getDocumentDetail(documentId: string) {
  if (!isDatabaseId(documentId)) return null;
  const result = await getPool().query<DocumentDetailRow>(
    `WITH document_rows AS (${documentRowsSql} WHERE documents.id = $1)
     SELECT document_rows.*, documents.immutable_snapshot_json,
            documents.fiscal_profile_snapshot_json, documents.approved_at::text,
            ${billingCaseAwaitingActionSql("billing_cases")} AS billing_case_open,
            coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                'id', orders.id::text, 'provider', orders.provider,
                'display_number', orders.display_number
              ) ORDER BY orders.local_order_date, orders.id)
              FROM document_orders
              JOIN orders ON orders.id = document_orders.order_id
              WHERE document_orders.document_id = documents.id
            ), '[]'::jsonb) AS orders,
            coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                'id', related.id::text, 'kind', related.kind, 'status', related.status,
                'series', related.series, 'fiscal_year', related.fiscal_year,
                'fiscal_number', related.fiscal_number,
                'document_date', related.document_date::text,
                'total_amount', related.total_amount
              ) ORDER BY related.document_date, related.id)
              FROM document_links AS links
              JOIN documents AS related
                ON related.id = CASE WHEN links.document_id = documents.id
                                     THEN links.related_document_id ELSE links.document_id END
              WHERE links.document_id = documents.id OR links.related_document_id = documents.id
            ), '[]'::jsonb) AS related_documents,
            (
              SELECT jsonb_build_object(
                'invoice_total', invoice.total_amount,
                'credited_amount', balances.credited_amount
              )
              FROM document_links AS links
              JOIN documents AS invoice ON invoice.id = links.related_document_id
              JOIN credit_note_balances AS balances ON balances.invoice_document_id = invoice.id
              WHERE links.document_id = documents.id AND documents.kind = 'CREDIT_NOTE'
              LIMIT 1
            ) AS credit_balance,
            coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                'id', refunds.id::text, 'display_number', orders.display_number,
                'amount', refunds.amount
              ) ORDER BY refunds.id)
              FROM refunds JOIN orders ON orders.id = refunds.order_id
              WHERE refunds.credit_document_id = documents.id
            ), '[]'::jsonb) AS refunds,
            coalesce((
              SELECT jsonb_agg(to_jsonb(document_audit) ORDER BY document_audit.created_at DESC)
              FROM (
                SELECT id::text, action, reason, created_at
                FROM audit_events
                WHERE entity_type = 'DOCUMENT' AND entity_id = documents.id::text
              ) AS document_audit
            ), '[]'::jsonb) AS audit
     FROM document_rows
     JOIN documents ON documents.id = document_rows.id
     JOIN billing_cases ON billing_cases.id = documents.billing_case_id`,
    [documentId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const content =
    row.status === "APPROVED" ? documentInputSchema.safeParse(row.immutable_snapshot_json) : null;
  const profile = fiscalProfileSchema.safeParse(row.fiscal_profile_snapshot_json);
  const [officialFiles, emailDeliveries] = await Promise.all([
    listOfficialArubaFiles([row.id]),
    listEmailDeliveries([row.id]),
  ]);
  const {
    immutable_snapshot_json: _snapshot,
    fiscal_profile_snapshot_json: _profile,
    related_documents: relatedDocuments,
    ...document
  } = row;
  return {
    ...document,
    fiscal_label:
      row.fiscal_year && row.fiscal_number
        ? fiscalNumberLabel(row.series, row.fiscal_year, row.fiscal_number)
        : null,
    related_documents: relatedDocuments.map((related) => ({
      ...related,
      fiscal_label: linkedFiscalLabel(related),
    })),
    content: content?.success ? content.data : null,
    taxTreatment: profile.success
      ? {
          seller: profile.data.seller.businessName,
          taxNature: profile.data.taxNature,
          legalReference: profile.data.legalReference,
        }
      : null,
    officialFiles,
    email: emailDeliveries[0],
  };
}

/**
 * Una preparazione chiusa con una fattura emessa non è più un luogo di lavoro: il suo indirizzo
 * porta al documento. Senza fattura emessa resta consultabile, per motivo e riattivazione.
 */
export async function closedBillingCaseDocumentId(caseId: string) {
  if (!isDatabaseId(caseId)) return null;
  const result = await getPool().query<{ id: string }>(
    `SELECT documents.id::text
     FROM billing_cases
     JOIN documents ON documents.billing_case_id = billing_cases.id
     WHERE billing_cases.id = $1
       AND NOT ${billingCaseAwaitingActionSql("billing_cases")}
       AND documents.kind = 'INVOICE' AND documents.status = 'APPROVED'
     ORDER BY documents.approved_at DESC NULLS LAST, documents.id DESC
     LIMIT 1`,
    [caseId],
  );
  return result.rows[0]?.id ?? null;
}
