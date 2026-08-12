import { escapeLike } from "../orders.ts";
import { fiscalNumberLabel } from "../fiscal-number.ts";
import { getPool } from "./client.server.ts";
import { isDatabaseId } from "./database-id.ts";

const SEARCH_RESULT_LIMIT = 5;
const MAX_SEARCH_LENGTH = 100;

export interface GlobalSearchResults {
  query: string;
  orders: Array<{
    id: string;
    provider: "SHOPIFY" | "EBAY";
    displayNumber: string;
    customerName: string;
    localOrderDate: string;
    href: string;
  }>;
  documents: Array<{
    id: string;
    fiscalLabel: string | null;
    caseNumber: string;
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
}

export function emptyGlobalSearch(query = ""): GlobalSearchResults {
  return { query, orders: [], documents: [], customers: [] };
}

function normalizedQuery(value: unknown): string {
  return typeof value === "string"
    ? value.replaceAll("\0", "").trim().slice(0, MAX_SEARCH_LENGTH)
    : "";
}

export async function searchGlobal(value: unknown): Promise<GlobalSearchResults> {
  const query = normalizedQuery(value);
  if (query.length < 2) return emptyGlobalSearch(query);
  const pattern = `%${escapeLike(query)}%`;
  const pool = getPool();
  const [orders, documents, customers] = await Promise.all([
    pool.query<{
      id: string;
      provider: "SHOPIFY" | "EBAY";
      display_number: string;
      customer_name: string;
      local_order_date: string;
    }>(
      `SELECT orders.id::text, orders.provider, orders.display_number,
              customers.display_name AS customer_name, orders.local_order_date::text
       FROM orders
       JOIN customers ON customers.id = orders.customer_id
       WHERE orders.display_number ILIKE $1 ESCAPE '\\'
          OR orders.external_order_id ILIKE $1 ESCAPE '\\'
          OR customers.display_name ILIKE $1 ESCAPE '\\'
          OR customers.first_name ILIKE $1 ESCAPE '\\'
          OR customers.last_name ILIKE $1 ESCAPE '\\'
          OR customers.company_name ILIKE $1 ESCAPE '\\'
          OR customers.email ILIKE $1 ESCAPE '\\'
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
      series: string;
      fiscal_year: number | null;
      fiscal_number: number | null;
      case_number: string;
      customer_name: string;
      document_date: string;
      status: string;
      billing_case_id: string;
    }>(
      `SELECT documents.id::text, documents.series, documents.fiscal_year,
              documents.fiscal_number, billing_cases.public_number AS case_number,
              coalesce(billing_cases.customer_snapshot_json ->> 'displayName',
                       customers.display_name) AS customer_name,
              documents.document_date::text, documents.status,
              billing_cases.id::text AS billing_case_id
       FROM documents
       JOIN billing_cases ON billing_cases.id = documents.billing_case_id
       JOIN customers ON customers.id = billing_cases.customer_id
       WHERE documents.kind = 'INVOICE'
         AND (
           billing_cases.public_number ILIKE $1 ESCAPE '\\'
           OR concat(documents.series, ' ', lpad(documents.fiscal_number::text, 4, '0'),
                     '/', right(documents.fiscal_year::text, 2)) ILIKE $1 ESCAPE '\\'
           OR documents.fiscal_number::text ILIKE $1 ESCAPE '\\'
           OR coalesce(billing_cases.customer_snapshot_json ->> 'displayName', '')
                ILIKE $1 ESCAPE '\\'
           OR coalesce(billing_cases.customer_snapshot_json ->> 'companyName', '')
                ILIKE $1 ESCAPE '\\'
           OR coalesce(billing_cases.customer_snapshot_json ->> 'email', '')
                ILIKE $1 ESCAPE '\\'
           OR customers.display_name ILIKE $1 ESCAPE '\\'
           OR customers.email ILIKE $1 ESCAPE '\\'
           OR customers.tax_id_normalized ILIKE $1 ESCAPE '\\'
           OR EXISTS (
             SELECT 1 FROM document_orders
             JOIN orders ON orders.id = document_orders.order_id
             LEFT JOIN order_tax_identifiers ON order_tax_identifiers.order_id = orders.id
             WHERE document_orders.document_id = documents.id
               AND (orders.display_number ILIKE $1 ESCAPE '\\'
                 OR order_tax_identifiers.normalized_value ILIKE $1 ESCAPE '\\'
                 OR order_tax_identifiers.raw_value ILIKE $1 ESCAPE '\\')
           )
         )
       ORDER BY documents.document_date DESC, documents.id DESC
       LIMIT ${SEARCH_RESULT_LIMIT}`,
      [pattern],
    ),
    pool.query<{
      id: string;
      display_name: string;
      email: string | null;
      tax_id_normalized: string | null;
      order_count: string;
      document_count: string;
    }>(
      `SELECT customers.id::text, customers.display_name, customers.email,
              customers.tax_id_normalized,
              count(DISTINCT orders.id)::text AS order_count,
              count(DISTINCT documents.id)::text AS document_count
       FROM customers
       LEFT JOIN orders ON orders.customer_id = customers.id
       LEFT JOIN billing_cases ON billing_cases.customer_id = customers.id
       LEFT JOIN documents ON documents.billing_case_id = billing_cases.id
         AND documents.kind = 'INVOICE'
       WHERE customers.display_name ILIKE $1 ESCAPE '\\'
          OR customers.first_name ILIKE $1 ESCAPE '\\'
          OR customers.last_name ILIKE $1 ESCAPE '\\'
          OR customers.company_name ILIKE $1 ESCAPE '\\'
          OR customers.email ILIKE $1 ESCAPE '\\'
          OR customers.tax_id_normalized ILIKE $1 ESCAPE '\\'
          OR EXISTS (
            SELECT 1 FROM order_tax_identifiers
            JOIN orders AS tax_orders ON tax_orders.id = order_tax_identifiers.order_id
            WHERE tax_orders.customer_id = customers.id
              AND (order_tax_identifiers.normalized_value ILIKE $1 ESCAPE '\\'
                OR order_tax_identifiers.raw_value ILIKE $1 ESCAPE '\\')
          )
       GROUP BY customers.id
       ORDER BY
         CASE WHEN lower(customers.display_name) = lower($2) THEN 0 ELSE 1 END,
         customers.updated_at DESC, customers.id DESC
       LIMIT ${SEARCH_RESULT_LIMIT}`,
      [pattern, query],
    ),
  ]);

  return {
    query,
    orders: orders.rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      displayNumber: row.display_number,
      customerName: row.customer_name,
      localOrderDate: row.local_order_date,
      href: `/ordini/${row.id}`,
    })),
    documents: documents.rows.map((row) => ({
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
  };
}

export async function getCustomer(id: string) {
  if (!isDatabaseId(id)) return null;
  const result = await getPool().query<{
    id: string;
    kind: string;
    display_name: string;
    first_name: string | null;
    last_name: string | null;
    company_name: string | null;
    email: string | null;
    phone: string | null;
    tax_id_type: string | null;
    tax_id_normalized: string | null;
    vat_country: string | null;
    billing_address_json: Record<string, string | undefined>;
    source_confidence: string;
    review_required: boolean;
    order_count: string;
    document_count: string;
    orders: Array<{
      id: string;
      provider: "SHOPIFY" | "EBAY";
      displayNumber: string;
      localOrderDate: string;
      grossAmount: number;
    }>;
    documents: Array<{
      id: string;
      fiscalSeries: string;
      fiscalYear: number | null;
      fiscalNumber: number | null;
      caseId: string;
      caseNumber: string;
      documentDate: string;
      totalAmount: number;
      status: string;
    }>;
  }>(
    `SELECT customers.*,
            (SELECT count(*)::text FROM orders WHERE orders.customer_id = customers.id)
              AS order_count,
            (SELECT count(*)::text FROM billing_cases
             JOIN documents ON documents.billing_case_id = billing_cases.id
             WHERE billing_cases.customer_id = customers.id AND documents.kind = 'INVOICE')
              AS document_count,
            coalesce((
              SELECT jsonb_agg(to_jsonb(recent_orders) ORDER BY recent_orders."localOrderDate" DESC,
                                                            recent_orders.id DESC)
              FROM (
                SELECT orders.id::text, orders.provider,
                       orders.display_number AS "displayNumber",
                       orders.local_order_date::text AS "localOrderDate",
                       orders.gross_amount AS "grossAmount"
                FROM orders WHERE orders.customer_id = customers.id
                ORDER BY orders.local_order_date DESC, orders.id DESC LIMIT 20
              ) AS recent_orders
            ), '[]'::jsonb) AS orders,
            coalesce((
              SELECT jsonb_agg(to_jsonb(recent_documents)
                               ORDER BY recent_documents."documentDate" DESC,
                                        recent_documents.id DESC)
              FROM (
                SELECT documents.id::text, documents.series AS "fiscalSeries",
                       documents.fiscal_year AS "fiscalYear",
                       documents.fiscal_number AS "fiscalNumber",
                       billing_cases.id::text AS "caseId",
                       billing_cases.public_number AS "caseNumber",
                       documents.document_date::text AS "documentDate",
                       documents.total_amount AS "totalAmount", documents.status
                FROM billing_cases
                JOIN documents ON documents.billing_case_id = billing_cases.id
                WHERE billing_cases.customer_id = customers.id AND documents.kind = 'INVOICE'
                ORDER BY documents.document_date DESC, documents.id DESC LIMIT 20
              ) AS recent_documents
            ), '[]'::jsonb) AS documents
     FROM customers WHERE customers.id = $1`,
    [id],
  );
  const customer = result.rows[0];
  if (!customer) return null;
  return {
    ...customer,
    documents: customer.documents.map(
      ({ fiscalSeries, fiscalYear, fiscalNumber, ...document }) => ({
        ...document,
        fiscalLabel:
          fiscalYear && fiscalNumber
            ? fiscalNumberLabel(fiscalSeries, fiscalYear, fiscalNumber)
            : null,
      }),
    ),
  };
}
