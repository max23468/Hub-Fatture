import { fiscalNumberLabel } from "../fiscal-number.ts";
import { escapeLike, PAGE_SIZE, pageOffset, paginate } from "../orders.ts";
import { getPool } from "./client.server.ts";
import { documentArchiveSearchSql } from "./document-archive-search.server.ts";

export interface DocumentListFilters {
  query?: string;
  kind?: "INVOICE" | "CREDIT_NOTE";
  status?: "DRAFT" | "APPROVED";
  arubaStatus?: string;
  transmission?: "TO_SEND" | "RECONCILIATION_REQUIRED";
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  sort?: { key: DocumentListSortKey; direction: "asc" | "desc" };
}

export type DocumentListSortKey = "documento" | "cliente" | "data" | "totale" | "stato" | "email";

interface DocumentListRow {
  id: string;
  billing_case_id: string;
  public_number: string;
  source_billing_case_id: string | null;
  source_public_number: string | null;
  kind: "INVOICE" | "CREDIT_NOTE";
  origin: "HUB" | "ARUBA_HISTORY";
  status: "DRAFT" | "APPROVED";
  series: string;
  fiscal_year: number | null;
  fiscal_number: number | null;
  document_date: string;
  total_amount: number;
  customer_name: string;
  xml_sha256: string | null;
  aruba_batch_id: string | null;
  aruba_status: string | null;
  historical_order_id: string | null;
}

const documentRowsSql = `
  SELECT documents.id, documents.billing_case_id, billing_cases.public_number,
         documents.source_billing_case_id,
         source_billing_cases.public_number AS source_public_number,
         documents.kind, documents.origin, documents.status,
         documents.series, documents.fiscal_year, documents.fiscal_number,
         documents.document_date::text, documents.total_amount, documents.xml_sha256,
         billing_cases.customer_snapshot_json ->> 'displayName' AS customer_name,
         aruba_current.id AS aruba_batch_id, aruba_current.status AS aruba_status,
         (SELECT email_deliveries.status
          FROM email_deliveries
          WHERE email_deliveries.document_id = documents.id
          ORDER BY email_deliveries.created_at DESC, email_deliveries.id DESC
          LIMIT 1) AS email_status,
         (SELECT document_orders.order_id::text FROM document_orders
          WHERE document_orders.document_id = documents.id LIMIT 1) AS historical_order_id
  FROM documents
  JOIN billing_cases ON billing_cases.id = documents.billing_case_id
  LEFT JOIN billing_cases AS source_billing_cases
    ON source_billing_cases.id = documents.source_billing_case_id
  LEFT JOIN LATERAL (
    SELECT aruba_batches.id, aruba_batches.status
    FROM aruba_batch_documents
    JOIN aruba_batches ON aruba_batches.id = aruba_batch_documents.batch_id
    WHERE aruba_batch_documents.document_id = documents.id
    ORDER BY aruba_batches.created_at DESC LIMIT 1
  ) AS aruba_current ON true`;

const documentListSortSql: Record<DocumentListSortKey, string> = {
  documento: `CASE
       WHEN fiscal_number IS NOT NULL AND fiscal_year IS NOT NULL
         THEN concat_ws(' ', series, lpad(fiscal_number::text, 10, '0'), fiscal_year::text)
       ELSE lpad(public_number, 10, '0')
     END`,
  cliente: "customer_name",
  data: "document_date",
  totale: "total_amount",
  stato: "concat_ws(' ', status, aruba_status)",
  email: "email_status",
};

export async function listDocuments(filters: DocumentListFilters = {}) {
  const query = filters.query?.trim();
  const sort = filters.sort ?? { key: "data", direction: "desc" };
  const orderBy = documentListSortSql[sort.key];
  const direction = sort.direction === "asc" ? "ASC" : "DESC";
  // Colonna e direzione provengono esclusivamente dalle allowlist di modulo;
  // i valori della richiesta restano nei parametri $1-$8.
  // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk
  const result = await getPool().query<
    {
      id: string;
    } & DocumentListRow
  >(
    `WITH document_rows AS (${documentRowsSql})
     SELECT * FROM document_rows
     WHERE ($1::text IS NULL OR customer_name ILIKE $1 ESCAPE '\\'
              OR public_number ILIKE $1 ESCAPE '\\'
              OR source_public_number ILIKE $1 ESCAPE '\\'
              OR fiscal_number::text ILIKE $1 ESCAPE '\\'
              OR concat_ws(' ', series, lpad(fiscal_number::text, 4, '0'),
                   right(fiscal_year::text, 2)) ILIKE $1 ESCAPE '\\'
              ${documentArchiveSearchSql})
       AND ($2::text IS NULL OR kind = $2)
       AND ($3::text IS NULL OR status = $3)
       AND ($4::text IS NULL OR aruba_status = $4
            OR ($4 = 'NOT_PREPARED' AND status = 'APPROVED' AND origin = 'HUB'
                AND aruba_status IS NULL))
       AND ($5::text IS NULL OR
            ($5 = 'TO_SEND' AND status = 'APPROVED' AND origin = 'HUB'
             AND (aruba_status IS NULL OR aruba_status IN
                  ('PREPARED', 'HELPER_ACTIVE', 'VALIDATION_FAILED', 'READY_ASSISTED')))
            OR ($5 = 'RECONCILIATION_REQUIRED'
                AND aruba_status = 'RECONCILIATION_REQUIRED'))
       AND ($6::date IS NULL OR document_date::date >= $6)
       AND ($7::date IS NULL OR document_date::date <= $7)
     ORDER BY ${orderBy} ${direction} NULLS LAST, document_date DESC, id DESC
     LIMIT ${PAGE_SIZE + 1} OFFSET $8`,
    [
      query ? `%${escapeLike(query)}%` : null,
      filters.kind ?? null,
      filters.status ?? null,
      filters.arubaStatus ?? null,
      filters.transmission ?? null,
      filters.dateFrom ?? null,
      filters.dateTo ?? null,
      pageOffset(filters.page),
    ],
  );
  const page = paginate(result.rows);
  return {
    ...page,
    rows: page.rows.map((row) => ({
      ...row,
      fiscal_label:
        row.fiscal_year && row.fiscal_number
          ? fiscalNumberLabel(row.series, row.fiscal_year, row.fiscal_number)
          : null,
    })),
  };
}

export async function documentArchiveSummary() {
  const result = await getPool().query<{
    total: number;
    invoices: number;
    credit_notes: number;
    to_send: number;
    reconciliation_required: number;
  }>(
    `WITH document_rows AS (${documentRowsSql})
     SELECT count(*)::integer AS total,
            count(*) FILTER (WHERE kind = 'INVOICE')::integer AS invoices,
            count(*) FILTER (WHERE kind = 'CREDIT_NOTE')::integer AS credit_notes,
            count(*) FILTER (
              WHERE status = 'APPROVED' AND origin = 'HUB'
                AND (aruba_status IS NULL OR aruba_status IN
                     ('PREPARED', 'HELPER_ACTIVE', 'VALIDATION_FAILED', 'READY_ASSISTED'))
            )::integer AS to_send,
            count(*) FILTER (
              WHERE aruba_status = 'RECONCILIATION_REQUIRED'
            )::integer AS reconciliation_required
     FROM document_rows`,
  );
  return result.rows[0]!;
}
