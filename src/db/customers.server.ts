import { containsNullByte, escapeLike, PAGE_SIZE, pageOffset, paginate } from "../orders.ts";
import { approvedInvoiceOrderLinkSql } from "./billing-case-sql.server.ts";
import { getPool } from "./client.server.ts";
import { isDatabaseId } from "./database-id.ts";

export type CustomerListSortKey =
  | "cliente"
  | "email"
  | "fiscale"
  | "canale"
  | "ultimoOrdine"
  | "ordini"
  | "documenti";

type SortDirection = "asc" | "desc";

const customerListSortSql: Record<CustomerListSortKey, string> = {
  cliente: "lower(customers.display_name)",
  email: "lower(customers.email)",
  fiscale: "lower(customers.tax_id_normalized)",
  canale: "array_to_string(customers.providers, ' ')",
  ultimoOrdine: "customers.last_order_date",
  ordini: "customers.order_count",
  documenti: "customers.document_count",
};

// Il flag persistito descrive la qualità dell'ultimo profilo sorgente, non basta da solo
// a rappresentare lavoro ancora eseguibile. La directory segnala soltanto un'anagrafica
// che blocca un ordine storico o una preparazione ancora aperta.
const actionableCustomerReviewSql = `customers.review_required AND EXISTS (
  SELECT 1
  FROM orders AS review_orders
  LEFT JOIN billing_cases AS review_cases ON review_cases.id = review_orders.billing_case_id
  WHERE review_orders.customer_id = customers.id
    AND NOT ${approvedInvoiceOrderLinkSql("review_orders")}
    AND coalesce(
      (review_orders.normalized_snapshot_json ->> 'customerReviewRequired')::boolean,
      customers.review_required
    )
    AND (
      (
        review_orders.billing_case_id IS NULL
        AND review_orders.trigger_status IN ('NEEDS_REVIEW', 'LEGACY_BILLING_REVIEW')
      )
      OR (
        review_cases.status = 'NEEDS_REVIEW'
        AND coalesce(
          (review_cases.customer_snapshot_json ->> 'reviewRequired')::boolean,
          true
        )
      )
    )
)`;

export async function listActionableCustomerReviews() {
  const result = await getPool().query<{
    id: string;
    display_name: string;
    updated_at: string;
  }>(
    `SELECT customers.id::text, customers.display_name, customers.updated_at::text
     FROM customers
     WHERE ${actionableCustomerReviewSql}
     ORDER BY customers.updated_at, customers.id`,
  );
  return result.rows;
}

export async function customerDirectorySummary() {
  const result = await getPool().query<{
    total: number;
    needs_review: number;
    shopify: number;
    ebay: number;
  }>(
    `SELECT count(*)::integer AS total,
            count(*) FILTER (WHERE ${actionableCustomerReviewSql})::integer AS needs_review,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM customer_source_records
              WHERE customer_source_records.customer_id = customers.id
                AND customer_source_records.provider = 'SHOPIFY'
            ))::integer AS shopify,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM customer_source_records
              WHERE customer_source_records.customer_id = customers.id
                AND customer_source_records.provider = 'EBAY'
            ))::integer AS ebay
     FROM customers`,
  );
  return result.rows[0]!;
}

export async function listCustomers(filters: {
  query?: string;
  needsReview?: boolean;
  page?: unknown;
  sort?: { key: CustomerListSortKey; direction: SortDirection };
}) {
  const empty = { rows: [] as never[], hasNext: false };
  if (containsNullByte(filters)) return empty;
  const sort = filters.sort ?? { key: "ultimoOrdine", direction: "desc" };
  const orderBy = customerListSortSql[sort.key];
  const direction = sort.direction === "asc" ? "ASC" : "DESC";
  const result = await getPool().query<{
    id: string;
    kind: string;
    display_name: string;
    email: string | null;
    tax_id_type: string | null;
    tax_id_normalized: string | null;
    review_required: boolean;
    source_confidence: string;
    updated_at: string;
    providers: string[];
    order_count: number;
    preparation_count: number;
    document_count: number;
    last_order_date: string | null;
  }>(
    `WITH source_summary AS (
       SELECT customer_source_records.customer_id,
              array_agg(DISTINCT customer_source_records.provider
                        ORDER BY customer_source_records.provider) AS providers
       FROM customer_source_records
       GROUP BY customer_source_records.customer_id
     ), order_summary AS (
       SELECT orders.customer_id, count(*)::integer AS order_count,
              max(orders.local_order_date) AS last_order_date
       FROM orders
       GROUP BY orders.customer_id
     ), case_summary AS (
       SELECT billing_cases.customer_id, count(*)::integer AS preparation_count
       FROM billing_cases
       GROUP BY billing_cases.customer_id
     ), document_summary AS (
       SELECT billing_cases.customer_id, count(documents.id)::integer AS document_count
       FROM billing_cases
       JOIN documents ON documents.billing_case_id = billing_cases.id
       GROUP BY billing_cases.customer_id
     ), actionable_reviews AS (
       SELECT DISTINCT review_orders.customer_id
       FROM orders AS review_orders
       JOIN customers AS review_customers ON review_customers.id = review_orders.customer_id
       LEFT JOIN billing_cases AS review_cases ON review_cases.id = review_orders.billing_case_id
       WHERE coalesce(
         (review_orders.normalized_snapshot_json ->> 'customerReviewRequired')::boolean,
         review_customers.review_required
       )
       AND (
         (
           review_orders.billing_case_id IS NULL
           AND review_orders.trigger_status IN ('NEEDS_REVIEW', 'LEGACY_BILLING_REVIEW')
         )
         OR (
           review_cases.status = 'NEEDS_REVIEW'
           AND coalesce(
             (review_cases.customer_snapshot_json ->> 'reviewRequired')::boolean,
             true
           )
         )
       )
     ), customers_with_summary AS (
       SELECT customers.id, customers.kind, customers.display_name, customers.email,
            customers.phone,
            customers.tax_id_type, customers.tax_id_normalized,
            actionable_reviews.customer_id IS NOT NULL AS review_required,
            customers.source_confidence, customers.updated_at::text,
            coalesce(source_summary.providers, ARRAY[]::text[]) AS providers,
            coalesce(order_summary.order_count, 0)::integer AS order_count,
            coalesce(case_summary.preparation_count, 0)::integer AS preparation_count,
            coalesce(document_summary.document_count, 0)::integer AS document_count,
            order_summary.last_order_date::text
       FROM customers
       LEFT JOIN source_summary ON source_summary.customer_id = customers.id
       LEFT JOIN order_summary ON order_summary.customer_id = customers.id
       LEFT JOIN case_summary ON case_summary.customer_id = customers.id
       LEFT JOIN document_summary ON document_summary.customer_id = customers.id
       LEFT JOIN actionable_reviews ON actionable_reviews.customer_id = customers.id
     )
     SELECT customers.id, customers.kind, customers.display_name, customers.email,
            customers.tax_id_type, customers.tax_id_normalized, customers.review_required,
            customers.source_confidence, customers.updated_at, customers.providers,
            customers.order_count, customers.preparation_count, customers.document_count,
            customers.last_order_date
     FROM customers_with_summary AS customers
     WHERE ($1::text IS NULL OR customers.display_name ILIKE $1
            OR customers.email ILIKE $1 OR customers.phone ILIKE $1
            OR customers.tax_id_normalized ILIKE $1
            OR EXISTS (
              SELECT 1 FROM customer_source_records
              WHERE customer_source_records.customer_id = customers.id
                AND customer_source_records.external_customer_id ILIKE $1
            ))
       AND ($2::boolean IS NULL OR customers.review_required = $2)
     ORDER BY ${orderBy} ${direction} NULLS LAST,
              customers.review_required DESC,
              customers.updated_at DESC, customers.id DESC
     LIMIT ${PAGE_SIZE + 1} OFFSET $3`,
    [
      filters.query ? `%${escapeLike(filters.query)}%` : null,
      filters.needsReview ?? null,
      pageOffset(filters.page),
    ],
  );
  return paginate(result.rows);
}

export interface CustomerDetail {
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
  created_at: string;
  updated_at: string;
  order_count: number;
  preparation_count: number;
  document_count: number;
  sources: Array<{
    id: string;
    provider: string;
    external_customer_id: string;
    imported_at: string;
  }>;
  orders: Array<{
    id: string;
    provider: string;
    display_number: string;
    local_order_date: string;
    gross_amount: number;
    trigger_status: string;
    billing_case_id: string | null;
    case_number: string | null;
  }>;
  preparations: Array<{
    id: string;
    public_number: string;
    local_order_date: string;
    status: string;
    order_count: number;
    total_amount: number;
  }>;
  documents: Array<{
    id: string;
    billing_case_id: string;
    kind: string;
    origin: string;
    status: string;
    series: string;
    fiscal_year: number | null;
    fiscal_number: number | null;
    document_date: string;
    total_amount: number;
  }>;
}

export async function getCustomer(id: string | undefined): Promise<CustomerDetail | null> {
  if (!id || !isDatabaseId(id)) return null;
  const result = await getPool().query<CustomerDetail>(
    `SELECT customers.id, customers.kind, customers.display_name, customers.first_name,
            customers.last_name, customers.company_name, customers.email, customers.phone,
            customers.tax_id_type, customers.tax_id_normalized, customers.vat_country,
            customers.billing_address_json, customers.source_confidence,
            (${actionableCustomerReviewSql}) AS review_required,
            customers.created_at::text, customers.updated_at::text,
            (SELECT count(*)::integer FROM orders
             WHERE orders.customer_id = customers.id) AS order_count,
            (SELECT count(*)::integer FROM billing_cases
             WHERE billing_cases.customer_id = customers.id) AS preparation_count,
            (SELECT count(*)::integer FROM documents
             JOIN billing_cases ON billing_cases.id = documents.billing_case_id
             WHERE billing_cases.customer_id = customers.id) AS document_count,
            coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                'id', source.id::text,
                'provider', source.provider,
                'external_customer_id', source.external_customer_id,
                'imported_at', source.imported_at
              ) ORDER BY source.provider, source.id)
              FROM customer_source_records AS source
              WHERE source.customer_id = customers.id
            ), '[]'::jsonb) AS sources,
            coalesce((
              SELECT jsonb_agg(to_jsonb(recent_orders) ORDER BY recent_orders.local_order_date DESC,
                               recent_orders.id DESC)
              FROM (
                SELECT orders.id::text, orders.provider, orders.display_number,
                       orders.local_order_date::text, orders.gross_amount,
                       orders.trigger_status, orders.billing_case_id::text,
                       billing_cases.public_number AS case_number
                FROM orders
                LEFT JOIN billing_cases ON billing_cases.id = orders.billing_case_id
                WHERE orders.customer_id = customers.id
                ORDER BY orders.local_order_date DESC, orders.id DESC
                LIMIT 50
              ) AS recent_orders
            ), '[]'::jsonb) AS orders,
            coalesce((
              SELECT jsonb_agg(to_jsonb(recent_cases) ORDER BY recent_cases.local_order_date DESC,
                               recent_cases.id DESC)
              FROM (
                SELECT billing_cases.id::text, billing_cases.public_number,
                       billing_cases.local_order_date::text, billing_cases.status,
                       count(orders.id)::integer AS order_count,
                       coalesce(sum(orders.gross_amount), 0)::integer AS total_amount
                FROM billing_cases
                LEFT JOIN orders ON orders.billing_case_id = billing_cases.id
                WHERE billing_cases.customer_id = customers.id
                GROUP BY billing_cases.id
                ORDER BY billing_cases.local_order_date DESC, billing_cases.id DESC
                LIMIT 50
              ) AS recent_cases
            ), '[]'::jsonb) AS preparations,
            coalesce((
              SELECT jsonb_agg(to_jsonb(recent_documents)
                               ORDER BY recent_documents.document_date DESC,
                                        recent_documents.id DESC)
              FROM (
                SELECT documents.id::text, documents.billing_case_id::text, documents.kind,
                       documents.origin, documents.status, documents.series,
                       documents.fiscal_year, documents.fiscal_number,
                       documents.document_date::text, documents.total_amount
                FROM documents
                JOIN billing_cases ON billing_cases.id = documents.billing_case_id
                WHERE billing_cases.customer_id = customers.id
                ORDER BY documents.document_date DESC, documents.id DESC
                LIMIT 50
              ) AS recent_documents
            ), '[]'::jsonb) AS documents
     FROM customers
     WHERE customers.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}
