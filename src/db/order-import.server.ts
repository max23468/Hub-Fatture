import { createHash } from "node:crypto";

import type pg from "pg";

import { writeAudit } from "./audit.server.ts";
import {
  customerProfileMismatchSql,
  openBillingCaseSql,
  orderBillableSql,
} from "./billing-case-sql.server.ts";
import { withTransaction } from "./client.server.ts";
import { assertJobLease, renewLockedJobLease, type ClaimedJob } from "./connectors.server.ts";
import { AppError } from "../errors.ts";
import {
  canonicalCustomerProfile,
  canonicalTaxIdentifiers,
  customerIdentity,
  customerDisplayName,
  decimalToCents,
  draftTriggerSchema,
  localOrderDate,
  orderInputSchema,
  orderReviewRequired,
  triggerStatus,
  type CustomerContext,
  type DraftTrigger,
  type OrderInput,
} from "../orders.ts";

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
}

function customerSnapshot(input: CustomerContext, identity: ReturnType<typeof customerIdentity>) {
  const canonicalProfile = canonicalCustomerProfile(input);
  return {
    ...input.customer,
    displayName: customerDisplayName(input.customer) || "Cliente senza nome",
    taxIdentifiers: canonicalProfile.taxIdentifiers,
    canonicalProfile,
    sourceConfidence: identity.confidence,
    reviewRequired: identity.reviewRequired,
  };
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
    .map((payment, index) => ({
      ...payment,
      amount: paymentAmounts[index],
      paidAt: canonicalTimestamp(payment.paidAt),
    }))
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
    paymentStatus: input.paymentStatus,
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
export async function recomputeBillingCaseStatus(client: pg.PoolClient, caseId: string) {
  // I frammenti interpolati sono costanti di modulo di billing-case-sql.server.ts:
  // nessun valore della richiesta entra nel testo SQL, i dati restano in $1, $2, ...
  // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk
  const result = await client.query<{ status: string }>(
    // I frammenti interpolati sono costanti di modulo in billing-case-sql.server.ts:
    `UPDATE billing_cases
     SET status = CASE
           WHEN coalesce((customer_snapshot_json ->> 'reviewRequired')::boolean, true)
             OR EXISTS (
               SELECT 1 FROM orders
               WHERE orders.billing_case_id = billing_cases.id
                 AND (
                   coalesce(
                     (orders.normalized_snapshot_json ->> 'orderReviewRequired')::boolean, true)
                   OR coalesce(
                     (orders.normalized_snapshot_json ->> 'deferredReviewRequired')::boolean, false)
                   OR orders.trigger_status = 'NEEDS_REVIEW'
                   OR ${customerProfileMismatchSql}
                 )
             )
           THEN 'NEEDS_REVIEW'
           ELSE 'READY'
         END,
         revision = revision + 1,
         updated_at = now()
     WHERE id = $1 AND ${openBillingCaseSql()}
     RETURNING status`,
    [caseId],
  );
  return result.rows[0]?.status ?? null;
}

export async function groupOrder(
  client: pg.PoolClient,
  order: GroupableOrder,
  actor: Actor,
  forced = false,
) {
  const lockKey = `billing-case:${order.customerId}:${order.localOrderDate}:${order.currency}`;
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);
  // I frammenti interpolati sono costanti di modulo di billing-case-sql.server.ts:
  // nessun valore della richiesta entra nel testo SQL, i dati restano in $1, $2, ...
  // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk
  const existing = await client.query<{ id: string }>(
    // I frammenti interpolati sono costanti di modulo in billing-case-sql.server.ts:
    `SELECT id FROM billing_cases
     WHERE customer_id = $1 AND local_order_date = $2 AND currency = $3
       AND ${openBillingCaseSql()}
     FOR UPDATE`,
    [order.customerId, order.localOrderDate, order.currency],
  );
  let caseId = existing.rows[0]?.id;
  if (!caseId) {
    const created = await client.query<{ id: string }>(
      `INSERT INTO billing_cases
        (customer_id, local_order_date, currency, status, customer_snapshot_json)
       VALUES ($1, $2, $3, 'NEEDS_REVIEW', $4)
       RETURNING id`,
      [
        order.customerId,
        order.localOrderDate,
        order.currency,
        JSON.stringify(order.customerSnapshot),
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
  }
  const assigned = await client.query(
    `UPDATE orders
     SET billing_case_id = $2, trigger_status = 'GROUPED'
     WHERE id = $1 AND billing_case_id IS NULL`,
    [order.id, caseId],
  );
  if (assigned.rowCount) {
    await writeAudit(client, {
      ...auditActor(actor),
      action: forced ? "ORDER_GROUPING_FORCED" : "ORDER_GROUPED",
      eventClass: "CRITICAL",
      entityType: "ORDER",
      entityId: order.id,
      metadata: { billingCaseId: caseId },
      requestId: actor.requestId,
    });
  }
  await recomputeBillingCaseStatus(client, caseId);
  return caseId;
}

async function currentTrigger(client: pg.PoolClient): Promise<DraftTrigger> {
  const result = await client.query<{ value_json: unknown }>(
    "SELECT value_json FROM settings WHERE key = 'draft_trigger'",
  );
  return draftTriggerSchema.parse(result.rows[0]?.value_json ?? "PAID");
}

export async function serializeOrderMutations(client: pg.PoolClient) {
  // ponytail: lock globale adatto al single tenant; usare lock ordinati per ordine se la concorrenza misurata lo richiede.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('order-import-batch'))");
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
    refundAmounts.some((amount) => amount !== null && amount < 0) ||
    shippingAmount < 0
  ) {
    throw new AppError("ORDER_INVALID_INPUT", 422);
  }
  const totalsReconciled =
    lineAmounts.reduce((sum, line) => sum + BigInt(line.grossAmount - line.discountAmount), 0n) +
      BigInt(shippingAmount) ===
      BigInt(grossAmount) &&
    paymentAmounts.reduce((sum, amount) => sum + BigInt(amount), 0n) === BigInt(grossAmount);
  return {
    grossAmount,
    lineAmounts,
    paymentAmounts,
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
  customer_id: string;
  trigger_status: string;
}

/**
 * Stato osservato prima di questo import, bloccato in scrittura. Su una preparazione già
 * approvata o chiusa il confronto parte dall'ultima revisione registrata invece che dallo
 * snapshot dell'ordine: è quella la versione che il documento ha davvero emesso.
 */
async function loadPreviousOrder(client: pg.PoolClient, input: OrderInput) {
  return client.query<PreviousOrderRow>(
    `SELECT orders.id, orders.billing_case_id, orders.customer_id, orders.trigger_status,
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
              AS deferred_review_required
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
      customerDisplayName(input.customer) || "Cliente senza nome",
      input.customer.firstName ?? null,
      input.customer.lastName ?? null,
      input.customer.companyName ?? null,
      input.customer.email ?? null,
      input.customer.phone ?? null,
      identity.primaryTaxId?.type ?? null,
      identity.primaryTaxId?.value ?? null,
      identity.primaryTaxId?.countryCode ?? null,
      JSON.stringify(input.customer.billingAddress),
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
  actor: Actor,
) {
  const {
    grossAmount,
    lineAmounts,
    paymentAmounts,
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
    shippingAmount,
    refundAmounts,
  );
  const status = triggerStatus(input, trigger);
  const orderReview = orderReviewRequired(input, totalsReconciled, trigger);
  const previous = await loadPreviousOrder(client, input);
  if (previous.rows[0]?.is_stale) return "ignored";

  const oldOrder = previous.rows[0];
  const deferredReviewRequired = oldOrder?.deferred_review_required ?? false;
  const invoiced = ["APPROVED", "CLOSED"].includes(oldOrder?.billing_case_status ?? "");
  // Una preparazione già emessa non riscrive l'anagrafica: l'ordine resta sul suo cliente.
  const customerId = invoiced
    ? oldOrder!.customer_id
    : await upsertCustomer(client, input, identity);
  const normalizedSnapshot = {
    ...input,
    customerSnapshot: customerSnapshot(input, identity),
    totalAmount: grossAmount,
    shippingAmount,
    localOrderDate: localDate,
    customerIdentity: identity.confidence,
    customerReviewRequired: identity.reviewRequired,
    orderReviewRequired: orderReview,
    deferredReviewRequired,
    totalsReconciled,
    reviewFingerprint: fingerprint,
  };
  const sourceConflict = Boolean(
    oldOrder?.billing_case_id && oldOrder.last_observed_review_fingerprint !== fingerprint,
  );
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
  const order = await client.query<{
    id: string;
    billing_case_id: string | null;
    customer_id: string;
  }>(
    `INSERT INTO orders
      (provider, external_account_id, external_order_id, display_number,
       created_at_source, updated_at_source, local_order_date, currency, gross_amount,
       payment_status, fulfillment_status, trigger_status, customer_id,
       raw_snapshot_json, normalized_snapshot_json, cancelled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (provider, external_account_id, external_order_id) DO UPDATE SET
       display_number = CASE WHEN $17::boolean THEN orders.display_number ELSE EXCLUDED.display_number END,
       created_at_source = CASE WHEN $17::boolean THEN orders.created_at_source ELSE EXCLUDED.created_at_source END,
       updated_at_source = EXCLUDED.updated_at_source,
       local_order_date = CASE WHEN $17::boolean THEN orders.local_order_date ELSE EXCLUDED.local_order_date END,
       gross_amount = CASE WHEN $17::boolean THEN orders.gross_amount ELSE EXCLUDED.gross_amount END,
       payment_status = EXCLUDED.payment_status,
       fulfillment_status = EXCLUDED.fulfillment_status,
       trigger_status = CASE
         WHEN orders.billing_case_id IS NOT NULL AND $17::boolean THEN 'INVOICED'
         WHEN orders.billing_case_id IS NOT NULL AND EXCLUDED.cancelled_at IS NOT NULL
           THEN 'CANCELLED_NO_DOCUMENT'
         WHEN orders.billing_case_id IS NOT NULL AND EXCLUDED.payment_status = 'REFUNDED'
           THEN 'REFUNDED_BEFORE_ISSUE'
         WHEN orders.billing_case_id IS NOT NULL THEN orders.trigger_status
         ELSE EXCLUDED.trigger_status
       END,
       customer_id = CASE WHEN orders.billing_case_id IS NULL THEN EXCLUDED.customer_id ELSE orders.customer_id END,
       raw_snapshot_json = CASE WHEN $17::boolean THEN orders.raw_snapshot_json ELSE EXCLUDED.raw_snapshot_json END,
       normalized_snapshot_json = CASE WHEN $17::boolean THEN orders.normalized_snapshot_json ELSE EXCLUDED.normalized_snapshot_json END,
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
      input.paymentStatus,
      input.fulfillmentStatus,
      status,
      customerId,
      JSON.stringify(input),
      JSON.stringify(normalizedSnapshot),
      input.cancelledAt,
      invoiced,
    ],
  );
  const orderId = order.rows[0]!.id;
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
      })
    : order.rows[0]!.billing_case_id;
  await replaceOrderChildren(
    client,
    orderId,
    input,
    { lineAmounts, paymentAmounts, refundAmounts },
    invoiced,
  );
  await writeAudit(client, {
    ...auditActor(actor),
    action: previous.rows[0] ? "ORDER_SOURCE_UPDATED" : "ORDER_IMPORTED",
    eventClass: "OPERATIONAL",
    entityType: "ORDER",
    entityId: orderId,
    metadata: { provider: input.provider },
    requestId: actor.requestId,
  });
  if (!currentBillingCaseId && status === "ELIGIBLE") {
    await groupOrder(
      client,
      {
        id: orderId,
        customerId,
        customerSnapshot: normalizedSnapshot.customerSnapshot,
        localOrderDate: localDate,
        currency: input.currency,
      },
      actor,
    );
  }
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
    status: ReturnType<typeof triggerStatus>;
    revisionId: string;
    invoiced: boolean;
    billingCaseId: string | null;
  },
) {
  const { input, oldOrder, orderId, customerId, status, invoiced } = context;
  const reason = input.cancelledAt
    ? ("CANCELLED" as const)
    : input.paymentStatus === "REFUNDED"
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
    "lineAmounts" | "paymentAmounts" | "refundAmounts"
  >,
  invoiced: boolean,
) {
  const { lineAmounts, paymentAmounts, refundAmounts } = amounts;
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
        (order_id, external_payment_id, method, status, amount, paid_at, raw_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (order_id, external_payment_id) DO UPDATE SET
         method = EXCLUDED.method,
         status = EXCLUDED.status,
         amount = EXCLUDED.amount,
         paid_at = EXCLUDED.paid_at,
         raw_json = EXCLUDED.raw_json
       WHERE payments.recorded_manually = false`,
      [
        orderId,
        payment.externalPaymentId,
        payment.method,
        payment.status,
        paymentAmounts[index],
        payment.paidAt,
        JSON.stringify(payment),
      ],
    );
  }
  await client.query(
    `DELETE FROM refunds
     WHERE order_id = $1 AND NOT (external_refund_id = ANY($2::text[]))`,
    [orderId, input.refunds.map((refund) => refund.externalRefundId)],
  );
  for (const [index, refund] of input.refunds.entries()) {
    await client.query(
      `INSERT INTO refunds
        (provider, external_account_id, external_order_id, external_refund_id, order_id,
         status, amount, completed_at, raw_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (provider, external_account_id, external_order_id, external_refund_id)
       DO UPDATE SET status = EXCLUDED.status, amount = EXCLUDED.amount,
                     completed_at = EXCLUDED.completed_at, raw_json = EXCLUDED.raw_json,
                     updated_at = now()`,
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
      ],
    );
  }
}

export async function importOrders(input: unknown, actor: Actor, job?: ClaimedJob) {
  let orders: OrderInput[];
  try {
    orders = orderInputSchema.array().min(1).parse(input);
  } catch {
    throw new AppError("ORDER_INVALID_INPUT", 422);
  }
  const sourceKeys = orders.map((order) =>
    JSON.stringify([order.provider, order.externalAccountId, order.externalOrderId]),
  );
  if (new Set(sourceKeys).size !== sourceKeys.length) {
    throw new AppError("ORDER_INVALID_INPUT", 422);
  }
  return withTransaction(async (client) => {
    if (job) await assertJobLease(client, job);
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('setting:draft_trigger'))");
    await serializeOrderMutations(client);
    const trigger = await currentTrigger(client);
    const results = [];
    // Il batch resta seriale: ogni raggruppamento deve osservare gli ordini precedenti nella stessa transazione.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    for (const order of orders) results.push(await importOne(client, order, trigger, actor));
    if (job) await renewLockedJobLease(client, job);
    return {
      imported: results.filter((result) => result === "imported").length,
      updated: results.filter((result) => result === "updated").length,
      ignored: results.filter((result) => result === "ignored").length,
    };
  });
}
