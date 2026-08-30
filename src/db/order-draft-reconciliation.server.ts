import type pg from "pg";

import { refreshInvoiceDraftProjection } from "./invoice-draft-projection.server.ts";

async function invoiceDraftAuditSnapshot(client: pg.PoolClient, caseId: string, lock = false) {
  const result = await client.query<{ id: string; snapshot: Record<string, unknown> }>(
    `SELECT documents.id, jsonb_build_object(
       'recipient', documents.recipient_snapshot_json,
       'lines', coalesce((
         SELECT jsonb_agg(jsonb_build_object(
           'orderId', document_lines.order_id::text,
           'description', document_lines.description,
           'quantity', document_lines.quantity,
           'unitAmount', document_lines.unit_amount
         ) ORDER BY document_lines.line_number)
         FROM document_lines WHERE document_lines.document_id = documents.id
       ), '[]'::jsonb),
       'sourceTotal', documents.source_total_amount,
       'total', documents.total_amount,
       'difference', documents.difference_amount,
       'paymentStatus', documents.payment_status,
       'paymentMethod', documents.payment_method,
       'causale', documents.causale,
       'notes', documents.notes,
       'draftVersion', documents.draft_version,
       'projectionSha256', documents.projection_sha256
     ) AS snapshot
     FROM documents
     WHERE documents.billing_case_id = $1
       AND documents.kind = 'INVOICE' AND documents.status = 'DRAFT'
     ${lock ? "FOR UPDATE OF documents" : ""}`,
    [caseId],
  );
  return result.rows[0] ?? null;
}

export async function reconcileInvoiceDraft(
  client: pg.PoolClient,
  caseId: string,
  fallbackDifferenceReason = "Importi personalizzati prima della modifica della regola commissioni Shopify Payments",
) {
  const before = await invoiceDraftAuditSnapshot(client, caseId, true);
  const documentId = before?.id;
  if (!documentId) return null;
  await client.query(
    `DELETE FROM document_lines
     WHERE document_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM orders
         WHERE orders.id = document_lines.order_id AND orders.billing_case_id = $2
       )`,
    [documentId, caseId],
  );
  await client.query(
    `DELETE FROM document_orders
     WHERE document_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM orders
         WHERE orders.id = document_orders.order_id AND orders.billing_case_id = $2
       )`,
    [documentId, caseId],
  );
  await client.query(
    `WITH desired AS (
       SELECT orders.id,
              orders.billable_amount - coalesce((
                SELECT sum(refunds.amount) FROM refunds
                WHERE refunds.order_id = orders.id AND refunds.applied_before_issue
              ), 0) AS amount
       FROM orders WHERE orders.billing_case_id = $2
     )
     UPDATE document_lines
     SET quantity = 1, unit_amount = desired.amount, total_amount = desired.amount
     FROM document_orders, desired
     WHERE document_lines.document_id = $1
       AND document_orders.document_id = document_lines.document_id
       AND document_orders.order_id = document_lines.order_id
       AND desired.id = document_lines.order_id
       AND document_lines.quantity = 1
       AND document_lines.unit_amount = document_orders.amount
       AND document_lines.total_amount = document_orders.amount
       AND document_orders.amount <> desired.amount`,
    [documentId, caseId],
  );
  await client.query(
    `WITH desired AS (
       SELECT orders.id,
              orders.billable_amount - coalesce((
                SELECT sum(refunds.amount) FROM refunds
                WHERE refunds.order_id = orders.id AND refunds.applied_before_issue
              ), 0) AS amount
       FROM orders WHERE orders.billing_case_id = $2
     )
     UPDATE document_orders
     SET amount = desired.amount
     FROM desired
     WHERE document_orders.document_id = $1
       AND document_orders.order_id = desired.id
       AND document_orders.amount <> desired.amount`,
    [documentId, caseId],
  );
  await client.query(
    `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
     SELECT $1, 'INVOICE', orders.id,
            orders.billable_amount - coalesce((
              SELECT sum(refunds.amount) FROM refunds
              WHERE refunds.order_id = orders.id AND refunds.applied_before_issue
            ), 0)
     FROM orders
     WHERE orders.billing_case_id = $2
       AND NOT EXISTS (
         SELECT 1 FROM document_orders
         WHERE document_orders.document_id = $1 AND document_orders.order_id = orders.id
       )`,
    [documentId, caseId],
  );
  await client.query(
    `WITH missing AS (
       SELECT orders.id,
              'Vendita beni usati - Ordine '
                || CASE orders.provider WHEN 'SHOPIFY' THEN 'Shopify' ELSE 'eBay' END
                || ' ' || orders.display_number AS description,
              orders.billable_amount - coalesce((
                SELECT sum(refunds.amount) FROM refunds
                WHERE refunds.order_id = orders.id AND refunds.applied_before_issue
              ), 0) AS billable_amount,
              row_number() OVER (ORDER BY orders.id) AS position
       FROM orders
       WHERE orders.billing_case_id = $2
         AND NOT EXISTS (
           SELECT 1 FROM document_lines
           WHERE document_lines.document_id = $1 AND document_lines.order_id = orders.id
         )
     ), offset_value AS (
       SELECT coalesce(max(line_number), 0) AS value
       FROM document_lines WHERE document_id = $1
     )
     INSERT INTO document_lines
       (document_id, order_id, line_number, description, quantity, unit_amount,
        total_amount, tax_nature)
     SELECT $1, missing.id, offset_value.value + missing.position, missing.description,
            1, missing.billable_amount, missing.billable_amount, 'N5'
     FROM missing CROSS JOIN offset_value`,
    [documentId, caseId],
  );
  await client.query(
    `WITH totals AS (
       SELECT coalesce((SELECT sum(document_orders.amount) FROM document_orders
                        WHERE document_orders.document_id = $1), 0)::integer AS source_total,
              coalesce((SELECT sum(document_lines.total_amount) FROM document_lines
                        WHERE document_lines.document_id = $1), 0)::integer AS document_total
     )
     UPDATE documents
     SET source_total_amount = totals.source_total,
         total_amount = totals.document_total,
         difference_amount = totals.document_total - totals.source_total,
         difference_reason = CASE
           WHEN totals.document_total = totals.source_total THEN NULL
           ELSE coalesce(documents.difference_reason, $2)
         END,
         draft_version = draft_version + 1,
         projection_sha256 = repeat('0', 64),
         updated_at = now()
     FROM totals
     WHERE id = $1`,
    [documentId, fallbackDifferenceReason],
  );
  const after = await invoiceDraftAuditSnapshot(client, caseId);
  return after ? { before: before.snapshot, after: after.snapshot } : null;
}

export async function reconcilePreIssueInvoiceAmount(
  client: pg.PoolClient,
  orderId: string,
  caseId: string,
  amount: number,
) {
  const adjusted = await client.query(
    `UPDATE document_orders SET amount = $2
     WHERE order_id = $1 AND document_kind = 'INVOICE' AND amount <> $2`,
    [orderId, amount],
  );
  if (!adjusted.rowCount) return false;
  await client.query(
    `UPDATE document_lines
     SET quantity = 1, unit_amount = $2, total_amount = $2
     WHERE order_id = $1
       AND document_id IN (SELECT id FROM documents WHERE kind = 'INVOICE' AND status = 'DRAFT')`,
    [orderId, amount],
  );
  await client.query(
    `UPDATE documents
     SET source_total_amount = totals.amount,
         total_amount = totals.amount,
         difference_amount = 0,
         difference_reason = NULL,
         draft_version = draft_version + 1,
         projection_sha256 = repeat('0', 64),
         updated_at = now()
     FROM (
       SELECT document_id, sum(amount)::integer AS amount
       FROM document_orders WHERE document_kind = 'INVOICE' GROUP BY document_id
     ) AS totals
     WHERE documents.id = totals.document_id
       AND documents.billing_case_id = $1 AND documents.status = 'DRAFT'`,
    [caseId],
  );
  await refreshInvoiceDraftProjection(client, caseId);
  return true;
}
