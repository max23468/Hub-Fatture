import { createHash } from "node:crypto";
import path from "node:path";

import type pg from "pg";
import { z } from "zod";

import { validateUntrustedXml } from "../aruba.ts";
import { acceptedInvoiceFromXml, fiscalProfileSchema } from "../documents.ts";
import { AppError } from "../errors.ts";
import { validateFatturaXml } from "../fatturapa.server.ts";
import {
  attributedInvoiceAmount,
  expectedHistoricalInvoiceAmount,
  fiscalContract,
  hasBareOrderReference,
  hasConflictingMarketplaceReference,
  hasOrderReference,
  historicalDocumentDateAllowed,
  matchesHistoricalRecipient,
  referenceIdentifiesInvoice,
  taxIdentifierKey,
  type HistoricalInvoiceCandidate,
  type ImportedHistoricalInvoice,
} from "../historical-order-reconciliation.ts";
import { draftTriggerSchema, triggerStatus, type OrderInput } from "../orders.ts";
import { preIssueRefund } from "../refunds.ts";
import { writeAudit } from "./audit.server.ts";
import { withTransaction } from "./client.server.ts";
import { isDatabaseId } from "./database-id.ts";
import { archiveImportedInvoiceXml } from "./document-storage.server.ts";
import type { OrderActor as Actor } from "./order-actor.server.ts";
import { groupOrder } from "./order-grouping.server.ts";
import { reconcilePreIssueInvoiceAmount } from "./order-draft-reconciliation.server.ts";
import { serializeOrderMutations } from "./order-mutation-lock.server.ts";
import { pendingPaymentSql } from "./billing-case-sql.server.ts";

const historicalReconciliationSchema = z.object({
  outcome: z.enum(["ALREADY_INVOICED", "NOT_INVOICED"]),
  reference: z.string().trim().min(1).max(500),
  manualReviewApproved: z.boolean().default(false),
});

async function uniquelyMatchesUnreferencedMarketplaceInvoice(
  client: pg.PoolClient,
  currentId: string,
  invoice: ImportedHistoricalInvoice,
  invoiceTaxIdentifiers: Set<string>,
  manualReviewApproved = false,
) {
  const candidates = await client.query<HistoricalInvoiceCandidate>(
    `SELECT orders.id, orders.provider,
            orders.normalized_snapshot_json -> 'customerSnapshot' AS customer_snapshot,
            orders.local_order_date::text, orders.gross_amount, orders.billable_amount,
            coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                'type', order_tax_identifiers.type,
                'value', order_tax_identifiers.normalized_value,
                'countryCode', order_tax_identifiers.country_code
              ))
              FROM order_tax_identifiers WHERE order_tax_identifiers.order_id = orders.id
            ), '[]'::jsonb) AS tax_identifiers,
            coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                'status', refunds.status, 'amount', refunds.amount,
                'completed_date', (refunds.completed_at AT TIME ZONE 'Europe/Rome')::date::text
              )) FROM refunds WHERE refunds.order_id = orders.id
            ), '[]'::jsonb) AS refunds
     FROM orders
     WHERE coalesce((orders.normalized_snapshot_json ->> 'historical')::boolean, false)
       AND (
         orders.id = $1
         OR (orders.trigger_status = 'LEGACY_BILLING_REVIEW'
           AND orders.historical_reconciliation_outcome IS NULL
           AND orders.historical_reconciled_at IS NULL)
         OR (orders.historical_reconciliation_outcome = 'ALREADY_INVOICED'
           AND NOT EXISTS (
             SELECT 1 FROM document_orders
             JOIN documents ON documents.id = document_orders.document_id
             WHERE document_orders.order_id = orders.id
               AND document_orders.document_kind = 'INVOICE'
               AND documents.origin = 'ARUBA_HISTORY'
           ))
       )
     FOR UPDATE OF orders`,
    [currentId],
  );
  const matches = candidates.rows.filter(
    (candidate) =>
      !hasConflictingMarketplaceReference(invoice.references, candidate.provider) &&
      historicalDocumentDateAllowed(candidate.local_order_date, invoice.documentDate) &&
      expectedHistoricalInvoiceAmount(candidate, invoice.documentDate) === invoice.totalAmount &&
      matchesHistoricalRecipient(candidate, invoice, invoiceTaxIdentifiers, manualReviewApproved),
  );
  return matches.length === 1 && matches[0]!.id === currentId;
}

export async function reconcileHistoricalOrder(
  id: string,
  raw: {
    outcome: unknown;
    reference: unknown;
    invoiceXml?: Buffer;
    manualReviewApproved?: unknown;
  },
  actor: Actor & { canApprove: boolean },
) {
  if (!actor.canApprove) throw new AppError("ORDER_HISTORY_RECONCILIATION_FORBIDDEN", 403);
  if (!isDatabaseId(id)) return null;
  const parsed = historicalReconciliationSchema.safeParse(raw);
  if (!parsed.success || actor.id === undefined) throw new AppError("ORDER_INVALID_INPUT", 422);
  let importedInvoice: ReturnType<typeof acceptedInvoiceFromXml> | null = null;
  let importedTaxIdentifiers = new Set<string>();
  let invoicePath: string | null = null;
  if (parsed.data.outcome === "ALREADY_INVOICED") {
    if (!raw.invoiceXml?.byteLength) {
      throw new AppError("ORDER_HISTORY_INVOICE_REQUIRED", 422);
    }
    try {
      const xml = validateUntrustedXml(raw.invoiceXml);
      await validateFatturaXml(xml);
      importedInvoice = acceptedInvoiceFromXml(xml, new Date().toISOString());
      importedTaxIdentifiers = new Set(
        importedInvoice.input.recipient.taxIdentifiers.map(taxIdentifierKey),
      );
      const digest = createHash("sha256").update(xml).digest("hex");
      invoicePath = path.posix.join(
        "invoices",
        "history",
        String(importedInvoice.year),
        `${importedInvoice.documentNumber.replaceAll(" ", "-").replaceAll("/", "-")}-${digest}.xml`,
      );
    } catch (error) {
      if (error instanceof AppError && error.code === "DOCUMENT_STORAGE_FAILED") throw error;
      throw new AppError("ORDER_HISTORY_INVOICE_INVALID", 422);
    }
  }
  return withTransaction(async (client) => {
    let archivedInvoice: Awaited<ReturnType<typeof archiveImportedInvoiceXml>> | null = null;
    try {
      if (importedInvoice && invoicePath) {
        archivedInvoice = await archiveImportedInvoiceXml(client, invoicePath, importedInvoice.xml);
      }
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('setting:draft_trigger'))");
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtext('setting:shopify_payment_fee_mode'))",
      );
      await serializeOrderMutations(client);
      // Il frammento interpolato è una costante interna che riceve soltanto l'alias SQL fisso.
      // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk
      const order = await client.query<{
        id: string;
        customer_id: string;
        customer_snapshot: Record<string, unknown>;
        local_order_date: string;
        currency: string;
        payment_status: OrderInput["paymentStatus"];
        provider: "SHOPIFY" | "EBAY";
        display_number: string;
        fulfillment_status: OrderInput["fulfillmentStatus"];
        cancelled_at: string | null;
        trigger_status: string;
        historical: boolean;
        historical_reconciled_at: Date | null;
        historical_reconciliation_outcome: "ALREADY_INVOICED" | "NOT_INVOICED" | null;
        historical_invoice_id: string | null;
        gross_amount: number;
        billable_amount: number;
        tax_identifiers: Array<{
          type: string;
          value: string;
          countryCode: string | null;
        }>;
        refunds: Array<{
          id: string;
          status: string;
          amount: number | null;
          completed_date: string | null;
        }>;
      }>(
        `SELECT orders.id, orders.customer_id, orders.provider, orders.display_number,
              orders.normalized_snapshot_json -> 'customerSnapshot' AS customer_snapshot,
              orders.local_order_date::text, orders.currency, CASE
                WHEN ${pendingPaymentSql("orders")} THEN 'PENDING'
                WHEN orders.payment_status = 'REFUNDED' THEN 'REFUNDED'
                ELSE 'PAID'
              END AS payment_status,
              orders.fulfillment_status, orders.cancelled_at, orders.trigger_status,
              coalesce((orders.normalized_snapshot_json ->> 'historical')::boolean, false)
                AS historical,
              orders.historical_reconciled_at, orders.gross_amount, orders.billable_amount,
              orders.historical_reconciliation_outcome,
              (SELECT document_orders.document_id::text
               FROM document_orders JOIN documents ON documents.id = document_orders.document_id
               WHERE document_orders.order_id = orders.id
                 AND document_orders.document_kind = 'INVOICE'
                 AND documents.origin = 'ARUBA_HISTORY' LIMIT 1) AS historical_invoice_id,
              coalesce((
                SELECT jsonb_agg(jsonb_build_object(
                  'type', order_tax_identifiers.type,
                  'value', order_tax_identifiers.normalized_value,
                  'countryCode', order_tax_identifiers.country_code
                ))
                FROM order_tax_identifiers WHERE order_tax_identifiers.order_id = orders.id
              ), '[]'::jsonb) AS tax_identifiers,
              coalesce((
                SELECT jsonb_agg(jsonb_build_object(
                  'id', refunds.id::text, 'status', refunds.status, 'amount', refunds.amount,
                  'completed_date',
                    (refunds.completed_at AT TIME ZONE 'Europe/Rome')::date::text
                )) FROM refunds WHERE refunds.order_id = orders.id
              ), '[]'::jsonb) AS refunds
       FROM orders WHERE orders.id = $1 FOR UPDATE`,
        [id],
      );
      const current = order.rows[0];
      if (!current) {
        await archivedInvoice?.cleanupIfUnreferenced();
        return null;
      }
      const attachingInvoice =
        current.historical_reconciliation_outcome === "ALREADY_INVOICED" &&
        parsed.data.outcome === "ALREADY_INVOICED" &&
        !current.historical_invoice_id;
      if (!current.historical || (!attachingInvoice && current.historical_reconciled_at)) {
        throw new AppError("CONFLICT_REVISION", 409);
      }
      if (!attachingInvoice && current.trigger_status !== "LEGACY_BILLING_REVIEW") {
        throw new AppError("CONFLICT_REVISION", 409);
      }
      const trigger = await client.query<{ value_json: unknown }>(
        "SELECT value_json FROM settings WHERE key = 'draft_trigger' FOR SHARE",
      );
      const refundEffect = preIssueRefund(
        current.gross_amount,
        current.refunds,
        current.billable_amount,
      );
      const hasExplicitHistoricalOrderReference = importedInvoice
        ? hasOrderReference(importedInvoice.references, current.provider, current.display_number) ||
          hasBareOrderReference(importedInvoice.references, current.display_number)
        : false;
      const usesUnreferencedMarketplaceFallback = Boolean(
        importedInvoice &&
        !hasExplicitHistoricalOrderReference &&
        !hasConflictingMarketplaceReference(importedInvoice.references, current.provider),
      );
      const usesApprovedManualReview = Boolean(
        importedInvoice &&
        parsed.data.manualReviewApproved &&
        usesUnreferencedMarketplaceFallback &&
        referenceIdentifiesInvoice(parsed.data.reference, importedInvoice.documentNumber),
      );
      const historicalInvoiceAmount = importedInvoice
        ? hasExplicitHistoricalOrderReference
          ? attributedInvoiceAmount(importedInvoice, current.provider, current.display_number)
          : usesUnreferencedMarketplaceFallback
            ? importedInvoice.totalAmount
            : null
        : null;
      const historicalInvoiceDate = importedInvoice?.documentDate;
      const completedHistoricalRefunds = current.refunds.filter(
        (refund) => refund.status === "COMPLETED",
      );
      const preIssueHistoricalRefunds = completedHistoricalRefunds.filter(
        (refund) => refund.completed_date! < historicalInvoiceDate!,
      );
      const historicalRefundsNeedReview = current.refunds.some(
        (refund) =>
          refund.status === "AMBIGUOUS" ||
          (refund.status === "COMPLETED" &&
            (refund.amount === null ||
              !refund.completed_date ||
              refund.completed_date === historicalInvoiceDate)),
      );
      const expectedHistoricalInvoiceTotal =
        current.billable_amount -
        preIssueHistoricalRefunds.reduce((sum, refund) => sum + refund.amount!, 0);
      if (
        parsed.data.outcome === "ALREADY_INVOICED" &&
        (historicalRefundsNeedReview ||
          expectedHistoricalInvoiceTotal < 0 ||
          historicalInvoiceAmount !== expectedHistoricalInvoiceTotal)
      ) {
        throw new AppError("ORDER_HISTORY_INVOICE_INVALID", 422);
      }
      const nextStatus =
        parsed.data.outcome === "ALREADY_INVOICED"
          ? "INVOICED"
          : refundEffect.state === "TOTAL"
            ? "REFUNDED_BEFORE_ISSUE"
            : triggerStatus(
                {
                  cancelledAt: current.cancelled_at,
                  paymentStatus: current.payment_status,
                  fulfillmentStatus: current.fulfillment_status,
                  historical: false,
                },
                draftTriggerSchema.parse(trigger.rows[0]?.value_json ?? "PAID"),
              );
      let invoiceDocumentId: string | null = null;
      if (parsed.data.outcome === "ALREADY_INVOICED") {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('fiscal-profile'))");
        const activeProfile = await client.query<{
          version: number;
          profile_json: unknown;
        }>("SELECT version, profile_json FROM fiscal_profiles WHERE status IN ('MOCK', 'AUDITED')");
        const profile = fiscalProfileSchema.safeParse(activeProfile.rows[0]?.profile_json);
        const unreferencedMarketplaceMatch =
          importedInvoice && usesUnreferencedMarketplaceFallback
            ? await uniquelyMatchesUnreferencedMarketplaceInvoice(
                client,
                current.id,
                importedInvoice,
                importedTaxIdentifiers,
                usesApprovedManualReview,
              )
            : false;
        if (
          !profile.success ||
          !importedInvoice ||
          !archivedInvoice ||
          !invoicePath ||
          !historicalDocumentDateAllowed(current.local_order_date, importedInvoice.documentDate) ||
          (!hasExplicitHistoricalOrderReference && !unreferencedMarketplaceMatch) ||
          !matchesHistoricalRecipient(
            current,
            importedInvoice,
            importedTaxIdentifiers,
            usesApprovedManualReview,
          ) ||
          JSON.stringify(fiscalContract(profile.data)) !==
            JSON.stringify(fiscalContract(importedInvoice.profile))
        ) {
          throw new AppError("ORDER_HISTORY_INVOICE_INVALID", 422);
        }
        const existing = await client.query<{
          id: string;
          origin: string;
          xml_sha256: string;
        }>(
          `SELECT id, origin, xml_sha256 FROM documents
         WHERE series = 'FPR' AND fiscal_year = $1 AND fiscal_number = $2
         ORDER BY (xml_sha256 = $3) DESC
         FOR UPDATE`,
          [importedInvoice.year, importedInvoice.number, archivedInvoice.sha256],
        );
        const previous = existing.rows[0];
        if (
          previous &&
          (previous.origin !== "ARUBA_HISTORY" || previous.xml_sha256 !== archivedInvoice.sha256)
        ) {
          throw new AppError("ORDER_HISTORY_INVOICE_INVALID", 422);
        }
        if (previous && usesUnreferencedMarketplaceFallback) {
          const linkedOrders = await client.query(
            `SELECT order_id FROM document_orders
             WHERE document_id = $1 AND document_kind = 'INVOICE'
             FOR UPDATE`,
            [previous.id],
          );
          if (linkedOrders.rowCount) {
            throw new AppError("ORDER_HISTORY_INVOICE_INVALID", 422);
          }
        }
        invoiceDocumentId = previous?.id ?? null;
        if (!invoiceDocumentId) {
          const billingCase = await client.query<{ id: string }>(
            `INSERT INTO billing_cases
            (customer_id, local_order_date, currency, status, customer_snapshot_json,
             fiscal_profile_version)
           VALUES ($1, $2, 'EUR', 'CLOSED', $3, $4) RETURNING id`,
            [
              current.customer_id,
              importedInvoice.documentDate,
              JSON.stringify(current.customer_snapshot),
              activeProfile.rows[0]!.version,
            ],
          );
          const storage = await client.query<{ id: string }>(
            `INSERT INTO storage_objects
            (kind, relative_path, sha256, size_bytes, content_type)
           VALUES ('INVOICE_XML', $1, $2, $3, 'application/xml')
           ON CONFLICT (relative_path) DO UPDATE SET relative_path = EXCLUDED.relative_path
           RETURNING id`,
            [invoicePath, archivedInvoice.sha256, archivedInvoice.sizeBytes],
          );
          const snapshot = {
            generatorVersion: 2,
            ...importedInvoice.input,
            sourceTotal: importedInvoice.totalAmount,
            total: importedInvoice.totalAmount,
            difference: 0,
            differenceReason: null,
          };
          const document = await client.query<{ id: string }>(
            `INSERT INTO documents
            (billing_case_id, kind, status, document_type, series, fiscal_year,
             fiscal_number, document_date, fiscal_profile_version, currency, total_amount,
             source_total_amount, difference_amount, projection_sha256, approved_at,
             xml_sha256, immutable_snapshot_json, fiscal_profile_snapshot_json,
             storage_object_id, payment_status, payment_method, recipient_snapshot_json, origin)
           VALUES ($1, 'INVOICE', 'APPROVED', 'TD01', 'FPR', $2, $3, $4, $5, 'EUR',
             $6, $6, 0, $7, now(), $7, $8, $9, $10, 'PAID', $11, $12, 'ARUBA_HISTORY')
           RETURNING id`,
            [
              billingCase.rows[0]!.id,
              importedInvoice.year,
              importedInvoice.number,
              importedInvoice.documentDate,
              activeProfile.rows[0]!.version,
              importedInvoice.totalAmount,
              archivedInvoice.sha256,
              JSON.stringify(snapshot),
              JSON.stringify(importedInvoice.profile),
              storage.rows[0]!.id,
              importedInvoice.input.paymentMethod,
              JSON.stringify(importedInvoice.input.recipient),
            ],
          );
          invoiceDocumentId = document.rows[0]!.id;
        }
        await client.query(
          `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
         VALUES ($1, 'INVOICE', $2, $3)`,
          [invoiceDocumentId, id, historicalInvoiceAmount],
        );
      }
      await client.query(
        `UPDATE orders SET trigger_status = $2, historical_reconciliation_outcome = $3,
         historical_reconciliation_reference = $4,
         historical_reconciled_at = coalesce(historical_reconciled_at, now())
       WHERE id = $1`,
        [id, nextStatus, parsed.data.outcome, parsed.data.reference],
      );
      if (parsed.data.outcome === "ALREADY_INVOICED") {
        await client.query(
          `UPDATE refunds
           SET applied_before_issue = (id::text = ANY($2::text[])), updated_at = now()
           WHERE order_id = $1 AND status = 'COMPLETED'`,
          [id, preIssueHistoricalRefunds.map((refund) => refund.id)],
        );
        await client.query(
          `INSERT INTO jobs (type, payload_json)
         SELECT 'process_refund', jsonb_build_object('refundId', refunds.id::text)
         FROM refunds WHERE refunds.order_id = $1
           AND refunds.status IN ('COMPLETED', 'AMBIGUOUS')
           AND NOT refunds.applied_before_issue AND refunds.credit_document_id IS NULL
         ON CONFLICT DO NOTHING`,
          [id],
        );
      }
      await writeAudit(client, {
        actorType: actor.type ?? "ADMIN",
        actorId: String(actor.id),
        action: "ORDER_HISTORY_RECONCILED",
        eventClass: "CRITICAL",
        entityType: "ORDER",
        entityId: id,
        after: {
          outcome: parsed.data.outcome,
          reference: parsed.data.reference,
          invoiceDocumentId,
          manualReviewApproved: usesApprovedManualReview,
        },
        requestId: actor.requestId,
      });
      const caseId =
        nextStatus === "ELIGIBLE" || nextStatus === "REFUNDED_BEFORE_ISSUE"
          ? await groupOrder(
              client,
              {
                id: current.id,
                customerId: current.customer_id,
                customerSnapshot: current.customer_snapshot,
                localOrderDate: current.local_order_date,
                currency: current.currency,
                isolated: nextStatus === "REFUNDED_BEFORE_ISSUE",
              },
              actor,
            )
          : null;
      if (caseId && nextStatus === "REFUNDED_BEFORE_ISSUE") {
        await client.query("UPDATE orders SET trigger_status = $2 WHERE id = $1", [id, nextStatus]);
      }
      if (caseId && nextStatus === "ELIGIBLE" && refundEffect.state === "PARTIAL") {
        await reconcilePreIssueInvoiceAmount(client, id, caseId, refundEffect.billableAmount);
      }
      return { caseId, outcome: parsed.data.outcome, invoiceDocumentId };
    } catch (error) {
      await archivedInvoice?.cleanupIfUnreferenced();
      throw error;
    }
  });
}
