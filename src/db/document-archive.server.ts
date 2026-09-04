import { fiscalNumberLabel } from "../fiscal-number.ts";
import { escapeLike, PAGE_SIZE, pageOffset, paginate } from "../orders.ts";
import { getPool } from "./client.server.ts";
import { documentRowsSql } from "./document-archive-rows.server.ts";
import { documentArchiveSearchSql } from "./document-archive-search.server.ts";
import {
  documentListSortSql,
  type DocumentListFilters,
  type DocumentListRow,
} from "./document-archive-types.server.ts";

export type { DocumentListFilters, DocumentListSortKey } from "./document-archive-types.server.ts";

export async function listDocuments(filters: DocumentListFilters = {}) {
  const query = filters.query?.trim();
  const sort = filters.sort ?? { key: "data", direction: "desc" };
  const orderBy = documentListSortSql[sort.key];
  const direction = sort.direction === "asc" ? "ASC" : "DESC";
  // Colonna e direzione provengono esclusivamente dalle allowlist di modulo;
  // i valori della richiesta restano nei parametri $1-$16.
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
              ${documentArchiveSearchSql}
              OR provider_filename ILIKE $1 ESCAPE '\\'
              OR provider_sdi_id ILIKE $1 ESCAPE '\\')
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
       AND ($8::date IS NULL OR remote_updated_at::timestamptz >= $8::date)
       AND ($9::date IS NULL OR remote_updated_at::timestamptz < $9::date + interval '1 day')
       AND ($10::text IS NULL OR recipient_country = $10)
       AND ($11::text IS NULL OR recipient_tax_identity LIKE '%' || $11 || '%')
       AND ($12::text IS NULL OR origin = $12)
       AND ($13::text IS NULL OR fiscal_number::text = $13)
       AND ($14::text IS NULL OR provider_filename ILIKE $14 ESCAPE '\\')
       AND ($15::text IS NULL OR provider_sdi_id ILIKE $15 ESCAPE '\\')
     ORDER BY ${orderBy} ${direction} NULLS LAST, document_date DESC, id DESC
     LIMIT ${PAGE_SIZE + 1} OFFSET $16`,
    [
      query ? `%${escapeLike(query)}%` : null,
      filters.kind ?? null,
      filters.status ?? null,
      filters.arubaStatus ?? null,
      filters.transmission ?? null,
      filters.dateFrom ?? null,
      filters.dateTo ?? null,
      filters.remoteUpdatedFrom ?? null,
      filters.remoteUpdatedTo ?? null,
      filters.recipientCountry?.toUpperCase() ?? null,
      filters.recipientTaxId?.replace(/[^A-Za-z0-9]/g, "").toUpperCase() ?? null,
      filters.origin ?? null,
      filters.fiscalNumber ?? null,
      filters.providerFilename ? `%${escapeLike(filters.providerFilename)}%` : null,
      filters.sdiId ? `%${escapeLike(filters.sdiId)}%` : null,
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
