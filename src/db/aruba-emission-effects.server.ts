import type pg from "pg";

import { scheduleCustomerEmail } from "./email.server.ts";

export async function scheduleArubaEmissionEffects(client: pg.PoolClient, documentId: string) {
  const emitted = await client.query(
    `SELECT 1 FROM aruba_submissions
     WHERE document_id = $1 AND status IN ('DELIVERED', 'NOT_DELIVERED') LIMIT 1`,
    [documentId],
  );
  if (!emitted.rows[0]) return false;
  await client.query(
    `INSERT INTO jobs (type, payload_json)
     SELECT 'process_refund', jsonb_build_object('refundId', refunds.id::text)
     FROM refunds
     JOIN document_orders
       ON document_orders.order_id = refunds.order_id
      AND document_orders.document_kind = 'INVOICE'
     WHERE document_orders.document_id = $1
       AND refunds.status IN ('COMPLETED', 'AMBIGUOUS')
       AND NOT refunds.applied_before_issue
       AND refunds.credit_document_id IS NULL
     ON CONFLICT DO NOTHING`,
    [documentId],
  );
  await scheduleCustomerEmail(client, documentId);
  return true;
}
