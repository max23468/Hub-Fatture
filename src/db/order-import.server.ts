import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type pg from "pg";

import { writeAudit } from "./audit.server.ts";
import { recomputeBillingCaseStatus } from "./billing-case-status.server.ts";
import {
  approvedInvoiceOrderLinkSql,
  openBillingCaseSql,
  pendingPaymentSql,
} from "./billing-case-sql.server.ts";
import { withTransaction } from "./client.server.ts";
import {
  completeHistoryImportInTransaction,
  lockHistoryImportConnection,
} from "./connector-connections.server.ts";
import { assertJobLease, renewLockedJobLease } from "./connector-jobs.server.ts";
import type { ClaimedJob, HistoryImportResult, Provider } from "./connector-types.server.ts";
import { AppError } from "../errors.ts";
import {
  isEbayCustomerEmailOnlyMismatch,
  isEbayEmailAndMapperOnlyChange,
  isEbayEmailOnlyChange,
} from "../order-source-alignment.ts";
import {
  canonicalCustomerProfile,
  customerIdentity,
  customerDisplayName,
  decimalToCents,
  effectiveOrderPaymentStatus,
  localOrderDate,
  orderInputSchema,
  orderReviewRequired,
  presentationCustomer,
  triggerStatus,
  type CustomerContext,
  type DraftTrigger,
  type OrderInput,
  type ShopifyPaymentFeeMode,
} from "../orders.ts";
import { preIssueRefund } from "../refunds.ts";
import { paymentsReconciled } from "../order-payment-reconciliation.ts";
import { serializeOrderMutations } from "./order-mutation-lock.server.ts";
import { refreshInvoiceDraftProjection } from "./invoice-draft-projection.server.ts";
import {
  reconcileInvoiceDraft,
  reconcilePreIssueInvoiceAmount,
} from "./order-draft-reconciliation.server.ts";
import { groupOrder } from "./order-grouping.server.ts";
import { replaceOrderChildren } from "./order-children-persistence.server.ts";
import { applySourceConflict } from "./order-source-conflict.server.ts";
import { currentOrderSettings } from "./order-import-settings.server.ts";
import { auditOrderActor, type OrderActor as Actor } from "./order-actor.server.ts";
import { recordAutomaticCustomerIdentityException } from "./customer-identity-exceptions.server.ts";
import { reconcileMapperCustomerCorrection } from "./order-automatic-alignment.server.ts";
import { prepareCustomerInput } from "./order-customer-input.server.ts";
import { reconcileEbayCustomerAlignment } from "./order-ebay-customer-alignment.server.ts";
import { reconcileProviderOrderAlignment } from "./order-provider-alignment.server.ts";
import { canonicalOrderTimestamp } from "./order-timestamp.ts";
import {
  persistEbayOrderIdentities,
  reconcileEbayOrderIdentity,
} from "./order-source-identity.server.ts";

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

function cents(value: string): number {
  try {
    return decimalToCents(value);
  } catch {
    throw new AppError("ORDER_INVALID_INPUT", 422);
  }
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
        paidAt: canonicalOrderTimestamp(payment.paidAt),
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
      completedAt: canonicalOrderTimestamp(refund.completedAt),
    }))
    .sort((left, right) => left.externalRefundId.localeCompare(right.externalRefundId));
  const relevant = {
    displayNumber: input.displayNumber,
    totalAmount,
    localDate,
    paymentStatus: effectiveOrderPaymentStatus(input, totalAmount),
    fulfillmentStatus: input.fulfillmentStatus,
    cancelledAt: canonicalOrderTimestamp(input.cancelledAt),
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
  const totalsReconciled =
    linesReconciled &&
    paymentsReconciled({
      provider: input.provider,
      grossAmount,
      payments: input.payments,
      paymentAmounts,
    });
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
  approved_invoice_linked: boolean;
  billing_case_customer_snapshot_json: Record<string, unknown> | null;
  billing_case_customer_corrected: boolean;
  billing_case_do_not_transmit_automatic: boolean;
  deferred_review_required: boolean;
  source_conflict_required: boolean;
  order_review_required: boolean;
  customer_id: string;
  trigger_status: string;
  historical: boolean;
  historical_reconciliation_outcome: "ALREADY_INVOICED" | "NOT_INVOICED" | null;
  latest_revision_id: string | null;
  latest_revision_previous_snapshot_json: Record<string, unknown> | null;
  latest_revision_current_snapshot_json: Record<string, unknown> | null;
}

/**
 * Stato osservato prima di questo import, bloccato in scrittura. Su una preparazione già
 * approvata o chiusa il confronto parte dall'ultima revisione registrata invece che dallo
 * snapshot dell'ordine: è quella la versione che il documento ha davvero emesso.
 */
async function loadPreviousOrder(client: pg.PoolClient, input: OrderInput) {
  // Il frammento interpolato è una costante interna senza dati della richiesta.
  // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk
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
            ${approvedInvoiceOrderLinkSql("orders")} AS approved_invoice_linked,
            billing_cases.customer_snapshot_json AS billing_case_customer_snapshot_json,
            billing_cases.customer_corrected_at IS NOT NULL AS billing_case_customer_corrected,
            latest_revision.id::text AS latest_revision_id,
            latest_revision.previous_snapshot AS latest_revision_previous_snapshot_json,
            latest_revision.snapshot AS latest_revision_current_snapshot_json,
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
            coalesce((orders.normalized_snapshot_json ->> 'sourceConflictRequired')::boolean, false)
              AS source_conflict_required,
            coalesce((orders.normalized_snapshot_json ->> 'orderReviewRequired')::boolean, true)
              AS order_review_required
     FROM orders
     LEFT JOIN billing_cases ON billing_cases.id = orders.billing_case_id
     LEFT JOIN LATERAL (
       SELECT id, previous_normalized_snapshot_json AS previous_snapshot,
              current_normalized_snapshot_json AS snapshot
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

async function reconcileStaleIssuedMembership(
  client: pg.PoolClient,
  orderId: string,
  caseId: string,
  actor: Actor,
) {
  const remaining = await client.query<{ count: string }>(
    "SELECT count(*)::text FROM orders WHERE billing_case_id = $1",
    [caseId],
  );
  if (Number(remaining.rows[0]!.count) === 0) {
    await client.query(
      `DELETE FROM documents
       WHERE billing_case_id = $1 AND kind = 'INVOICE' AND status = 'DRAFT'`,
      [caseId],
    );
    await client.query(
      `UPDATE billing_cases
       SET status = 'CLOSED', revision = revision + 1, updated_at = now()
       WHERE id = $1 AND ${openBillingCaseSql()}`,
      [caseId],
    );
  } else {
    await reconcileInvoiceDraft(client, caseId);
    await recomputeBillingCaseStatus(client, caseId);
  }
  await writeAudit(client, {
    ...auditOrderActor(actor),
    action: "ORDER_ALREADY_INVOICED_RECONCILED",
    eventClass: "CRITICAL",
    entityType: "ORDER",
    entityId: orderId,
    metadata: { billingCaseId: caseId },
    requestId: actor.requestId,
  });
}

/** Anagrafica riconciliata sulla chiave di identità, più il legame con il record della sorgente. */
async function upsertCustomer(
  client: pg.PoolClient,
  input: OrderInput,
  identity: ReturnType<typeof customerIdentity>,
  sourceCustomer: OrderInput["customer"],
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
      [customerId, input.provider, input.externalCustomerId, JSON.stringify(sourceCustomer)],
    );
  }
  return customerId;
}

async function importOne(
  client: pg.PoolClient,
  sourceInput: OrderInput,
  trigger: DraftTrigger,
  shopifyPaymentFeeMode: ShopifyPaymentFeeMode,
  actor: Actor,
) {
  await reconcileEbayOrderIdentity(client, sourceInput);
  const { input, exception, taxRecovery } = await prepareCustomerInput(client, sourceInput);
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
  const sourceConflictRequired = oldOrder?.source_conflict_required ?? false;
  const invoiced = ["APPROVED", "CLOSED"].includes(oldOrder?.billing_case_status ?? "");
  const documentIssued =
    invoiced ||
    Boolean(oldOrder?.approved_invoice_linked) ||
    oldOrder?.historical_reconciliation_outcome === "ALREADY_INVOICED";
  const staleIssuedMembership = Boolean(
    oldOrder?.approved_invoice_linked &&
    oldOrder.billing_case_id &&
    ["DRAFT", "READY", "NEEDS_REVIEW"].includes(oldOrder.billing_case_status ?? ""),
  );
  // Una preparazione già emessa non riscrive l'anagrafica: l'ordine resta sul suo cliente.
  const customerId = documentIssued
    ? oldOrder!.customer_id
    : await upsertCustomer(client, input, identity, sourceInput.customer);
  if (!documentIssued && exception) {
    await recordAutomaticCustomerIdentityException(client, customerId, exception, actor.requestId);
  }
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
    sourceConflictRequired,
    totalsReconciled,
    reviewFingerprint: fingerprint,
  };
  const becameHistorical = Boolean(
    input.historical && oldOrder?.billing_case_id && !oldOrder.historical && !documentIssued,
  );
  const fingerprintChanged = Boolean(
    oldOrder?.billing_case_id && oldOrder.last_observed_review_fingerprint !== fingerprint,
  );
  const mapperCorrectionCandidate = Boolean(
    ["SHOPIFY", "EBAY"].includes(input.provider) &&
    fingerprintChanged &&
    oldOrder &&
    sameProviderSnapshot(oldOrder.last_observed_snapshot_json, input),
  );
  const mapperPaymentCorrectionCandidate = Boolean(
    mapperCorrectionCandidate &&
    !documentIssued &&
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
         WHEN $19::boolean THEN 'INVOICED'
         WHEN orders.billing_case_id IS NOT NULL AND EXCLUDED.cancelled_at IS NOT NULL
           THEN 'CANCELLED_NO_DOCUMENT'
         WHEN orders.billing_case_id IS NOT NULL AND EXCLUDED.payment_status = 'REFUNDED'
           THEN 'REFUNDED_BEFORE_ISSUE'
         WHEN orders.billing_case_id IS NOT NULL THEN orders.trigger_status
         ELSE EXCLUDED.trigger_status
       END,
       billing_case_id = CASE WHEN $20::boolean THEN NULL ELSE orders.billing_case_id END,
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
      JSON.stringify(sourceInput),
      JSON.stringify(normalizedSnapshot),
      input.cancelledAt,
      documentIssued,
      staleIssuedMembership,
    ],
  );
  const orderId = order.rows[0]!.id;
  await persistEbayOrderIdentities(client, input, orderId);
  const newEmailOnlyUpdate = Boolean(
    !documentIssued &&
    fingerprintChanged &&
    oldOrder?.billing_case_id &&
    oldOrder &&
    isEbayEmailOnlyChange(oldOrder.last_observed_snapshot_json, normalizedSnapshot),
  );
  const existingEmailOnlyConflict = Boolean(
    !documentIssued &&
    oldOrder?.billing_case_id &&
    oldOrder.trigger_status === "NEEDS_REVIEW" &&
    oldOrder.latest_revision_id &&
    oldOrder.latest_revision_previous_snapshot_json &&
    oldOrder.latest_revision_current_snapshot_json &&
    oldOrder.latest_revision_current_snapshot_json.reviewFingerprint === fingerprint &&
    isEbayEmailOnlyChange(
      oldOrder.latest_revision_previous_snapshot_json,
      oldOrder.latest_revision_current_snapshot_json,
    ),
  );
  const existingEmailAndMapperConflict = Boolean(
    !existingEmailOnlyConflict &&
    !documentIssued &&
    oldOrder?.billing_case_id &&
    ["NEEDS_REVIEW", "GROUPED"].includes(oldOrder.trigger_status) &&
    oldOrder.latest_revision_id &&
    oldOrder.latest_revision_previous_snapshot_json &&
    oldOrder.latest_revision_current_snapshot_json &&
    oldOrder.latest_revision_current_snapshot_json.reviewFingerprint !== fingerprint &&
    normalizedSnapshot.customerReviewRequired === false &&
    sameProviderSnapshot(oldOrder.latest_revision_current_snapshot_json, input) &&
    isEbayEmailAndMapperOnlyChange(
      oldOrder.latest_revision_previous_snapshot_json,
      oldOrder.latest_revision_current_snapshot_json,
    ),
  );
  const existingBillingCaseEmailMismatch = Boolean(
    !documentIssued &&
    !fingerprintChanged &&
    input.provider === "EBAY" &&
    oldOrder?.billing_case_id &&
    oldOrder.billing_case_customer_snapshot_json &&
    !oldOrder.billing_case_customer_corrected &&
    isEbayCustomerEmailOnlyMismatch(
      oldOrder.billing_case_customer_snapshot_json,
      normalizedSnapshot.customerSnapshot,
    ),
  );
  const emailOnlyAlignmentApplied =
    (newEmailOnlyUpdate ||
      existingEmailOnlyConflict ||
      existingEmailAndMapperConflict ||
      existingBillingCaseEmailMismatch) &&
    oldOrder?.billing_case_id
      ? await reconcileEbayCustomerAlignment(client, {
          caseId: oldOrder.billing_case_id,
          orderId,
          customerId,
          customerSnapshot: normalizedSnapshot.customerSnapshot,
          requestId: actor.requestId,
          ...(existingEmailOnlyConflict && oldOrder.latest_revision_id
            ? { revisionId: oldOrder.latest_revision_id }
            : {}),
          clearExistingConflict: existingEmailOnlyConflict || existingEmailAndMapperConflict,
          alignment: existingEmailAndMapperConflict ? "EMAIL_AND_MAPPER" : "EMAIL_ONLY",
        })
      : false;
  const providerAlignment = await reconcileProviderOrderAlignment(client, {
    provider: input.provider,
    documentIssued,
    oldOrder,
    fingerprint,
    orderId,
    customerId,
    requestId: actor.requestId,
    normalizedSnapshot,
    fingerprintChanged,
  });
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
          provider: input.provider,
          ...(taxRecovery.recovered
            ? {
                reason:
                  "Identificativo fiscale recuperato da un altro ordine dello stesso cliente sorgente con anagrafica coincidente",
              }
            : {}),
        })
      : false;
  const mapperDerivedCorrectionApplied =
    mapperCorrectionApplied ||
    mapperPaymentCorrectionCandidate ||
    emailOnlyAlignmentApplied ||
    providerAlignment.refundMapper ||
    providerAlignment.careOfAddress ||
    providerAlignment.paymentTimestamp ||
    providerAlignment.shopifyFulfillment;
  const sourceConflict =
    !staleIssuedMembership &&
    (becameHistorical || (fingerprintChanged && !mapperDerivedCorrectionApplied));
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
  if (staleIssuedMembership && oldOrder?.billing_case_id) {
    await reconcileStaleIssuedMembership(client, orderId, oldOrder.billing_case_id, actor);
  }
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
    !documentIssued &&
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
        ...auditOrderActor(actor),
        action: "REFUND_APPLIED_BEFORE_ISSUE",
        eventClass: "CRITICAL",
        entityType: "ORDER",
        entityId: orderId,
        metadata: {
          billingCaseId: effectiveBillingCaseId,
          provider: input.provider,
        },
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
        ...auditOrderActor(actor),
        action: "REFUND_REVERSED_BEFORE_ISSUE",
        eventClass: "CRITICAL",
        entityType: "ORDER",
        entityId: orderId,
        metadata: {
          billingCaseId: effectiveBillingCaseId,
          provider: input.provider,
        },
        before: {
          billableAmount: billableAmount - previousAppliedRefundAmount,
        },
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
        ...auditOrderActor(actor),
        action: "REFUND_APPLIED_BEFORE_ISSUE",
        eventClass: "CRITICAL",
        entityType: "ORDER",
        entityId: orderId,
        metadata: {
          billingCaseId: effectiveBillingCaseId,
          provider: input.provider,
        },
        requestId: actor.requestId,
      });
    }
  }
  // Un replay del mapper riallinea anche l'anomalia già persistita.
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
    ...auditOrderActor(actor),
    action: previous.rows[0] ? "ORDER_SOURCE_UPDATED" : "ORDER_IMPORTED",
    eventClass: "OPERATIONAL",
    entityType: "ORDER",
    entityId: orderId,
    metadata: {
      provider: input.provider,
      ...(emailOnlyAlignmentApplied
        ? {
            automaticAlignment: existingEmailAndMapperConflict
              ? ("EMAIL_AND_MAPPER" as const)
              : ("EMAIL_ONLY" as const),
          }
        : {}),
    },
    requestId: actor.requestId,
  });
  return previous.rows[0] ? "updated" : "imported";
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
