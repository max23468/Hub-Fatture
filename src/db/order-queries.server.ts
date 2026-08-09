import { containsNullByte, postgresDateSchema } from "../orders.ts";
import { getPool } from "./client.server.ts";
import { isDatabaseId } from "./order-commands.server.ts";

interface SourceCustomer {
  kind?: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  email?: string;
  billingAddress?: Record<string, string | undefined>;
  taxIdentifiers?: Array<{ type?: string; value?: string; sourceField?: string }>;
}

interface OrderDetailRow {
  id: string;
  provider: string;
  display_number: string;
  local_order_date: string;
  gross_amount: number;
  payment_status: string;
  fulfillment_status: string;
  trigger_status: string;
  billing_case_id: string | null;
  case_number: string | null;
  customer_name: string;
  customer_kind: string;
  customer_email: string | null;
  billing_address_json: Record<string, string | undefined>;
  source_confidence: string;
  review_required: boolean;
  raw_snapshot_json: { customer?: SourceCustomer };
  lines: Array<{
    id: string;
    description: string;
    quantity: number;
    gross_amount: number;
    discount_amount: number;
  }>;
  taxIdentifiers: Array<{
    id: string;
    type: string;
    country_code: string | null;
    raw_value: string;
  }>;
  payments: Array<{
    id: string;
    method: string;
    status: string;
    amount: number;
    paid_at: string | null;
    recorded_manually: boolean;
  }>;
}

export async function listOrders(filters: {
  query?: string;
  provider?: string;
  status?: string;
  localDate?: string;
  paymentStatus?: string;
}) {
  if (containsNullByte(filters)) return [];
  if (filters.localDate && !postgresDateSchema.safeParse(filters.localDate).success) return [];
  const values = [
    filters.query ? `%${filters.query}%` : null,
    filters.provider || null,
    filters.status || null,
    filters.localDate || null,
    filters.paymentStatus || null,
  ];
  const result = await getPool().query<{
    id: string;
    provider: string;
    display_number: string;
    local_order_date: string;
    gross_amount: number;
    payment_status: string;
    fulfillment_status: string;
    trigger_status: string;
    customer_name: string;
    billing_case_id: string | null;
    case_number: string | null;
  }>(
    `SELECT orders.id, orders.provider, orders.display_number, orders.local_order_date::text,
            orders.gross_amount, orders.payment_status, orders.fulfillment_status,
            orders.trigger_status,
            orders.normalized_snapshot_json #>> '{customerSnapshot,displayName}' AS customer_name,
            billing_cases.id AS billing_case_id, billing_cases.public_number AS case_number
     FROM orders
     LEFT JOIN billing_cases ON billing_cases.id = orders.billing_case_id
     WHERE ($1::text IS NULL OR orders.display_number ILIKE $1
            OR orders.external_order_id ILIKE $1
            OR orders.normalized_snapshot_json #>> '{customerSnapshot,displayName}' ILIKE $1
            OR orders.normalized_snapshot_json #>> '{customerSnapshot,email}' ILIKE $1
            OR EXISTS (SELECT 1 FROM order_tax_identifiers
                       WHERE order_tax_identifiers.order_id = orders.id
                         AND (order_tax_identifiers.normalized_value ILIKE $1
                              OR order_tax_identifiers.raw_value ILIKE $1)))
       AND ($2::text IS NULL OR orders.provider = $2)
       AND ($3::text IS NULL
            OR ($3 = 'ACTIVE' AND orders.trigger_status NOT IN
                ('CANCELLED_NO_DOCUMENT', 'REFUNDED_BEFORE_ISSUE'))
            OR ($3 = 'NO_DOCUMENT' AND orders.trigger_status IN
                ('CANCELLED_NO_DOCUMENT', 'REFUNDED_BEFORE_ISSUE'))
            OR orders.trigger_status = $3)
       AND ($4::date IS NULL OR orders.local_order_date = $4)
       AND ($5::text IS NULL OR orders.payment_status = $5)
     ORDER BY orders.local_order_date DESC, orders.id DESC`,
    values,
  );
  return result.rows;
}

export async function getOrder(id: string) {
  if (!isDatabaseId(id)) return null;
  const order = await getPool().query<OrderDetailRow>(
    `SELECT orders.*, orders.local_order_date::text,
            orders.normalized_snapshot_json #>> '{customerSnapshot,displayName}' AS customer_name,
            orders.normalized_snapshot_json #>> '{customerSnapshot,kind}' AS customer_kind,
            orders.normalized_snapshot_json #>> '{customerSnapshot,email}' AS customer_email,
            orders.normalized_snapshot_json #> '{customerSnapshot,billingAddress}' AS billing_address_json,
            orders.normalized_snapshot_json #>> '{customerSnapshot,sourceConfidence}' AS source_confidence,
            (orders.normalized_snapshot_json ->> 'customerReviewRequired')::boolean AS review_required,
            billing_cases.public_number AS case_number,
            coalesce((
              SELECT jsonb_agg(to_jsonb(order_lines) ORDER BY order_lines.id)
              FROM order_lines WHERE order_lines.order_id = orders.id
            ), '[]'::jsonb) AS lines,
            coalesce((
              SELECT jsonb_agg(to_jsonb(order_tax_identifiers) ORDER BY order_tax_identifiers.id)
              FROM order_tax_identifiers WHERE order_tax_identifiers.order_id = orders.id
            ), '[]'::jsonb) AS "taxIdentifiers",
            coalesce((
              SELECT jsonb_agg(to_jsonb(payments) ORDER BY payments.id)
              FROM payments WHERE payments.order_id = orders.id
            ), '[]'::jsonb) AS payments
     FROM orders
     LEFT JOIN billing_cases ON billing_cases.id = orders.billing_case_id
     WHERE orders.id = $1`,
    [id],
  );
  return order.rows[0] ?? null;
}

export async function dashboardSummary() {
  const result = await getPool().query<{
    orders: string;
    ready_cases: string;
    review_cases: string;
    waiting_orders: string;
    pending_payments: string;
  }>(
    `SELECT
       (SELECT count(*) FROM orders)::text AS orders,
       (SELECT count(*) FROM billing_cases WHERE status = 'READY')::text AS ready_cases,
       (SELECT count(*) FROM billing_cases WHERE status = 'NEEDS_REVIEW')::text AS review_cases,
       (SELECT count(*) FROM orders WHERE trigger_status = 'WAITING_FOR_TRIGGER')::text AS waiting_orders,
       (SELECT count(*) FROM orders
        WHERE trigger_status NOT IN ('CANCELLED_NO_DOCUMENT', 'REFUNDED_BEFORE_ISSUE')
          AND (payment_status = 'PENDING'
            OR EXISTS (SELECT 1 FROM payments WHERE payments.order_id = orders.id
                        AND payments.status = 'PENDING')))::text AS pending_payments`,
  );
  return result.rows[0]!;
}
