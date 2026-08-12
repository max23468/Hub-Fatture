import { containsNullByte, escapeLike, PAGE_SIZE, pageOffset, paginate } from "../orders.ts";
import { getPool } from "./client.server.ts";
import { isDatabaseId } from "./database-id.ts";

export async function customerDirectorySummary() {
  const result = await getPool().query<{
    total: number;
    needs_review: number;
    shopify: number;
    ebay: number;
  }>(
    `SELECT count(*)::integer AS total,
            count(*) FILTER (WHERE customers.review_required)::integer AS needs_review,
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
}) {
  const empty = { rows: [] as never[], hasNext: false };
  if (containsNullByte(filters)) return empty;
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
    `SELECT customers.id, customers.kind, customers.display_name, customers.email,
            customers.tax_id_type, customers.tax_id_normalized, customers.review_required,
            customers.source_confidence, customers.updated_at::text,
            coalesce(sources.providers, ARRAY[]::text[]) AS providers,
            coalesce(order_summary.order_count, 0)::integer AS order_count,
            coalesce(case_summary.preparation_count, 0)::integer AS preparation_count,
            coalesce(document_summary.document_count, 0)::integer AS document_count,
            order_summary.last_order_date::text
     FROM customers
     LEFT JOIN LATERAL (
       SELECT array_agg(DISTINCT customer_source_records.provider
                        ORDER BY customer_source_records.provider) AS providers
       FROM customer_source_records
       WHERE customer_source_records.customer_id = customers.id
     ) AS sources ON true
     LEFT JOIN LATERAL (
       SELECT count(*) AS order_count, max(orders.local_order_date) AS last_order_date
       FROM orders WHERE orders.customer_id = customers.id
     ) AS order_summary ON true
     LEFT JOIN LATERAL (
       SELECT count(*) AS preparation_count
       FROM billing_cases WHERE billing_cases.customer_id = customers.id
     ) AS case_summary ON true
     LEFT JOIN LATERAL (
       SELECT count(*) AS document_count
       FROM documents
       JOIN billing_cases ON billing_cases.id = documents.billing_case_id
       WHERE billing_cases.customer_id = customers.id
     ) AS document_summary ON true
     WHERE ($1::text IS NULL OR customers.display_name ILIKE $1
            OR customers.email ILIKE $1 OR customers.phone ILIKE $1
            OR customers.tax_id_normalized ILIKE $1
            OR EXISTS (
              SELECT 1 FROM customer_source_records
              WHERE customer_source_records.customer_id = customers.id
                AND customer_source_records.external_customer_id ILIKE $1
            ))
       AND ($2::boolean IS NULL OR customers.review_required = $2)
     ORDER BY customers.review_required DESC,
              order_summary.last_order_date DESC NULLS LAST,
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
            customers.review_required, customers.created_at::text, customers.updated_at::text,
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
