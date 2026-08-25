import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type pg from "pg";

import { writeAudit } from "./audit.server.ts";
import { recomputeBillingCaseStatus } from "./billing-case-status.server.ts";
import {
  openBillingCaseSql,
  orderBillableSql,
  pendingPaymentSql,
} from "./billing-case-sql.server.ts";
import { withTransaction } from "./client.server.ts";
import {
  assertJobLease,
  completeHistoryImportInTransaction,
  lockHistoryImportConnection,
  renewLockedJobLease,
  type ClaimedJob,
  type HistoryImportResult,
  type Provider,
} from "./connectors.server.ts";
import { AppError } from "../errors.ts";
import {
  documentInputSchema,
  fiscalProfileSchema,
  projectFatturaXml,
  recipientFromCustomerSnapshot,
  type DocumentInput,
  type FiscalProfile,
} from "../documents.ts";
import { validateFatturaXml } from "../fatturapa.server.ts";
import {
  canonicalCustomerProfile,
  canonicalTaxIdentifiers,
  customerIdentity,
  customerDisplayName,
  decimalToCents,
  draftTriggerSchema,
  effectiveOrderPaymentStatus,
  localOrderDate,
  orderInputSchema,
  orderReviewRequired,
  presentationCustomer,
  shopifyPaymentFeeModeSchema,
  triggerStatus,
  type CustomerContext,
  type DraftTrigger,
  type OrderInput,
  type ShopifyPaymentFeeMode,
} from "../orders.ts";
import { preIssueRefund } from "../refunds.ts";
import { serializeOrderMutations } from "./order-mutation-lock.server.ts";
import { refreshCreditNoteDraft } from "./refunds.server.ts";

export interface Actor {
  id?: number;
  type?: "ADMIN" | "SYSTEM";
  requestId: string;
}

function auditActor(actor: Actor) {
  return {
    actorType: actor.type ?? ("ADMIN" as const),
    actorId: actor.id === undefined ? null : String(actor.id),
  };
}

interface GroupableOrder {
  id: string;
  customerId: string;
  customerSnapshot: Record<string, unknown>;
  localOrderDate: string;
  currency: string;
  isolated?: boolean;
}

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

async function refreshInvoiceDraftProjection(client: pg.PoolClient, caseId: string) {
  const result = await client.query<{
    id: string;
    document_date: string;
    recipient_snapshot_json: DocumentInput["recipient"];
    payment_status: string;
    payment_method: string;
    causale: string | null;
    notes: string | null;
    profile_json: FiscalProfile;
    lines: DocumentInput["lines"];
  }>(
    `SELECT documents.id,
            (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Rome')::date::text AS document_date,
            documents.recipient_snapshot_json, documents.payment_status,
            documents.payment_method, documents.causale, documents.notes,
            fiscal_profiles.profile_json,
            coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                'orderId', document_lines.order_id::text,
                'description', document_lines.description,
                'quantity', document_lines.quantity,
                'unitAmount', document_lines.unit_amount
              ) ORDER BY document_lines.line_number)
              FROM document_lines WHERE document_lines.document_id = documents.id
            ), '[]') AS lines
     FROM documents
     JOIN fiscal_profiles ON fiscal_profiles.version = documents.fiscal_profile_version
     WHERE documents.billing_case_id = $1
       AND documents.kind = 'INVOICE' AND documents.status = 'DRAFT'`,
    [caseId],
  );
  const row = result.rows[0];
  if (!row) return;
  const profile = fiscalProfileSchema.safeParse(row.profile_json);
  const input = documentInputSchema.safeParse({
    kind: "INVOICE",
    documentDate: row.document_date,
    recipient: row.recipient_snapshot_json,
    lines: row.lines,
    paymentStatus: row.payment_status,
    paymentMethod: row.payment_method,
    causale: row.causale ?? undefined,
    notes: row.notes ?? undefined,
  });
  if (!profile.success || !input.success) throw new AppError("DOCUMENT_INVALID", 422);
  const projection = projectFatturaXml(profile.data, input.data);
  await validateFatturaXml(projection.xml);
  await client.query(
    `UPDATE documents SET document_date = $2, projection_sha256 = $3, updated_at = now()
     WHERE id = $1`,
    [row.id, row.document_date, projection.sha256],
  );
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

function customerSnapshot(input: CustomerContext, identity: ReturnType<typeof customerIdentity>) {
  const canonicalProfile = canonicalCustomerProfile(input);
  const presentation = presentationCustomer(input.customer);
  return {
    ...presentation,
    displayName: customerDisplayName(presentation) || "Cliente senza nome",
    taxIdentifiers: canonicalProfile.taxIdentifiers,
    canonicalProfile,
    sourceConfidence: identity.confidence,
    reviewRequired: identity.reviewRequired,
  };
}

function sameProviderSnapshot(previous: Record<string, unknown>, input: OrderInput) {
  return isDeepStrictEqual(previous.sourceSnapshot, input.sourceSnapshot);
}

/**
 * Un replay dello stesso payload può migliorare soltanto la sua interpretazione. Per una
 * preparazione singola ancora da verificare, riallinea cliente, destinatario e stato senza
 * trasformare la correzione del mapper in un falso conflitto della sorgente.
 */
async function reconcileMapperCustomerCorrection(
  client: pg.PoolClient,
  input: {
    caseId: string;
    orderId: string;
    oldCustomerId: string;
    newCustomerId: string;
    previousSnapshot: Record<string, unknown>;
    customerSnapshot: Record<string, unknown>;
    requestId: string;
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
    metadata: { billingCaseId: input.caseId, provider: "SHOPIFY" },
    before: previousCustomer,
    after: input.customerSnapshot,
    reason: "Rilettura dello stesso payload con il mapper Shopify corretto",
    requestId: input.requestId,
  });
  await client.query(
    `DELETE FROM customers
     WHERE id = $1
       AND NOT EXISTS (SELECT 1 FROM orders WHERE customer_id = customers.id)
       AND NOT EXISTS (SELECT 1 FROM billing_cases WHERE customer_id = customers.id)
       AND NOT EXISTS (SELECT 1 FROM customer_source_records WHERE customer_id = customers.id)`,
    [input.oldCustomerId],
  );
  await recomputeBillingCaseStatus(client, input.caseId);
  await refreshInvoiceDraftProjection(client, input.caseId);
  return true;
}

function cents(value: string): number {
  try {
    return decimalToCents(value);
  } catch {
    throw new AppError("ORDER_INVALID_INPUT", 422);
  }
}

function canonicalTimestamp(value: string | null): string | null {
  if (!value) return null;
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1]?.replace(/0+$/, "");
  const instant = new Date(value).toISOString();
  const seconds = instant.slice(0, instant.indexOf("."));
  return fraction ? `${seconds}.${fraction}Z` : `${seconds}Z`;
}

function reviewFingerprint(
  input: OrderInput,
  identityKey: string,
  totalAmount: number,
  localDate: string,
  lineAmounts: { grossAmount: number; discountAmount: number }[],
  paymentAmounts: number[],
  shopifyPaymentsFeeAmounts: number[],
  shippingAmount: number,
  refundAmounts: (number | null)[],
) {
  const lines = input.lines
    .map((line, index) => ({ ...line, ...lineAmounts[index] }))
    .sort((left, right) =>
      left.externalLineId === right.externalLineId
        ? 0
        : left.externalLineId < right.externalLineId
          ? -1
          : 1,
    );
  const payments = input.payments
    .map((payment, index) => {
      const { shopifyPaymentsFeeAmount: _, ...legacyPayment } = payment;
      const feeAmount = shopifyPaymentsFeeAmounts[index]!;
      return {
        ...legacyPayment,
        amount: paymentAmounts[index],
        ...(feeAmount > 0 ? { shopifyPaymentsFeeAmount: feeAmount } : {}),
        paidAt: canonicalTimestamp(payment.paidAt),
      };
    })
    .sort((left, right) =>
      left.externalPaymentId === right.externalPaymentId
        ? 0
        : left.externalPaymentId < right.externalPaymentId
          ? -1
          : 1,
    );
  const refunds = input.refunds
    .map((refund, index) => ({
      externalRefundId: refund.externalRefundId,
      status: refund.status,
      amount: refundAmounts[index],
      completedAt: canonicalTimestamp(refund.completedAt),
    }))
    .sort((left, right) => left.externalRefundId.localeCompare(right.externalRefundId));
  const relevant = {
    displayNumber: input.displayNumber,
    totalAmount,
    localDate,
    paymentStatus: effectiveOrderPaymentStatus(input, totalAmount),
    fulfillmentStatus: input.fulfillmentStatus,
    cancelledAt: canonicalTimestamp(input.cancelledAt),
    sourceReviewRequired: input.sourceReviewRequired,
    customerIdentity: identityKey,
    customer: canonicalCustomerProfile(input),
    lines,
    payments,
    refunds,
    shippingAmount,
  };
  return createHash("sha256").update(JSON.stringify(relevant)).digest("hex");
}

/**
 * Unico punto che decide se una preparazione modificabile è pronta o da verificare.
 * Import, correzione anagrafica, separazione ordine e riattivazione lo riusano: la regola
 * vive in un posto solo e una correzione può davvero riportare la preparazione a `READY`.
 */
export async function groupOrder(
  client: pg.PoolClient,
  order: GroupableOrder,
  actor: Actor,
  forced = false,
) {
  const lockKey = `billing-case:${order.customerId}:${order.localOrderDate}:${order.currency}`;
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);
  let caseId: string | undefined;
  if (!order.isolated) {
    // Il frammento interpolato è una costante di billing-case-sql.server.ts; i dati
    // della richiesta restano nei parametri $1, $2 e $3.
    // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM billing_cases
       WHERE customer_id = $1 AND local_order_date = $2 AND currency = $3
         AND ${openBillingCaseSql()}
       FOR UPDATE`,
      [order.customerId, order.localOrderDate, order.currency],
    );
    caseId = existing.rows[0]?.id;
  }
  if (!caseId) {
    const created = await client.query<{ id: string }>(
      `INSERT INTO billing_cases
        (customer_id, local_order_date, currency, status, customer_snapshot_json,
         do_not_transmit_reason)
       VALUES ($1, $2, $3, $5, $4, $6)
       RETURNING id`,
      [
        order.customerId,
        order.localOrderDate,
        order.currency,
        JSON.stringify(order.customerSnapshot),
        order.isolated ? "DO_NOT_TRANSMIT" : "NEEDS_REVIEW",
        order.isolated ? "Ordine rimborsato prima dell’emissione" : null,
      ],
    );
    caseId = created.rows[0]!.id;
    await writeAudit(client, {
      ...auditActor(actor),
      action: "BILLING_CASE_CREATED",
      eventClass: "CRITICAL",
      entityType: "BILLING_CASE",
      entityId: caseId,
      requestId: actor.requestId,
    });
    if (order.isolated) {
      await writeAudit(client, {
        actorType: "SYSTEM",
        action: "BILLING_CASE_DO_NOT_TRANSMIT",
        eventClass: "CRITICAL",
        entityType: "BILLING_CASE",
        entityId: caseId,
        metadata: { billingCaseId: caseId, reason: "REFUNDED" },
        requestId: actor.requestId,
      });
    }
  }
  const assigned = await client.query(
    `UPDATE orders
     SET billing_case_id = $2, trigger_status = 'GROUPED'
     WHERE id = $1 AND billing_case_id IS NULL`,
    [order.id, caseId],
  );
  if (assigned.rowCount) {
    const reconciliation = await reconcileInvoiceDraft(client, caseId);
    const refund = await client.query<{
      gross_amount: number;
      billable_amount: number;
      refunds: Array<{ status: string; amount: number | null }>;
    }>(
      `SELECT orders.gross_amount, orders.billable_amount,
              coalesce(jsonb_agg(jsonb_build_object(
                'status', refunds.status, 'amount', refunds.amount
              )) FILTER (WHERE refunds.id IS NOT NULL), '[]'::jsonb) AS refunds
       FROM orders LEFT JOIN refunds ON refunds.order_id = orders.id
       WHERE orders.id = $1
       GROUP BY orders.id`,
      [order.id],
    );
    const refundEffect = preIssueRefund(
      refund.rows[0]!.gross_amount,
      refund.rows[0]!.refunds,
      refund.rows[0]!.billable_amount,
    );
    if (
      refundEffect.state === "PARTIAL" &&
      (await reconcilePreIssueInvoiceAmount(client, order.id, caseId, refundEffect.billableAmount))
    ) {
      await writeAudit(client, {
        ...auditActor(actor),
        action: "REFUND_APPLIED_BEFORE_ISSUE",
        eventClass: "CRITICAL",
        entityType: "ORDER",
        entityId: order.id,
        metadata: { billingCaseId: caseId },
        requestId: actor.requestId,
      });
    }
    await writeAudit(client, {
      ...auditActor(actor),
      action: forced ? "ORDER_GROUPING_FORCED" : "ORDER_GROUPED",
      eventClass: "CRITICAL",
      entityType: "ORDER",
      entityId: order.id,
      metadata: { billingCaseId: caseId },
      before: reconciliation?.before,
      after: reconciliation?.after,
      requestId: actor.requestId,
    });
  }
  await recomputeBillingCaseStatus(client, caseId);
  return caseId;
}

async function currentOrderSettings(client: pg.PoolClient) {
  const result = await client.query<{ key: string; value_json: unknown }>(
    `SELECT key, value_json FROM settings
     WHERE key IN ('draft_trigger', 'shopify_payment_fee_mode')`,
  );
  const settings = new Map(result.rows.map((row) => [row.key, row.value_json]));
  return {
    trigger: draftTriggerSchema.parse(settings.get("draft_trigger") ?? "PAID"),
    shopifyPaymentFeeMode: shopifyPaymentFeeModeSchema.parse(
      settings.get("shopify_payment_fee_mode") ?? "DEDUCT",
    ),
  };
}

/**
 * Converte e valida gli importi ai confini: oltre questo punto l'import ragiona
 * soltanto in centesimi interi, mai sulle stringhe decimali della sorgente.
 */
function orderAmounts(input: OrderInput) {
  if (input.currency !== "EUR") throw new AppError("ORDER_CURRENCY_NOT_SUPPORTED", 422);
  const grossAmount = cents(input.total);
  if (grossAmount < 0) throw new AppError("ORDER_INVALID_INPUT", 422);
  const lineAmounts = input.lines.map((line) => ({
    grossAmount: cents(line.grossAmount),
    discountAmount: cents(line.discountAmount),
  }));
  const paymentAmounts = input.payments.map((payment) => cents(payment.amount));
  const shopifyPaymentsFeeAmounts = input.payments.map((payment) =>
    cents(payment.shopifyPaymentsFeeAmount),
  );
  const refundAmounts = input.refunds.map((refund) =>
    refund.amount === null ? null : cents(refund.amount),
  );
  const shippingAmount = cents(input.shippingAmount);
  if (
    lineAmounts.some(
      ({ grossAmount: amount, discountAmount }) =>
        amount < 0 || discountAmount < 0 || discountAmount > amount,
    ) ||
    paymentAmounts.some((amount) => amount < 0) ||
    shopifyPaymentsFeeAmounts.some(
      (amount, index) =>
        amount < 0 ||
        amount > paymentAmounts[index]! ||
        (amount > 0 &&
          (input.provider !== "SHOPIFY" ||
            input.payments[index]!.method.toLowerCase() !== "shopify_payments" ||
            input.payments[index]!.status !== "PAID")),
    ) ||
    refundAmounts.some((amount) => amount !== null && amount < 0) ||
    shippingAmount < 0
  ) {
    throw new AppError("ORDER_INVALID_INPUT", 422);
  }
  const linesReconciled =
    lineAmounts.reduce((sum, line) => sum + BigInt(line.grossAmount - line.discountAmount), 0n) +
      BigInt(shippingAmount) ===
    BigInt(grossAmount);
  // Nel Fulfillment API eBay gli importi del riepilogo pagamenti possono essere il
  // netto venditore. Lo stato PAID resta autorevole, ma quel netto non va confrontato
  // con il totale cliente; righe e spedizione continuano invece a doverlo ricostruire.
  const paidPaymentAmount = input.payments.reduce(
    (sum, payment, index) =>
      payment.status === "PAID" ? sum + BigInt(paymentAmounts[index]!) : sum,
    0n,
  );
  const observablePaymentAmount =
    paidPaymentAmount >= BigInt(grossAmount)
      ? paidPaymentAmount
      : input.payments.reduce(
          (sum, payment, index) =>
            payment.status === "REFUNDED" ? sum : sum + BigInt(paymentAmounts[index]!),
          0n,
        );
  const paymentsReconciled =
    input.provider === "EBAY" || observablePaymentAmount === BigInt(grossAmount);
  const totalsReconciled = linesReconciled && paymentsReconciled;
  const shopifyPaymentsFeeAmount = shopifyPaymentsFeeAmounts.reduce(
    (sum, amount) => sum + amount,
    0,
  );
  if (!Number.isSafeInteger(shopifyPaymentsFeeAmount) || shopifyPaymentsFeeAmount > grossAmount) {
    throw new AppError("ORDER_INVALID_INPUT", 422);
  }
  return {
    grossAmount,
    lineAmounts,
    paymentAmounts,
    shopifyPaymentsFeeAmounts,
    shopifyPaymentsFeeAmount,
    refundAmounts,
    shippingAmount,
    totalsReconciled,
  };
}

interface PreviousOrderRow {
  id: string;
  billing_case_id: string | null;
  last_observed_review_fingerprint: string | null;
  last_observed_snapshot_json: Record<string, unknown>;
  is_stale: boolean;
  billing_case_status: string | null;
  billing_case_do_not_transmit_automatic: boolean;
  deferred_review_required: boolean;
  order_review_required: boolean;
  customer_id: string;
  trigger_status: string;
  historical: boolean;
  historical_reconciliation_outcome: "ALREADY_INVOICED" | "NOT_INVOICED" | null;
}

/**
 * Stato osservato prima di questo import, bloccato in scrittura. Su una preparazione già
 * approvata o chiusa il confronto parte dall'ultima revisione registrata invece che dallo
 * snapshot dell'ordine: è quella la versione che il documento ha davvero emesso.
 */
async function loadPreviousOrder(client: pg.PoolClient, input: OrderInput) {
  return client.query<PreviousOrderRow>(
    `SELECT orders.id, orders.billing_case_id, orders.customer_id, orders.trigger_status,
            orders.historical_reconciliation_outcome,
            coalesce((orders.normalized_snapshot_json ->> 'historical')::boolean, false)
              AS historical,
            $4::timestamptz < orders.updated_at_source AS is_stale,
            CASE WHEN billing_cases.status IN ('APPROVED', 'CLOSED')
              THEN coalesce(latest_revision.snapshot ->> 'reviewFingerprint',
                            orders.normalized_snapshot_json ->> 'reviewFingerprint')
              ELSE orders.normalized_snapshot_json ->> 'reviewFingerprint'
            END AS last_observed_review_fingerprint,
            CASE WHEN billing_cases.status IN ('APPROVED', 'CLOSED')
              THEN coalesce(latest_revision.snapshot, orders.normalized_snapshot_json)
              ELSE orders.normalized_snapshot_json
            END AS last_observed_snapshot_json,
            billing_cases.status AS billing_case_status,
            coalesce((
              SELECT actor_type = 'SYSTEM'
                AND metadata_json ->> 'reason' IN ('CANCELLED', 'REFUNDED')
              FROM audit_events
              WHERE entity_type = 'BILLING_CASE'
                AND entity_id = orders.billing_case_id::text
                AND action = 'BILLING_CASE_DO_NOT_TRANSMIT'
              ORDER BY id DESC
              LIMIT 1
            ), false) AS billing_case_do_not_transmit_automatic,
            coalesce((orders.normalized_snapshot_json ->> 'deferredReviewRequired')::boolean, false)
              AS deferred_review_required,
            coalesce((orders.normalized_snapshot_json ->> 'orderReviewRequired')::boolean, true)
              AS order_review_required
     FROM orders
     LEFT JOIN billing_cases ON billing_cases.id = orders.billing_case_id
     LEFT JOIN LATERAL (
       SELECT current_normalized_snapshot_json AS snapshot
       FROM order_source_revisions
       WHERE order_id = orders.id
       ORDER BY id DESC
       LIMIT 1
     ) AS latest_revision ON true
     WHERE orders.provider = $1
       AND orders.external_account_id = $2
       AND orders.external_order_id = $3
     FOR UPDATE OF orders`,
    [input.provider, input.externalAccountId, input.externalOrderId, input.updatedAt],
  );
}

/** Anagrafica riconciliata sulla chiave di identità, più il legame con il record della sorgente. */
async function upsertCustomer(
  client: pg.PoolClient,
  input: OrderInput,
  identity: ReturnType<typeof customerIdentity>,
) {
  const presentation = presentationCustomer(input.customer);
  const customer = await client.query<{ id: string }>(
    `INSERT INTO customers
      (kind, match_key, display_name, first_name, last_name, company_name, email, phone,
       tax_id_type, tax_id_normalized, vat_country, billing_address_json,
       source_confidence, review_required)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (match_key) DO UPDATE SET
       kind = EXCLUDED.kind,
       display_name = EXCLUDED.display_name,
       first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name,
       company_name = EXCLUDED.company_name,
       email = EXCLUDED.email,
       phone = EXCLUDED.phone,
       tax_id_type = EXCLUDED.tax_id_type,
       tax_id_normalized = EXCLUDED.tax_id_normalized,
       vat_country = EXCLUDED.vat_country,
       billing_address_json = EXCLUDED.billing_address_json,
       source_confidence = EXCLUDED.source_confidence,
       review_required = EXCLUDED.review_required,
       updated_at = now()
     RETURNING id`,
    [
      input.customer.kind,
      identity.matchKey,
      customerDisplayName(presentation) || "Cliente senza nome",
      presentation.firstName ?? null,
      presentation.lastName ?? null,
      presentation.companyName ?? null,
      presentation.email ?? null,
      presentation.phone ?? null,
      identity.primaryTaxId?.type ?? null,
      identity.primaryTaxId?.value ?? null,
      identity.primaryTaxId?.countryCode ?? null,
      JSON.stringify(presentation.billingAddress),
      identity.confidence,
      identity.reviewRequired,
    ],
  );
  const customerId = customer.rows[0]!.id;
  if (input.externalCustomerId) {
    await client.query(
      `INSERT INTO customer_source_records
        (customer_id, provider, external_customer_id, raw_snapshot_json)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (provider, external_customer_id) DO UPDATE
       SET customer_id = EXCLUDED.customer_id,
           raw_snapshot_json = EXCLUDED.raw_snapshot_json,
           imported_at = now()`,
      [customerId, input.provider, input.externalCustomerId, JSON.stringify(input.customer)],
    );
  }
  return customerId;
}

async function importOne(
  client: pg.PoolClient,
  input: OrderInput,
  trigger: DraftTrigger,
  shopifyPaymentFeeMode: ShopifyPaymentFeeMode,
  actor: Actor,
) {
  const {
    grossAmount,
    lineAmounts,
    paymentAmounts,
    shopifyPaymentsFeeAmounts,
    shopifyPaymentsFeeAmount,
    refundAmounts,
    shippingAmount,
    totalsReconciled,
  } = orderAmounts(input);
  const identity = customerIdentity(input);
  const localDate = localOrderDate(input.createdAt);
  const fingerprint = reviewFingerprint(
    input,
    identity.matchKey,
    grossAmount,
    localDate,
    lineAmounts,
    paymentAmounts,
    shopifyPaymentsFeeAmounts,
    shippingAmount,
    refundAmounts,
  );
  const deductedShopifyPaymentsFeeAmount =
    input.provider === "SHOPIFY" && shopifyPaymentFeeMode === "DEDUCT"
      ? shopifyPaymentsFeeAmount
      : 0;
  const billableAmount = grossAmount - deductedShopifyPaymentsFeeAmount;
  const refundEffect = preIssueRefund(
    grossAmount,
    input.refunds.map((refund, index) => ({
      status: refund.status,
      amount: refundAmounts[index]!,
    })),
    billableAmount,
  );
  const orderReview =
    orderReviewRequired(input, totalsReconciled, grossAmount, trigger) ||
    refundEffect.state === "NEEDS_REVIEW";
  const previous = await loadPreviousOrder(client, input);
  if (previous.rows[0]?.is_stale) return "ignored";

  const oldOrder = previous.rows[0];
  const historical = input.historical || Boolean(oldOrder?.historical);
  const status =
    oldOrder?.historical_reconciliation_outcome === "ALREADY_INVOICED"
      ? "INVOICED"
      : triggerStatus(
          {
            ...input,
            paymentStatus: effectiveOrderPaymentStatus(input, grossAmount),
            historical:
              historical && oldOrder?.historical_reconciliation_outcome !== "NOT_INVOICED",
          },
          trigger,
        );
  const deferredReviewRequired = oldOrder?.deferred_review_required ?? false;
  const invoiced = ["APPROVED", "CLOSED"].includes(oldOrder?.billing_case_status ?? "");
  const documentIssued =
    invoiced || oldOrder?.historical_reconciliation_outcome === "ALREADY_INVOICED";
  // Una preparazione già emessa non riscrive l'anagrafica: l'ordine resta sul suo cliente.
  const customerId = invoiced
    ? oldOrder!.customer_id
    : await upsertCustomer(client, input, identity);
  const normalizedSnapshot = {
    ...input,
    historical,
    customerSnapshot: customerSnapshot(input, identity),
    totalAmount: grossAmount,
    shopifyPaymentsFeeAmount,
    deductedShopifyPaymentsFeeAmount,
    billableAmount,
    shippingAmount,
    localOrderDate: localDate,
    customerIdentity: identity.confidence,
    customerReviewRequired: identity.reviewRequired,
    orderReviewRequired: orderReview,
    deferredReviewRequired,
    totalsReconciled,
    reviewFingerprint: fingerprint,
  };
  const becameHistorical = Boolean(
    input.historical && oldOrder?.billing_case_id && !oldOrder.historical && !invoiced,
  );
  const fingerprintChanged = Boolean(
    oldOrder?.billing_case_id && oldOrder.last_observed_review_fingerprint !== fingerprint,
  );
  const mapperCorrectionCandidate = Boolean(
    input.provider === "SHOPIFY" &&
    fingerprintChanged &&
    oldOrder &&
    sameProviderSnapshot(oldOrder.last_observed_snapshot_json, input),
  );
  const mapperPaymentCorrectionCandidate = Boolean(
    mapperCorrectionCandidate &&
    !invoiced &&
    oldOrder?.order_review_required &&
    !orderReview &&
    effectiveOrderPaymentStatus(input, grossAmount) === "PAID",
  );
  const order = await client.query<{
    id: string;
    billing_case_id: string | null;
    customer_id: string;
  }>(
    `INSERT INTO orders
      (provider, external_account_id, external_order_id, display_number,
       created_at_source, updated_at_source, local_order_date, currency, gross_amount,
       shopify_payments_fee_amount, deducted_shopify_payments_fee_amount,
       payment_status, fulfillment_status, trigger_status, customer_id,
       raw_snapshot_json, normalized_snapshot_json, cancelled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     ON CONFLICT (provider, external_account_id, external_order_id) DO UPDATE SET
       display_number = CASE WHEN $19::boolean THEN orders.display_number ELSE EXCLUDED.display_number END,
       created_at_source = CASE WHEN $19::boolean THEN orders.created_at_source ELSE EXCLUDED.created_at_source END,
       updated_at_source = EXCLUDED.updated_at_source,
       local_order_date = CASE WHEN $19::boolean THEN orders.local_order_date ELSE EXCLUDED.local_order_date END,
       gross_amount = CASE WHEN $19::boolean THEN orders.gross_amount ELSE EXCLUDED.gross_amount END,
       shopify_payments_fee_amount = CASE WHEN $19::boolean THEN orders.shopify_payments_fee_amount ELSE EXCLUDED.shopify_payments_fee_amount END,
       deducted_shopify_payments_fee_amount = CASE WHEN $19::boolean THEN orders.deducted_shopify_payments_fee_amount ELSE EXCLUDED.deducted_shopify_payments_fee_amount END,
       payment_status = EXCLUDED.payment_status,
       fulfillment_status = EXCLUDED.fulfillment_status,
       trigger_status = CASE
         WHEN orders.billing_case_id IS NOT NULL AND $19::boolean THEN 'INVOICED'
         WHEN orders.billing_case_id IS NOT NULL AND EXCLUDED.cancelled_at IS NOT NULL
           THEN 'CANCELLED_NO_DOCUMENT'
         WHEN orders.billing_case_id IS NOT NULL AND EXCLUDED.payment_status = 'REFUNDED'
           THEN 'REFUNDED_BEFORE_ISSUE'
         WHEN orders.billing_case_id IS NOT NULL THEN orders.trigger_status
         ELSE EXCLUDED.trigger_status
       END,
       customer_id = CASE WHEN orders.billing_case_id IS NULL THEN EXCLUDED.customer_id ELSE orders.customer_id END,
       raw_snapshot_json = CASE WHEN $19::boolean THEN orders.raw_snapshot_json ELSE EXCLUDED.raw_snapshot_json END,
       normalized_snapshot_json = CASE WHEN $19::boolean THEN orders.normalized_snapshot_json ELSE EXCLUDED.normalized_snapshot_json END,
       last_synced_at = now(),
       cancelled_at = EXCLUDED.cancelled_at
     RETURNING id, billing_case_id, customer_id`,
    [
      input.provider,
      input.externalAccountId,
      input.externalOrderId,
      input.displayNumber,
      input.createdAt,
      input.updatedAt,
      localDate,
      input.currency,
      grossAmount,
      shopifyPaymentsFeeAmount,
      deductedShopifyPaymentsFeeAmount,
      input.paymentStatus,
      input.fulfillmentStatus,
      status,
      customerId,
      JSON.stringify(input),
      JSON.stringify(normalizedSnapshot),
      input.cancelledAt,
      documentIssued,
    ],
  );
  const orderId = order.rows[0]!.id;
  const mapperCorrectionApplied =
    mapperCorrectionCandidate && oldOrder?.billing_case_id
      ? await reconcileMapperCustomerCorrection(client, {
          caseId: oldOrder.billing_case_id,
          orderId,
          oldCustomerId: oldOrder.customer_id,
          newCustomerId: customerId,
          previousSnapshot: oldOrder.last_observed_snapshot_json,
          customerSnapshot: normalizedSnapshot.customerSnapshot,
          requestId: actor.requestId,
        })
      : false;
  const mapperDerivedCorrectionApplied =
    mapperCorrectionApplied || mapperPaymentCorrectionCandidate;
  const sourceConflict =
    becameHistorical || (fingerprintChanged && !mapperDerivedCorrectionApplied);
  const revision = sourceConflict
    ? await client.query<{ id: string }>(
        `INSERT INTO order_source_revisions
          (order_id, billing_case_id, previous_normalized_snapshot_json,
           current_normalized_snapshot_json)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [
          oldOrder!.id,
          oldOrder!.billing_case_id,
          JSON.stringify(oldOrder!.last_observed_snapshot_json),
          JSON.stringify(normalizedSnapshot),
        ],
      )
    : null;
  const historicalReconciliationPending =
    historical && oldOrder?.historical_reconciliation_outcome == null;
  const currentBillingCaseId = sourceConflict
    ? await applySourceConflict(client, actor, {
        input,
        oldOrder: oldOrder!,
        orderId,
        customerId,
        status,
        revisionId: revision!.rows[0]!.id,
        invoiced,
        billingCaseId: order.rows[0]!.billing_case_id,
        refundEffect: refundEffect.state,
        becameHistorical,
      })
    : order.rows[0]!.billing_case_id;
  const previousAppliedRefundAmount = await replaceOrderChildren(
    client,
    orderId,
    input,
    { lineAmounts, paymentAmounts, shopifyPaymentsFeeAmounts, refundAmounts },
    documentIssued,
    actor,
  );
  if (mapperPaymentCorrectionCandidate && oldOrder?.billing_case_id) {
    // Il frammento interpolato è una costante interna che riceve soltanto l'alias SQL fisso.
    // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk
    await client.query(
      `UPDATE documents
       SET payment_status = 'PAID', draft_version = draft_version + 1,
           projection_sha256 = repeat('0', 64), updated_at = now()
       WHERE billing_case_id = $1 AND kind = 'INVOICE'
         AND status = 'DRAFT' AND payment_status = 'PENDING'
         AND NOT EXISTS (
           SELECT 1 FROM orders AS case_order
           WHERE case_order.billing_case_id = $1
             AND ${pendingPaymentSql("case_order")}
         )`,
      [oldOrder.billing_case_id],
    );
    await recomputeBillingCaseStatus(client, oldOrder.billing_case_id);
    await refreshInvoiceDraftProjection(client, oldOrder.billing_case_id);
  }
  let effectiveBillingCaseId = currentBillingCaseId;
  if (
    !historicalReconciliationPending &&
    !effectiveBillingCaseId &&
    (status === "ELIGIBLE" || (status !== "INVOICED" && refundEffect.state === "TOTAL"))
  ) {
    effectiveBillingCaseId = await groupOrder(
      client,
      {
        id: orderId,
        customerId,
        customerSnapshot: normalizedSnapshot.customerSnapshot,
        localOrderDate: localDate,
        currency: input.currency,
        isolated: refundEffect.state === "TOTAL",
      },
      actor,
    );
  }
  if (!documentIssued && effectiveBillingCaseId && refundEffect.state === "PARTIAL") {
    const restored = await client.query(
      `UPDATE orders
       SET trigger_status = 'GROUPED',
           normalized_snapshot_json = jsonb_set(
             normalized_snapshot_json, '{orderReviewRequired}', 'false'::jsonb)
       WHERE id = $1 AND (
         trigger_status <> 'GROUPED'
         OR coalesce((normalized_snapshot_json ->> 'orderReviewRequired')::boolean, true)
       )`,
      [orderId],
    );
    const adjusted = await reconcilePreIssueInvoiceAmount(
      client,
      orderId,
      effectiveBillingCaseId,
      refundEffect.billableAmount,
    );
    if (restored.rowCount || adjusted) {
      await recomputeBillingCaseStatus(client, effectiveBillingCaseId);
      await writeAudit(client, {
        ...auditActor(actor),
        action: "REFUND_APPLIED_BEFORE_ISSUE",
        eventClass: "CRITICAL",
        entityType: "ORDER",
        entityId: orderId,
        metadata: { billingCaseId: effectiveBillingCaseId, provider: input.provider },
        requestId: actor.requestId,
      });
    }
  }
  if (
    !documentIssued &&
    effectiveBillingCaseId &&
    previousAppliedRefundAmount > 0 &&
    (refundEffect.state === "UNCHANGED" || refundEffect.state === "NEEDS_REVIEW")
  ) {
    const restored =
      refundEffect.state === "UNCHANGED"
        ? await client.query(
            `UPDATE orders
             SET trigger_status = 'GROUPED',
                 normalized_snapshot_json = jsonb_set(
                   normalized_snapshot_json, '{orderReviewRequired}', 'false'::jsonb)
             WHERE id = $1 AND trigger_status <> 'GROUPED'`,
            [orderId],
          )
        : { rowCount: 0 };
    const adjusted = await reconcilePreIssueInvoiceAmount(
      client,
      orderId,
      effectiveBillingCaseId,
      billableAmount,
    );
    if (restored.rowCount || adjusted) {
      await recomputeBillingCaseStatus(client, effectiveBillingCaseId);
      await writeAudit(client, {
        ...auditActor(actor),
        action: "REFUND_REVERSED_BEFORE_ISSUE",
        eventClass: "CRITICAL",
        entityType: "ORDER",
        entityId: orderId,
        metadata: { billingCaseId: effectiveBillingCaseId, provider: input.provider },
        before: { billableAmount: billableAmount - previousAppliedRefundAmount },
        after: { billableAmount },
        requestId: actor.requestId,
      });
    }
  }
  if (!documentIssued && effectiveBillingCaseId && refundEffect.state === "TOTAL") {
    const marked = await client.query(
      `UPDATE orders SET trigger_status = 'REFUNDED_BEFORE_ISSUE'
       WHERE id = $1 AND trigger_status <> 'REFUNDED_BEFORE_ISSUE'`,
      [orderId],
    );
    const closed = await client.query(
      `UPDATE billing_cases
       SET status = 'DO_NOT_TRANSMIT',
           do_not_transmit_reason = 'Ordine rimborsato prima dell’emissione',
           revision = revision + 1, updated_at = now()
       WHERE id = $1 AND ${openBillingCaseSql()}`,
      [effectiveBillingCaseId],
    );
    if (closed.rowCount) {
      await writeAudit(client, {
        actorType: "SYSTEM",
        action: "BILLING_CASE_DO_NOT_TRANSMIT",
        eventClass: "CRITICAL",
        entityType: "BILLING_CASE",
        entityId: effectiveBillingCaseId,
        metadata: { billingCaseId: effectiveBillingCaseId, reason: "REFUNDED" },
        requestId: actor.requestId,
      });
    }
    if (marked.rowCount || closed.rowCount) {
      await writeAudit(client, {
        ...auditActor(actor),
        action: "REFUND_APPLIED_BEFORE_ISSUE",
        eventClass: "CRITICAL",
        entityType: "ORDER",
        entityId: orderId,
        metadata: { billingCaseId: effectiveBillingCaseId, provider: input.provider },
        requestId: actor.requestId,
      });
    }
  }
  // Le correzioni del mapper possono cambiare un'anomalia derivata senza cambiare il
  // fingerprint della sorgente. Il replay richiesto dalla migrazione deve quindi
  // riallineare anche la preparazione già persistita, non soltanto il suo snapshot.
  if (
    !documentIssued &&
    effectiveBillingCaseId &&
    oldOrder &&
    oldOrder.order_review_required !== orderReview &&
    !sourceConflict
  ) {
    await recomputeBillingCaseStatus(client, effectiveBillingCaseId);
  }
  if (oldOrder && oldOrder.customer_id !== order.rows[0]!.customer_id) {
    await client.query(
      `DELETE FROM customers
       WHERE id = $1
         AND NOT EXISTS (SELECT 1 FROM orders WHERE orders.customer_id = customers.id)
         AND NOT EXISTS (
           SELECT 1 FROM billing_cases WHERE billing_cases.customer_id = customers.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM customer_source_records
           WHERE customer_source_records.customer_id = customers.id
         )`,
      [oldOrder.customer_id],
    );
  }
  await writeAudit(client, {
    ...auditActor(actor),
    action: previous.rows[0] ? "ORDER_SOURCE_UPDATED" : "ORDER_IMPORTED",
    eventClass: "OPERATIONAL",
    entityType: "ORDER",
    entityId: orderId,
    metadata: { provider: input.provider },
    requestId: actor.requestId,
  });
  return previous.rows[0] ? "updated" : "imported";
}

/**
 * I dati della sorgente sono cambiati sotto una preparazione già aperta. La preparazione
 * non può più essere emessa come sta: o viene archiviata (ordine annullato o rimborsato)
 * e gli altri ordini tornano in coda, oppure passa da verificare.
 * Restituisce la preparazione a cui l'ordine resta agganciato, `null` se ne è uscito.
 */
async function applySourceConflict(
  client: pg.PoolClient,
  actor: Actor,
  context: {
    input: OrderInput;
    oldOrder: PreviousOrderRow;
    orderId: string;
    customerId: string;
    status: ReturnType<typeof triggerStatus> | "INVOICED";
    revisionId: string;
    invoiced: boolean;
    billingCaseId: string | null;
    refundEffect: ReturnType<typeof preIssueRefund>["state"];
    becameHistorical: boolean;
  },
) {
  const { input, oldOrder, orderId, customerId, status, invoiced } = context;
  const reason = context.becameHistorical
    ? ("HISTORICAL" as const)
    : input.cancelledAt
      ? ("CANCELLED" as const)
      : input.paymentStatus === "REFUNDED" || context.refundEffect === "TOTAL"
        ? ("REFUNDED" as const)
        : null;
  if (!reason && !invoiced) {
    await client.query("UPDATE orders SET trigger_status = 'NEEDS_REVIEW' WHERE id = $1", [
      orderId,
    ]);
  }
  // I frammenti interpolati sono costanti di modulo di billing-case-sql.server.ts:
  // nessun valore della richiesta entra nel testo SQL, i dati restano in $1, $2, ...
  // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk
  const transitionedCase = await client.query(
    `UPDATE billing_cases
       SET status = $2,
           do_not_transmit_reason = $3,
           revision = revision + 1,
           updated_at = now()
       WHERE id = $1 AND ${openBillingCaseSql()}`,
    [
      oldOrder!.billing_case_id,
      reason ? "DO_NOT_TRANSMIT" : "NEEDS_REVIEW",
      reason === "CANCELLED"
        ? "Ordine annullato dalla sorgente"
        : reason === "REFUNDED"
          ? "Ordine rimborsato prima dell’emissione"
          : reason === "HISTORICAL"
            ? "Ordine storico da confrontare con Aruba"
            : null,
    ],
  );
  await writeAudit(client, {
    ...auditActor(actor),
    action: "ORDER_SOURCE_CONFLICT",
    eventClass: "CRITICAL",
    entityType: "ORDER",
    entityId: orderId,
    metadata: {
      billingCaseId: oldOrder.billing_case_id!,
      revisionId: context.revisionId,
    },
    requestId: actor.requestId,
  });
  if (reason && transitionedCase.rowCount) {
    await writeAudit(client, {
      actorType: "SYSTEM",
      action: "BILLING_CASE_DO_NOT_TRANSMIT",
      eventClass: "CRITICAL",
      entityType: "BILLING_CASE",
      entityId: oldOrder!.billing_case_id!,
      metadata: {
        billingCaseId: oldOrder!.billing_case_id!,
        reason,
        reviewRequired: oldOrder!.trigger_status === "NEEDS_REVIEW",
      },
      requestId: actor.requestId,
    });
    // I frammenti interpolati sono costanti di modulo di billing-case-sql.server.ts:
    // nessun valore della richiesta entra nel testo SQL, i dati restano in $1, $2, ...
    // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk
    const remainingOrders = await client.query<{
      id: string;
      customer_id: string;
      local_order_date: string;
      currency: string;
      customer_snapshot: Record<string, unknown>;
    }>(
      `UPDATE orders
         SET billing_case_id = NULL,
             trigger_status = 'ELIGIBLE',
             normalized_snapshot_json = jsonb_set(
               normalized_snapshot_json,
               '{deferredReviewRequired}',
               -- L'anomalia propria dell'ordine resta leggibile nel suo snapshot: qui va
               -- conservata soltanto la verifica che il distacco cancellerebbe.
               to_jsonb(
                 coalesce(
                   (normalized_snapshot_json ->> 'deferredReviewRequired')::boolean,
                   false
                 )
                 OR trigger_status = 'NEEDS_REVIEW'
               )
             )
         WHERE billing_case_id = $1 AND id <> $2
           AND ${orderBillableSql()}
         RETURNING id, customer_id, local_order_date::text, currency,
           normalized_snapshot_json -> 'customerSnapshot' AS customer_snapshot`,
      [oldOrder!.billing_case_id, orderId],
    );
    // Ogni assegnazione deve osservare la preparazione creata dalla precedente nella stessa transazione.
    for (const remainingOrder of remainingOrders.rows) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      await groupOrder(
        client,
        {
          id: remainingOrder.id,
          customerId: remainingOrder.customer_id,
          customerSnapshot: remainingOrder.customer_snapshot,
          localOrderDate: remainingOrder.local_order_date,
          currency: remainingOrder.currency,
        },
        actor,
      );
    }
  }
  if (reason === "HISTORICAL") {
    await client.query(
      `UPDATE orders SET billing_case_id = NULL, trigger_status = $2 WHERE id = $1`,
      [orderId, status],
    );
    return null;
  }
  if (
    !reason &&
    oldOrder.billing_case_status === "DO_NOT_TRANSMIT" &&
    oldOrder.billing_case_do_not_transmit_automatic
  ) {
    // L'ordine esce da una preparazione archiviata dal sistema perché i suoi dati sono
    // cambiati due volte: la preparazione che lo accoglie nasce da verificare.
    await client.query(
      `UPDATE orders
         SET billing_case_id = NULL, trigger_status = $3, customer_id = $2,
             normalized_snapshot_json = jsonb_set(
               normalized_snapshot_json,
               '{deferredReviewRequired}',
               to_jsonb($4::boolean)
             )
         WHERE id = $1`,
      [orderId, customerId, status, true],
    );
    return null;
  }
  return context.billingCaseId;
}

/**
 * Righe, identificativi fiscali e pagamenti seguono la sorgente. Dopo l'emissione righe e
 * identificativi restano congelati sul documento, mentre i pagamenti continuano ad allinearsi:
 * quelli registrati a mano non vengono mai toccati.
 */
async function replaceOrderChildren(
  client: pg.PoolClient,
  orderId: string,
  input: OrderInput,
  amounts: Pick<
    ReturnType<typeof orderAmounts>,
    "lineAmounts" | "paymentAmounts" | "shopifyPaymentsFeeAmounts" | "refundAmounts"
  >,
  invoiced: boolean,
  actor: Actor,
) {
  const { lineAmounts, paymentAmounts, shopifyPaymentsFeeAmounts, refundAmounts } = amounts;
  const previousApplied = await client.query<{ amount: number }>(
    `SELECT coalesce(sum(amount), 0)::integer AS amount FROM refunds
     WHERE order_id = $1 AND applied_before_issue`,
    [orderId],
  );
  if (!invoiced) {
    await client.query("DELETE FROM order_lines WHERE order_id = $1", [orderId]);
    for (const [index, line] of input.lines.entries()) {
      const lineAmount = lineAmounts[index]!;
      await client.query(
        `INSERT INTO order_lines
          (order_id, external_line_id, description, quantity, gross_amount, discount_amount, raw_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          orderId,
          line.externalLineId,
          line.description,
          line.quantity,
          lineAmount.grossAmount,
          lineAmount.discountAmount,
          JSON.stringify(line),
        ],
      );
    }
    await client.query("DELETE FROM order_tax_identifiers WHERE order_id = $1", [orderId]);
    for (const identifier of canonicalTaxIdentifiers(input)) {
      await client.query(
        `INSERT INTO order_tax_identifiers
          (order_id, type, raw_value, normalized_value, country_code, source_field)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          orderId,
          identifier.type,
          identifier.rawValue,
          identifier.value,
          identifier.countryCode ?? null,
          identifier.sourceField,
        ],
      );
    }
  }
  await client.query(
    `DELETE FROM payments
     WHERE order_id = $1 AND recorded_manually = false
       AND NOT (external_payment_id = ANY($2::text[]))`,
    [orderId, input.payments.map((payment) => payment.externalPaymentId)],
  );
  for (const [index, payment] of input.payments.entries()) {
    await client.query(
      `INSERT INTO payments
        (order_id, external_payment_id, method, status, amount,
         shopify_payments_fee_amount, paid_at, raw_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (order_id, external_payment_id) DO UPDATE SET
         method = EXCLUDED.method,
         status = EXCLUDED.status,
         amount = EXCLUDED.amount,
         shopify_payments_fee_amount = EXCLUDED.shopify_payments_fee_amount,
         paid_at = EXCLUDED.paid_at,
         raw_json = EXCLUDED.raw_json
       WHERE payments.recorded_manually = false`,
      [
        orderId,
        payment.externalPaymentId,
        payment.method,
        payment.status,
        paymentAmounts[index],
        shopifyPaymentsFeeAmounts[index],
        payment.paidAt,
        JSON.stringify(payment),
      ],
    );
  }
  const creditDraftsToRefresh = new Set<string>();
  const removedFromDrafts = await client.query<{ credit_document_id: string }>(
    `SELECT refunds.credit_document_id
     FROM refunds JOIN documents ON documents.id = refunds.credit_document_id
     WHERE refunds.order_id = $1 AND documents.status = 'DRAFT'
       AND NOT (refunds.external_refund_id = ANY($2::text[]))
     FOR UPDATE OF refunds`,
    [orderId, input.refunds.map((refund) => refund.externalRefundId)],
  );
  for (const refund of removedFromDrafts.rows) {
    creditDraftsToRefresh.add(refund.credit_document_id);
  }
  await client.query(
    `DELETE FROM refunds
     WHERE order_id = $1
       AND (credit_document_id IS NULL OR EXISTS (
         SELECT 1 FROM documents
         WHERE documents.id = refunds.credit_document_id AND documents.status = 'DRAFT'
       ))
       AND NOT ($3::boolean AND applied_before_issue)
       AND NOT (external_refund_id = ANY($2::text[]))`,
    [orderId, input.refunds.map((refund) => refund.externalRefundId), invoiced],
  );
  for (const [index, refund] of input.refunds.entries()) {
    const previous = await client.query<{
      credit_document_id: string | null;
      status: string;
      amount: number | null;
      completed_at: Date | null;
    }>(
      `SELECT refunds.credit_document_id, refunds.status, refunds.amount, refunds.completed_at
       FROM refunds
       WHERE provider = $1 AND external_account_id = $2 AND external_order_id = $3
         AND external_refund_id = $4
       FOR UPDATE`,
      [input.provider, input.externalAccountId, input.externalOrderId, refund.externalRefundId],
    );
    const old = previous.rows[0];
    const nextAmount = refundAmounts[index];
    const changed = Boolean(
      old &&
      (old.status !== refund.status ||
        old.amount !== nextAmount ||
        old.completed_at?.toISOString() !== canonicalTimestamp(refund.completedAt)),
    );
    if (changed && old?.credit_document_id) {
      const linked = await client.query<{ status: string }>(
        "SELECT status FROM documents WHERE id = $1",
        [old.credit_document_id],
      );
      if (linked.rows[0]?.status === "DRAFT") creditDraftsToRefresh.add(old.credit_document_id);
    }
    await client.query(
      `INSERT INTO refunds
        (provider, external_account_id, external_order_id, external_refund_id, order_id,
         status, amount, completed_at, raw_json, applied_before_issue)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (provider, external_account_id, external_order_id, external_refund_id)
       DO UPDATE SET status = EXCLUDED.status, amount = EXCLUDED.amount,
                     completed_at = EXCLUDED.completed_at, raw_json = EXCLUDED.raw_json,
                     applied_before_issue = CASE WHEN $11::boolean
                       THEN refunds.applied_before_issue
                       ELSE EXCLUDED.applied_before_issue
                     END,
                     credit_document_id = CASE
                       WHEN EXCLUDED.status = 'COMPLETED' AND EXCLUDED.amount > 0
                         THEN refunds.credit_document_id
                       ELSE NULL
                     END,
                     updated_at = now()
       WHERE refunds.credit_document_id IS NULL OR EXISTS (
         SELECT 1 FROM documents
         WHERE documents.id = refunds.credit_document_id AND documents.status = 'DRAFT'
       )`,
      [
        input.provider,
        input.externalAccountId,
        input.externalOrderId,
        refund.externalRefundId,
        orderId,
        refund.status,
        refundAmounts[index],
        refund.completedAt,
        JSON.stringify(refund.raw),
        !invoiced && refund.status === "COMPLETED" && nextAmount !== null && nextAmount > 0,
        invoiced,
      ],
    );
  }
  for (const documentId of creditDraftsToRefresh) {
    // Le modifiche e il relativo registro condividono la stessa operazione PostgreSQL.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const total = await refreshCreditNoteDraft(client, documentId);
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    await writeAudit(client, {
      ...auditActor(actor),
      action: "REFUND_CREDIT_NOTE_UPDATED",
      eventClass: "CRITICAL",
      entityType: "DOCUMENT",
      entityId: documentId,
      metadata: { provider: input.provider, documentKind: "CREDIT_NOTE" },
      after: { total },
      requestId: actor.requestId,
    });
  }
  await client.query(
    `INSERT INTO jobs (type, payload_json)
     SELECT 'process_refund', jsonb_build_object('refundId', refunds.id::text)
     FROM refunds
     WHERE refunds.order_id = $1 AND refunds.status IN ('COMPLETED', 'AMBIGUOUS')
       AND NOT refunds.applied_before_issue
     ON CONFLICT DO NOTHING`,
    [orderId],
  );
  return previousApplied.rows[0]?.amount ?? 0;
}

interface HistoryImportCompletion {
  provider: Provider;
  accountReference: string;
  cursor: string;
  overlapFrom: string;
  count: number;
  reviewRequired: number;
}

export async function importOrders(
  input: unknown,
  actor: Actor,
  job?: ClaimedJob,
  history?: HistoryImportCompletion,
) {
  let orders: OrderInput[];
  try {
    orders = orderInputSchema.array().parse(input);
  } catch {
    throw new AppError("ORDER_INVALID_INPUT", 422);
  }
  const sourceKeys = orders.map((order) =>
    JSON.stringify([order.provider, order.externalAccountId, order.externalOrderId]),
  );
  if (new Set(sourceKeys).size !== sourceKeys.length) {
    throw new AppError("ORDER_INVALID_INPUT", 422);
  }
  if (
    history &&
    orders.some(
      (order) =>
        order.provider !== history.provider || order.externalAccountId !== history.accountReference,
    )
  ) {
    throw new AppError("CONFLICT_REVISION", 409);
  }
  return withTransaction(async (client) => {
    if (history) {
      await lockHistoryImportConnection(client, history.provider, history.accountReference, job);
    } else if (job) {
      await assertJobLease(client, job);
    }
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('setting:draft_trigger'))");
    await client.query(
      "SELECT pg_advisory_xact_lock_shared(hashtext('setting:shopify_payment_fee_mode'))",
    );
    await serializeOrderMutations(client);
    const { trigger, shopifyPaymentFeeMode } = await currentOrderSettings(client);
    const results = [];
    // Il batch resta seriale: ogni raggruppamento deve osservare gli ordini precedenti nella stessa transazione.
    for (const order of orders) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      results.push(await importOne(client, order, trigger, shopifyPaymentFeeMode, actor));
    }
    const result: HistoryImportResult = {
      count: history?.count ?? orders.length,
      reviewRequired: history?.reviewRequired ?? 0,
      imported: results.filter((result) => result === "imported").length,
      updated: results.filter((result) => result === "updated").length,
      ignored: results.filter((result) => result === "ignored").length,
    };
    if (history) {
      await completeHistoryImportInTransaction(
        client,
        history.provider,
        history.accountReference,
        history.cursor,
        history.overlapFrom,
        job,
        result,
      );
    }
    if (job) await renewLockedJobLease(client, job);
    return {
      imported: result.imported,
      updated: result.updated,
      ignored: result.ignored,
    };
  });
}
