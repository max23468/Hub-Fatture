import { fiscalNumberLabel } from "../fiscal-number.ts";
import { escapeLike } from "../orders.ts";
import { listRemoteDocumentsPage } from "./aruba-inventory-queries.server.ts";
import { getPool } from "./client.server.ts";
import { listAuditHistory } from "./order-queries.server.ts";
import { refreshOperationalControls } from "./operational-controls.server.ts";

const SEARCH_RESULT_LIMIT = 5;
const MAX_SEARCH_LENGTH = 100;

export interface GlobalSearchResults {
  query: string;
  totals: {
    orders: number;
    invoices: number;
    creditNotes: number;
    customers: number;
    controls: number;
    history: number;
    remoteDocuments: number;
  };
  orders: Array<{
    id: string;
    provider: "SHOPIFY" | "EBAY";
    displayNumber: string;
    customerName: string;
    localOrderDate: string;
    href: string;
  }>;
  invoices: Array<{
    id: string;
    fiscalLabel: string | null;
    caseNumber: string;
    customerName: string;
    documentDate: string;
    status: string;
    href: string;
  }>;
  /** Contratto additivo per le schede aperte durante un deploy applicativo. */
  documents: GlobalSearchResults["invoices"];
  creditNotes: Array<{
    id: string;
    fiscalLabel: string | null;
    customerName: string;
    documentDate: string;
    status: string;
    href: string;
  }>;
  customers: Array<{
    id: string;
    displayName: string;
    email: string | null;
    taxId: string | null;
    orderCount: number;
    documentCount: number;
    href: string;
  }>;
  controls: Array<{
    id: string;
    title: string;
    detail: string;
    severity: string;
    state: string;
    href: string;
  }>;
  history: Array<{
    id: string;
    action: string;
    subject: string | null;
    createdAt: string;
    href: string;
  }>;
  remoteDocuments: Array<{
    id: string;
    documentType: "TD01" | "TD04";
    series: string | null;
    fiscalNumber: string | null;
    remoteId: string;
    documentDate: string;
    matchStatus: string;
    href: string;
  }>;
}

export function emptyGlobalSearch(query = ""): GlobalSearchResults {
  const invoices: GlobalSearchResults["invoices"] = [];
  return {
    query,
    totals: {
      orders: 0,
      invoices: 0,
      creditNotes: 0,
      customers: 0,
      controls: 0,
      history: 0,
      remoteDocuments: 0,
    },
    orders: [],
    invoices,
    documents: invoices,
    creditNotes: [],
    customers: [],
    controls: [],
    history: [],
    remoteDocuments: [],
  };
}

function normalizedQuery(value: unknown): string {
  return typeof value === "string"
    ? value.replaceAll("\0", "").trim().slice(0, MAX_SEARCH_LENGTH)
    : "";
}

function filteredHref(path: string, query: string, extra?: Record<string, string>) {
  const params = new URLSearchParams({ ...extra, q: query });
  return `${path}?${params.toString()}`;
}

export async function searchGlobal(value: unknown): Promise<GlobalSearchResults> {
  const query = normalizedQuery(value);
  if (query.length < 2) return emptyGlobalSearch(query);
  await refreshOperationalControls();
  const pattern = `%${escapeLike(query)}%`;
  const pool = getPool();
  const [orders, documents, customers, controls, history, remoteDocuments] = await Promise.all([
    pool.query<{
      id: string;
      provider: "SHOPIFY" | "EBAY";
      display_number: string;
      customer_name: string;
      local_order_date: string;
      total_count: number;
    }>(
      `SELECT orders.id::text, orders.provider, orders.display_number,
              customers.display_name AS customer_name, orders.local_order_date::text,
              count(*) OVER()::int AS total_count
       FROM orders
       JOIN customers ON customers.id = orders.customer_id
       WHERE orders.display_number ILIKE $1 ESCAPE '\\'
          OR orders.external_order_id ILIKE $1 ESCAPE '\\'
          OR customers.display_name ILIKE $1 ESCAPE '\\'
          OR customers.first_name ILIKE $1 ESCAPE '\\'
          OR customers.last_name ILIKE $1 ESCAPE '\\'
          OR customers.company_name ILIKE $1 ESCAPE '\\'
          OR customers.email ILIKE $1 ESCAPE '\\'
          OR customers.phone ILIKE $1 ESCAPE '\\'
          OR customers.tax_id_normalized ILIKE $1 ESCAPE '\\'
          OR EXISTS (
            SELECT 1 FROM order_tax_identifiers
            WHERE order_tax_identifiers.order_id = orders.id
              AND (order_tax_identifiers.normalized_value ILIKE $1 ESCAPE '\\'
                OR order_tax_identifiers.raw_value ILIKE $1 ESCAPE '\\')
          )
       ORDER BY
         CASE WHEN lower(orders.display_number) = lower($2) THEN 0 ELSE 1 END,
         orders.local_order_date DESC, orders.id DESC
       LIMIT ${SEARCH_RESULT_LIMIT}`,
      [pattern, query],
    ),
    pool.query<{
      id: string;
      kind: "INVOICE" | "CREDIT_NOTE";
      series: string;
      fiscal_year: number | null;
      fiscal_number: number | null;
      case_number: string;
      customer_name: string;
      document_date: string;
      status: string;
      billing_case_id: string;
      total_count: number;
    }>(
      `WITH matching_documents AS (
         SELECT documents.id::text, documents.kind, documents.series, documents.fiscal_year,
                documents.fiscal_number, billing_cases.public_number AS case_number,
                coalesce(documents.recipient_snapshot_json ->> 'displayName',
                         billing_cases.customer_snapshot_json ->> 'displayName',
                         customers.display_name) AS customer_name,
                documents.document_date::text, documents.status,
                billing_cases.id::text AS billing_case_id,
                count(*) OVER (PARTITION BY documents.kind)::int AS total_count,
                row_number() OVER (
                  PARTITION BY documents.kind
                  ORDER BY documents.document_date DESC, documents.id DESC
                ) AS result_rank
         FROM documents
         JOIN billing_cases ON billing_cases.id = documents.billing_case_id
         JOIN customers ON customers.id = billing_cases.customer_id
         WHERE billing_cases.public_number ILIKE $1 ESCAPE '\\'
            OR concat(documents.series, ' ', lpad(documents.fiscal_number::text, 4, '0'),
                      '/', right(documents.fiscal_year::text, 2)) ILIKE $1 ESCAPE '\\'
            OR documents.fiscal_number::text ILIKE $1 ESCAPE '\\'
            OR coalesce(documents.recipient_snapshot_json ->> 'displayName', '')
                 ILIKE $1 ESCAPE '\\'
            OR coalesce(documents.recipient_snapshot_json ->> 'companyName', '')
                 ILIKE $1 ESCAPE '\\'
            OR coalesce(documents.recipient_snapshot_json ->> 'email', '')
                 ILIKE $1 ESCAPE '\\'
            OR coalesce(billing_cases.customer_snapshot_json ->> 'displayName', '')
                 ILIKE $1 ESCAPE '\\'
            OR coalesce(billing_cases.customer_snapshot_json ->> 'companyName', '')
                 ILIKE $1 ESCAPE '\\'
            OR coalesce(billing_cases.customer_snapshot_json ->> 'email', '')
                 ILIKE $1 ESCAPE '\\'
            OR customers.display_name ILIKE $1 ESCAPE '\\'
            OR customers.email ILIKE $1 ESCAPE '\\'
            OR customers.phone ILIKE $1 ESCAPE '\\'
            OR customers.tax_id_normalized ILIKE $1 ESCAPE '\\'
            OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements(
                CASE
                  WHEN jsonb_typeof(coalesce(documents.recipient_snapshot_json,
                    billing_cases.customer_snapshot_json) -> 'taxIdentifiers') = 'array'
                    THEN coalesce(documents.recipient_snapshot_json,
                      billing_cases.customer_snapshot_json) -> 'taxIdentifiers'
                  ELSE '[]'::jsonb
                END
              ) AS identifier
              WHERE coalesce(identifier ->> 'normalizedValue', identifier ->> 'value', '')
                ILIKE $1 ESCAPE '\\'
            )
            OR EXISTS (
              SELECT 1 FROM document_orders
              JOIN orders ON orders.id = document_orders.order_id
              LEFT JOIN order_tax_identifiers ON order_tax_identifiers.order_id = orders.id
              WHERE document_orders.document_id = documents.id
                AND (orders.display_number ILIKE $1 ESCAPE '\\'
                  OR orders.external_order_id ILIKE $1 ESCAPE '\\'
                  OR order_tax_identifiers.normalized_value ILIKE $1 ESCAPE '\\'
                  OR order_tax_identifiers.raw_value ILIKE $1 ESCAPE '\\')
            )
       )
       SELECT id, kind, series, fiscal_year, fiscal_number, case_number, customer_name,
              document_date, status, billing_case_id, total_count
       FROM matching_documents
       WHERE result_rank <= ${SEARCH_RESULT_LIMIT}
       ORDER BY kind, document_date DESC, id DESC`,
      [pattern],
    ),
    pool.query<{
      id: string;
      display_name: string;
      email: string | null;
      tax_id_normalized: string | null;
      order_count: string;
      document_count: string;
      total_count: number;
    }>(
      `SELECT customers.id::text, customers.display_name, customers.email,
              customers.tax_id_normalized,
              coalesce(order_summary.order_count, 0)::text AS order_count,
              coalesce(document_summary.document_count, 0)::text AS document_count,
              count(*) OVER()::int AS total_count
       FROM customers
       LEFT JOIN LATERAL (
         SELECT count(*) AS order_count FROM orders WHERE orders.customer_id = customers.id
       ) AS order_summary ON true
       LEFT JOIN LATERAL (
         SELECT count(*) AS document_count
         FROM documents
         JOIN billing_cases ON billing_cases.id = documents.billing_case_id
         WHERE billing_cases.customer_id = customers.id
       ) AS document_summary ON true
       WHERE customers.display_name ILIKE $1 ESCAPE '\\'
          OR customers.first_name ILIKE $1 ESCAPE '\\'
          OR customers.last_name ILIKE $1 ESCAPE '\\'
          OR customers.company_name ILIKE $1 ESCAPE '\\'
          OR customers.email ILIKE $1 ESCAPE '\\'
          OR customers.phone ILIKE $1 ESCAPE '\\'
          OR customers.tax_id_normalized ILIKE $1 ESCAPE '\\'
          OR EXISTS (
            SELECT 1 FROM customer_source_records
            WHERE customer_source_records.customer_id = customers.id
              AND customer_source_records.external_customer_id ILIKE $1 ESCAPE '\\'
          )
          OR EXISTS (
            SELECT 1 FROM order_tax_identifiers
            JOIN orders AS tax_orders ON tax_orders.id = order_tax_identifiers.order_id
            WHERE tax_orders.customer_id = customers.id
              AND (order_tax_identifiers.normalized_value ILIKE $1 ESCAPE '\\'
                OR order_tax_identifiers.raw_value ILIKE $1 ESCAPE '\\')
          )
       ORDER BY
         CASE WHEN lower(customers.display_name) = lower($2) THEN 0 ELSE 1 END,
         customers.updated_at DESC, customers.id DESC
       LIMIT ${SEARCH_RESULT_LIMIT}`,
      [pattern, query],
    ),
    pool.query<{
      id: string;
      title: string;
      detail: string;
      severity: string;
      state: string;
      total_count: number;
    }>(
      `SELECT id, title, detail, severity, state, count(*) OVER()::int AS total_count
       FROM operational_controls
       WHERE state IN ('OPEN', 'WAITING')
         AND (title ILIKE $1 ESCAPE '\\'
           OR detail ILIKE $1 ESCAPE '\\'
           OR source_id ILIKE $1 ESCAPE '\\'
           OR metadata_json::text ILIKE $1 ESCAPE '\\')
       ORDER BY CASE state WHEN 'OPEN' THEN 0 ELSE 1 END,
         CASE severity WHEN 'BLOCKING' THEN 0 WHEN 'IMPORTANT' THEN 1 ELSE 2 END,
         opened_at, id
       LIMIT ${SEARCH_RESULT_LIMIT}`,
      [pattern],
    ),
    listAuditHistory({ query }),
    listRemoteDocumentsPage({ query }),
  ]);

  const invoices = documents.rows.filter((row) => row.kind === "INVOICE");
  const creditNotes = documents.rows.filter((row) => row.kind === "CREDIT_NOTE");
  const totals = {
    orders: orders.rows[0]?.total_count ?? 0,
    invoices: invoices[0]?.total_count ?? 0,
    creditNotes: creditNotes[0]?.total_count ?? 0,
    customers: customers.rows[0]?.total_count ?? 0,
    controls: controls.rows[0]?.total_count ?? 0,
    history: history.total,
    remoteDocuments: remoteDocuments.total,
  };

  const invoiceResults: GlobalSearchResults["invoices"] = invoices.map((row) => ({
    id: row.id,
    fiscalLabel:
      row.fiscal_year && row.fiscal_number
        ? fiscalNumberLabel(row.series, row.fiscal_year, row.fiscal_number)
        : null,
    caseNumber: row.case_number,
    customerName: row.customer_name,
    documentDate: row.document_date,
    status: row.status,
    href: `/ordini/preparazione/${row.billing_case_id}`,
  }));

  return {
    query,
    totals,
    orders: orders.rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      displayNumber: row.display_number,
      customerName: row.customer_name,
      localOrderDate: row.local_order_date,
      href: `/ordini/${row.id}`,
    })),
    invoices: invoiceResults,
    documents: invoiceResults,
    creditNotes: creditNotes.map((row) => ({
      id: row.id,
      fiscalLabel:
        row.fiscal_year && row.fiscal_number
          ? fiscalNumberLabel(row.series, row.fiscal_year, row.fiscal_number)
          : null,
      customerName: row.customer_name,
      documentDate: row.document_date,
      status: row.status,
      href: `/documenti/${row.id}/nota`,
    })),
    customers: customers.rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      email: row.email,
      taxId: row.tax_id_normalized,
      orderCount: Number(row.order_count),
      documentCount: Number(row.document_count),
      href: `/clienti/${row.id}`,
    })),
    controls: controls.rows.map((row) => ({
      id: row.id,
      title: row.title,
      detail: row.detail,
      severity: row.severity,
      state: row.state,
      href: `/controlli?id=${encodeURIComponent(row.id)}${row.state === "WAITING" ? "&vista=attesa" : ""}`,
    })),
    history: history.rows.slice(0, SEARCH_RESULT_LIMIT).map((row) => ({
      id: row.id,
      action: row.action,
      subject: row.case_number ?? row.order_number ?? row.entity_id,
      createdAt: row.created_at,
      href:
        row.entity_type === "BILLING_CASE" && row.entity_id
          ? `/ordini/preparazione/${row.entity_id}`
          : row.entity_type === "ORDER" && row.entity_id
            ? `/ordini/${row.entity_id}`
            : row.entity_type === "REFUND" && row.refund_order_id
              ? `/ordini/${row.refund_order_id}`
              : filteredHref("/attivita", query, { vista: "cronologia" }),
    })),
    remoteDocuments: remoteDocuments.rows.slice(0, SEARCH_RESULT_LIMIT).map((row) => ({
      id: row.id,
      documentType: row.document_type,
      series: row.series,
      fiscalNumber: row.fiscal_number,
      remoteId: row.remote_id,
      documentDate: row.document_date,
      matchStatus: row.match_status,
      href: `${filteredHref("/documenti", query, { vista: "inventario-aruba" })}#documento-aruba-${row.id}`,
    })),
  };
}
