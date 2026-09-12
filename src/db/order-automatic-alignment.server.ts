import type pg from "pg";

import { recipientFromCustomerSnapshot } from "../documents.ts";
import { writeAudit } from "./audit.server.ts";
import { deleteOrphanedCustomers } from "./customer-cleanup.server.ts";
import { recomputeBillingCaseStatus } from "./billing-case-status.server.ts";
import { openBillingCaseSql } from "./billing-case-sql.server.ts";
import type { Provider } from "./connector-types.server.ts";
import { refreshInvoiceDraftProjection } from "./invoice-draft-projection.server.ts";

/**
 * Un replay dello stesso payload può migliorare soltanto la sua interpretazione. Per una
 * preparazione singola ancora da verificare, riallinea cliente, destinatario e stato senza
 * trasformare la correzione del mapper in un falso conflitto della sorgente.
 */
export async function reconcileMapperCustomerCorrection(
  client: pg.PoolClient,
  input: {
    caseId: string;
    orderId: string;
    oldCustomerId: string;
    newCustomerId: string;
    previousSnapshot: Record<string, unknown>;
    customerSnapshot: Record<string, unknown>;
    requestId: string;
    provider: Provider;
    reason?: string;
  },
) {
  const previousCustomer = input.previousSnapshot.customerSnapshot as
    | Record<string, unknown>
    | undefined;
  if (
    previousCustomer?.reviewRequired !== true ||
    input.customerSnapshot.reviewRequired !== false
  ) {
    return false;
  }
  const updated = await client.query(
    `UPDATE billing_cases
     SET customer_id = $2, customer_snapshot_json = $3, customer_corrected_at = now(),
         revision = revision + 1, updated_at = now()
     WHERE id = $1 AND status = 'NEEDS_REVIEW' AND customer_corrected_at IS NULL
       AND (SELECT count(*) FROM orders WHERE billing_case_id = billing_cases.id) = 1
       AND NOT EXISTS (
         SELECT 1 FROM billing_cases AS other
         WHERE other.id <> billing_cases.id AND other.customer_id = $2
           AND other.local_order_date = billing_cases.local_order_date
           AND other.currency = billing_cases.currency
           AND ${openBillingCaseSql("other")}
       )`,
    [input.caseId, input.newCustomerId, JSON.stringify(input.customerSnapshot)],
  );
  if (!updated.rowCount) return false;
  await client.query("UPDATE orders SET customer_id = $2 WHERE id = $1", [
    input.orderId,
    input.newCustomerId,
  ]);
  await client.query(
    `UPDATE documents
     SET recipient_snapshot_json = $2, draft_version = draft_version + 1,
         projection_sha256 = repeat('0', 64), updated_at = now()
     WHERE billing_case_id = $1 AND kind = 'INVOICE' AND status = 'DRAFT'`,
    [input.caseId, JSON.stringify(recipientFromCustomerSnapshot(input.customerSnapshot))],
  );
  await writeAudit(client, {
    actorType: "SYSTEM",
    action: "CUSTOMER_CORRECTED",
    eventClass: "CRITICAL",
    entityType: "BILLING_CASE",
    entityId: input.caseId,
    metadata: { billingCaseId: input.caseId, provider: input.provider },
    before: previousCustomer,
    after: input.customerSnapshot,
    reason:
      input.reason ??
      `Rilettura dello stesso payload con il mapper ${input.provider === "SHOPIFY" ? "Shopify" : "eBay"} corretto`,
    requestId: input.requestId,
  });
  await deleteOrphanedCustomers(client, [input.oldCustomerId]);
  await recomputeBillingCaseStatus(client, input.caseId);
  await refreshInvoiceDraftProjection(client, input.caseId);
  return true;
}

/**
 * Una preparazione aperta può restare sul cliente provvisorio dopo che la sorgente ha
 * ricondotto l'acquirente all'anagrafica con il codice fiscale già presente nella
 * preparazione. Il riallineamento sposta soltanto la titolarità di ordine e preparazione:
 * fotografia del destinatario, correzioni manuali e bozza restano invariate.
 */
export async function realignOpenCaseCustomerOwnership(client: pg.PoolClient, requestId: string) {
  // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk -- I frammenti interpolati sono costanti SQL interne senza input esterno.
  const realigned = await client.query<{
    billing_case_id: string;
    order_id: string;
    previous_customer_id: string;
    customer_id: string;
  }>(
    `WITH drift AS (
       SELECT billing_cases.id AS billing_case_id, orders.id AS order_id,
              billing_cases.customer_id AS previous_customer_id,
              source_customer.id AS customer_id
       FROM billing_cases
       JOIN orders ON orders.billing_case_id = billing_cases.id
         AND orders.customer_id = billing_cases.customer_id
       JOIN customers AS previous_customer ON previous_customer.id = billing_cases.customer_id
       JOIN customer_source_records AS source_record
         ON source_record.provider = orders.provider
        AND source_record.external_customer_id =
          orders.normalized_snapshot_json ->> 'externalCustomerId'
       JOIN customers AS source_customer ON source_customer.id = source_record.customer_id
       WHERE ${openBillingCaseSql("billing_cases")}
         AND source_customer.id <> billing_cases.customer_id
         AND previous_customer.tax_id_normalized IS NULL
         AND source_customer.tax_id_normalized IS NOT NULL
         AND billing_cases.customer_snapshot_json -> 'taxIdentifiers' @> jsonb_build_array(
           jsonb_build_object(
             'type', source_customer.tax_id_type,
             'value', source_customer.tax_id_normalized))
         AND (SELECT count(*) FROM orders AS case_orders
              WHERE case_orders.billing_case_id = billing_cases.id) = 1
         AND NOT EXISTS (
           SELECT 1 FROM billing_cases AS other
           WHERE other.id <> billing_cases.id AND other.customer_id = source_customer.id
             AND other.local_order_date = billing_cases.local_order_date
             AND other.currency = billing_cases.currency
             AND ${openBillingCaseSql("other")}
         )
     ), moved_cases AS (
       UPDATE billing_cases
       SET customer_id = drift.customer_id, revision = revision + 1, updated_at = now()
       FROM drift WHERE billing_cases.id = drift.billing_case_id
       RETURNING billing_cases.id
     ), moved_orders AS (
       UPDATE orders SET customer_id = drift.customer_id
       FROM drift WHERE orders.id = drift.order_id
       RETURNING orders.id
     )
     SELECT drift.billing_case_id::text, drift.order_id::text,
            drift.previous_customer_id::text, drift.customer_id::text
     FROM drift
     ORDER BY drift.billing_case_id`,
  );
  for (const row of realigned.rows) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Ogni riallineamento conserva il proprio audit nella stessa transazione.
    await writeAudit(client, {
      actorType: "SYSTEM",
      action: "CUSTOMER_CORRECTED",
      eventClass: "CRITICAL",
      entityType: "BILLING_CASE",
      entityId: row.billing_case_id,
      metadata: {
        billingCaseId: row.billing_case_id,
        automaticAlignment: "CUSTOMER_OWNERSHIP",
      },
      before: { customerId: row.previous_customer_id, orderId: row.order_id },
      after: { customerId: row.customer_id },
      reason: "Preparazione ricollegata all’anagrafica con il codice fiscale già confermato",
      requestId,
    });
  }
  await deleteOrphanedCustomers(
    client,
    realigned.rows.map((row) => row.previous_customer_id),
  );
  return realigned.rows.length;
}
