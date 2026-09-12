import type pg from "pg";

import {
  ARUBA_SPLIT_INVOICE_WINDOW_DAYS,
  hasSplitInvoiceMarker,
  normalizedMatchText,
  recipientNameMatchKeys,
  selectSplitInvoiceMatches,
  type SplitInvoicePart,
} from "../aruba-inbound.ts";
import {
  arubaOrderCandidateFromSource,
  type ArubaOrderCandidateSource,
} from "../aruba-order-candidate.ts";
import { acceptedInvoiceFromXml } from "../documents.ts";
import { AppError } from "../errors.ts";
import {
  latestObservedRemote,
  loadLatestOfficialXml,
  materializeSplitInvoice,
  officialEvidence,
} from "./aruba-document-materialization.server.ts";
import { writeAudit } from "./audit.server.ts";
import { effectiveApprovedInvoiceSql } from "./billing-case-sql.server.ts";
import { recomputeBillingCaseStatus } from "./billing-case-status.server.ts";

async function splitInvoiceOrders(client: pg.PoolClient) {
  // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk -- Il predicato interpolato è una costante SQL interna senza input esterno.
  const result = await client.query<ArubaOrderCandidateSource & { billing_case_id: string }>(
    `SELECT orders.id::text, orders.provider, orders.display_number,
            orders.local_order_date::text, orders.billing_case_id::text,
            (orders.gross_amount - orders.deducted_shopify_payments_fee_amount)::integer
              AS billable_amount,
            billing_cases.customer_snapshot_json ->> 'displayName' AS recipient_name,
            coalesce(billing_cases.customer_snapshot_json -> 'taxIdentifiers', '[]')
              AS recipient_tax_identifiers,
            billing_cases.customer_snapshot_json #>> '{billingAddress,countryCode}'
              AS recipient_country_code,
            billing_cases.customer_snapshot_json #>> '{billingAddress,city}' AS recipient_city,
            concat_ws(' ',
              billing_cases.customer_snapshot_json #>> '{billingAddress,line1}',
              billing_cases.customer_snapshot_json #>> '{billingAddress,postalCode}',
              billing_cases.customer_snapshot_json #>> '{billingAddress,city}',
              billing_cases.customer_snapshot_json #>> '{billingAddress,countryCode}'
            ) AS recipient_address
     FROM billing_cases
     JOIN orders ON orders.billing_case_id = billing_cases.id
     WHERE billing_cases.status IN ('DRAFT', 'READY', 'NEEDS_REVIEW')
       AND (SELECT count(*) FROM orders AS case_orders
            WHERE case_orders.billing_case_id = billing_cases.id) = 1
       AND orders.cancelled_at IS NULL AND orders.payment_status <> 'REFUNDED'
       AND orders.trigger_status NOT IN (
         'INVOICED', 'CANCELLED_NO_DOCUMENT', 'REFUNDED_BEFORE_ISSUE'
       )
       AND NOT EXISTS (SELECT 1 FROM refunds WHERE refunds.order_id = orders.id)
       AND NOT EXISTS (
         SELECT 1 FROM document_orders
         JOIN documents ON documents.id = document_orders.document_id
         WHERE document_orders.order_id = orders.id
           AND document_orders.document_kind = 'INVOICE'
           AND ${effectiveApprovedInvoiceSql("documents")}
       )
     ORDER BY orders.id`,
  );
  return result.rows;
}

async function splitInvoiceParts(
  client: pg.PoolClient,
  environment: string,
  accountReference: string,
  orders: ReturnType<typeof arubaOrderCandidateFromSource>[],
) {
  if (!orders.length) return [];
  const names = new Set<string>();
  const taxIds = new Set<string>();
  for (const order of orders) {
    for (const key of recipientNameMatchKeys(order.recipientName)) names.add(key);
    for (const identifier of order.recipientTaxIdentifiers) {
      const value = normalizedMatchText(identifier.value);
      if (value) taxIds.add(value);
    }
  }
  const dates = orders.map((order) => order.localOrderDate).toSorted();
  const remotes = await client.query<{ id: string; has_xml: boolean }>(
    `SELECT remote.id::text,
            EXISTS (SELECT 1 FROM aruba_files AS files
              WHERE files.remote_document_id = remote.id AND files.kind = 'ARUBA_XML') AS has_xml
     FROM aruba_remote_documents AS remote
     JOIN aruba_document_matches AS matches ON matches.remote_document_id = remote.id
     WHERE remote.environment = $1 AND remote.account_reference = $2
       AND remote.document_type = 'TD01'
       AND remote.remote_status IN ('DELIVERED', 'NOT_DELIVERED')
       AND remote.document_date BETWEEN $3::date AND $4::date + $5::integer
       AND (remote.recipient_name_normalized = ANY($6::text[])
         OR remote.recipient_tax_id_normalized = ANY($7::text[]))
       AND matches.status = 'UNMATCHED' AND matches.method = 'NONE'
       AND matches.order_id IS NULL AND matches.document_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(matches.candidates_json) AS candidate
         WHERE coalesce((candidate ->> 'compatible')::boolean, false)
            OR coalesce((candidate ->> 'reviewable')::boolean, false)
       )
       AND NOT EXISTS (
         SELECT 1 FROM aruba_deduplication_conflicts AS conflicts
         WHERE conflicts.environment = remote.environment
           AND conflicts.account_reference = remote.account_reference
           AND (conflicts.existing_remote_document_id = remote.id
             OR conflicts.incoming_remote_id = remote.remote_id)
           AND (conflicts.resolved_at IS NULL
             OR conflicts.resolution_json ->> 'excludedId' = remote.id::text)
       )
     ORDER BY remote.document_date, remote.id`,
    [
      environment,
      accountReference,
      dates[0],
      dates.at(-1),
      ARUBA_SPLIT_INVOICE_WINDOW_DAYS,
      [...names],
      [...taxIds],
    ],
  );
  const importedAt = new Date().toISOString();
  const parts: SplitInvoicePart[] = [];
  for (const remote of remotes.rows) {
    try {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Le evidenze vengono lette sotto il lock inventario del run.
      const observed = await latestObservedRemote(client, remote.id);
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Ogni rata usa il proprio file ufficiale verificato.
      const official = remote.has_xml ? await loadLatestOfficialXml(client, remote.id) : null;
      parts.push({
        remoteDocumentId: remote.id,
        document: official
          ? officialEvidence(observed, official.xml)
          : { ...observed, xmlSha256: null },
        splitMarker: official
          ? hasSplitInvoiceMarker(
              acceptedInvoiceFromXml(official.xml, importedAt).input.lines.map(
                (line) => line.description,
              ),
            )
          : false,
      });
    } catch (error) {
      // Un'evidenza non verificabile esclude soltanto quel documento dalle combinazioni.
      if (!(error instanceof AppError) && !(error instanceof Error)) throw error;
    }
  }
  return parts;
}

/**
 * Ricalcola le combinazioni acconto/saldo delle preparazioni aperte. Una combinazione
 * completa viene archiviata automaticamente; una ancora priva di XML trattiene la
 * preparazione e resta nella coda del recupero mirato. Un conflitto fiscale annulla solo
 * la combinazione interessata e non interrompe il run Aruba.
 */
export async function reconcileArubaSplitInvoices(
  client: pg.PoolClient,
  environment: string,
  accountReference: string,
) {
  const previous = await client.query<{ billing_case_id: string }>(
    `SELECT billing_case_id::text FROM aruba_split_invoice_candidates
     WHERE environment = $1 AND account_reference = $2`,
    [environment, accountReference],
  );
  const sources = await splitInvoiceOrders(client);
  const orders = sources.map((source) => arubaOrderCandidateFromSource(source));
  const parts = await splitInvoiceParts(client, environment, accountReference, orders);
  const casesByOrder = new Map(sources.map((source) => [source.id, source.billing_case_id]));
  const pendingCaseIds: string[] = [];
  let materialized = 0;
  for (const selection of selectSplitInvoiceMatches(orders, parts)) {
    const billingCaseId = casesByOrder.get(selection.orderId)!;
    if (!selection.complete) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- La coda resta coerente con le selezioni del run corrente.
      await client.query(
        `INSERT INTO aruba_split_invoice_candidates
          (billing_case_id, environment, account_reference, order_id, remote_document_ids)
         VALUES ($1, $2, $3, $4, $5::bigint[])
         ON CONFLICT (billing_case_id) DO UPDATE SET
           first_detected_at = CASE
             WHEN aruba_split_invoice_candidates.order_id = EXCLUDED.order_id
               AND aruba_split_invoice_candidates.remote_document_ids =
                 EXCLUDED.remote_document_ids
               THEN aruba_split_invoice_candidates.first_detected_at
             ELSE now()
           END,
           order_id = EXCLUDED.order_id,
           remote_document_ids = EXCLUDED.remote_document_ids,
           last_detected_at = now()`,
        [
          billingCaseId,
          environment,
          accountReference,
          selection.orderId,
          selection.remoteDocumentIds,
        ],
      );
      pendingCaseIds.push(billingCaseId);
      continue;
    }
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Ogni combinazione è isolata dal proprio savepoint.
    await client.query("SAVEPOINT aruba_split_invoice");
    try {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Le rate vengono archiviate in serie sotto lo stesso lock.
      const result = await materializeSplitInvoice(client, selection);
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- L'audit appartiene alla stessa combinazione.
      await writeAudit(client, {
        actorType: "SYSTEM",
        action: "ARUBA_SPLIT_INVOICE_MATCHED",
        eventClass: "CRITICAL",
        entityType: "BILLING_CASE",
        entityId: result.sourceCaseId,
        metadata: {
          billingCaseId: result.sourceCaseId,
          documentCount: result.documentIds.length,
        },
        before: {
          billingCaseStatus: "OPEN",
          orderId: selection.orderId,
          remoteDocumentIds: selection.remoteDocumentIds,
        },
        after: { billingCaseStatus: "CLOSED", documentIds: result.documentIds },
        reason:
          "Acconto e saldo Aruba verificati su XML ufficiali, destinatario e totale dell’ordine",
        requestId: `aruba-split-invoice:${selection.orderId}`,
      });
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Il savepoint si chiude dopo l'intera combinazione.
      await client.query("RELEASE SAVEPOINT aruba_split_invoice");
      materialized += 1;
    } catch (error) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Il rollback riguarda soltanto la combinazione fallita.
      await client.query("ROLLBACK TO SAVEPOINT aruba_split_invoice");
      if (!(error instanceof AppError)) throw error;
    }
  }
  await client.query(
    `DELETE FROM aruba_split_invoice_candidates AS candidates
     WHERE candidates.environment = $1 AND candidates.account_reference = $2
       AND NOT (candidates.billing_case_id = ANY($3::bigint[]))
       AND NOT EXISTS (
         SELECT 1 FROM aruba_document_matches AS held
         WHERE held.remote_document_id = ANY(candidates.remote_document_ids)
           AND held.status = 'UNKNOWN_REMOTE_STATE'
           AND held.signals_json @> '{"providerIdentityCollision":true}'
       )`,
    [environment, accountReference, pendingCaseIds],
  );
  for (const caseId of new Set([
    ...previous.rows.map((row) => row.billing_case_id),
    ...pendingCaseIds,
  ])) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Lo stato dipende dalla coda appena aggiornata.
    await recomputeBillingCaseStatus(client, caseId, true);
  }
  return { materialized, pending: pendingCaseIds.length };
}
