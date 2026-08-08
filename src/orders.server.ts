import { createHash } from "node:crypto";

import type pg from "pg";

import { writeAudit } from "./audit.server.ts";
import { getPool, withTransaction } from "./db/client.server.ts";
import { AppError } from "./errors.ts";
import {
  customerIdentity,
  customerDisplayName,
  decimalToCents,
  draftTriggerSchema,
  localOrderDate,
  orderInputSchema,
  triggerStatus,
  type DraftTrigger,
  type OrderInput,
} from "./orders.ts";

interface Actor {
  id: number;
  requestId: string;
}

interface GroupableOrder {
  id: string;
  customerId: string;
  reviewRequired: boolean;
  customerSnapshot: Record<string, unknown>;
  localOrderDate: string;
  currency: string;
}

function customerSnapshot(input: OrderInput, identity: ReturnType<typeof customerIdentity>) {
  return {
    ...input.customer,
    displayName: customerDisplayName(input.customer) || "Cliente senza nome",
    taxIdentifiers: input.customer.taxIdentifiers.map(
      ({ sourceField: _, ...identifier }) => identifier,
    ),
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

function reviewFingerprint(
  input: OrderInput,
  identityKey: string,
  totalAmount: number,
  localDate: string,
  lineAmounts: { grossAmount: number; discountAmount: number }[],
  paymentAmounts: number[],
  shippingAmount: number,
) {
  const relevant = {
    totalAmount,
    localDate,
    paymentStatus: input.paymentStatus,
    fulfillmentStatus: input.fulfillmentStatus,
    cancelledAt: input.cancelledAt,
    customerIdentity: identityKey,
    customer: {
      ...input.customer,
      taxIdentifiers: input.customer.taxIdentifiers.map(
        ({ sourceField: _, ...identifier }) => identifier,
      ),
    },
    lines: input.lines.map((line, index) => ({ ...line, ...lineAmounts[index] })),
    payments: input.payments.map((payment, index) => ({
      ...payment,
      amount: paymentAmounts[index],
    })),
    shippingAmount,
  };
  return createHash("sha256").update(JSON.stringify(relevant)).digest("hex");
}

async function groupOrder(
  client: pg.PoolClient,
  order: GroupableOrder,
  actor: Actor,
  forced = false,
) {
  const lockKey = `billing-case:${order.customerId}:${order.localOrderDate}:${order.currency}`;
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);
  const existing = await client.query<{ id: string; same_customer_snapshot: boolean }>(
    `SELECT id, customer_snapshot_json = $4::jsonb AS same_customer_snapshot
     FROM billing_cases
     WHERE customer_id = $1 AND local_order_date = $2 AND currency = $3
       AND status IN ('DRAFT', 'NEEDS_REVIEW', 'READY')
     FOR UPDATE`,
    [
      order.customerId,
      order.localOrderDate,
      order.currency,
      JSON.stringify(order.customerSnapshot),
    ],
  );
  const desiredStatus =
    order.reviewRequired || existing.rows[0]?.same_customer_snapshot === false
      ? "NEEDS_REVIEW"
      : "READY";
  const billingCase = existing.rows[0]
    ? await client.query<{ id: string }>(
        `UPDATE billing_cases
         SET status = CASE WHEN status = 'NEEDS_REVIEW' OR $2 = 'NEEDS_REVIEW'
                           THEN 'NEEDS_REVIEW' ELSE 'READY' END,
             updated_at = now()
         WHERE id = $1
         RETURNING id`,
        [existing.rows[0].id, desiredStatus],
      )
    : await client.query<{ id: string }>(
        `INSERT INTO billing_cases
          (customer_id, local_order_date, currency, status, customer_snapshot_json)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [
          order.customerId,
          order.localOrderDate,
          order.currency,
          desiredStatus,
          JSON.stringify(order.customerSnapshot),
        ],
      );
  const caseId = billingCase.rows[0]!.id;
  if (!existing.rows[0]) {
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
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
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: forced ? "ORDER_GROUPING_FORCED" : "ORDER_GROUPED",
      eventClass: "CRITICAL",
      entityType: "ORDER",
      entityId: order.id,
      metadata: { billingCaseId: caseId },
      requestId: actor.requestId,
    });
  }
  return caseId;
}

async function currentTrigger(client: pg.PoolClient): Promise<DraftTrigger> {
  const result = await client.query<{ value_json: unknown }>(
    "SELECT value_json FROM settings WHERE key = 'draft_trigger'",
  );
  return draftTriggerSchema.parse(result.rows[0]?.value_json ?? "PAID");
}

async function importOne(
  client: pg.PoolClient,
  input: OrderInput,
  trigger: DraftTrigger,
  actor: Actor,
) {
  if (input.currency !== "EUR") throw new AppError("ORDER_CURRENCY_NOT_SUPPORTED", 422);
  const grossAmount = cents(input.total);
  if (grossAmount < 0) throw new AppError("ORDER_INVALID_INPUT", 422);
  const lineAmounts = input.lines.map((line) => ({
    grossAmount: cents(line.grossAmount),
    discountAmount: cents(line.discountAmount),
  }));
  const paymentAmounts = input.payments.map((payment) => cents(payment.amount));
  const shippingAmount = cents(input.shippingAmount);
  if (
    lineAmounts.some(({ grossAmount: amount, discountAmount }) =>
      [amount, discountAmount].some((value) => value < 0),
    ) ||
    paymentAmounts.some((amount) => amount < 0) ||
    shippingAmount < 0
  ) {
    throw new AppError("ORDER_INVALID_INPUT", 422);
  }
  const identity = customerIdentity(input);
  const totalsReconciled =
    lineAmounts.reduce((sum, line) => sum + BigInt(line.grossAmount - line.discountAmount), 0n) +
      BigInt(shippingAmount) ===
      BigInt(grossAmount) &&
    paymentAmounts.reduce((sum, amount) => sum + BigInt(amount), 0n) === BigInt(grossAmount);
  const localDate = localOrderDate(input.createdAt);
  const fingerprint = reviewFingerprint(
    input,
    identity.matchKey,
    grossAmount,
    localDate,
    lineAmounts,
    paymentAmounts,
    shippingAmount,
  );
  const status = triggerStatus(input, trigger);
  const preparationReviewRequired =
    identity.reviewRequired ||
    input.paymentStatus !== "PAID" ||
    input.payments.some((payment) => payment.status !== "PAID") ||
    !totalsReconciled;
  const previous = await client.query<{
    id: string;
    billing_case_id: string | null;
    review_fingerprint: string | null;
    updated_at_source: string;
    normalized_snapshot_json: Record<string, unknown>;
    billing_case_status: string | null;
  }>(
    `SELECT id, billing_case_id, updated_at_source::text, normalized_snapshot_json,
            normalized_snapshot_json ->> 'reviewFingerprint' AS review_fingerprint,
            (SELECT status FROM billing_cases WHERE id = orders.billing_case_id) AS billing_case_status
     FROM orders
     WHERE provider = $1 AND external_account_id = $2 AND external_order_id = $3
     FOR UPDATE`,
    [input.provider, input.externalAccountId, input.externalOrderId],
  );
  if (
    previous.rows[0] &&
    Date.parse(input.updatedAt) < Date.parse(previous.rows[0].updated_at_source)
  ) {
    return "ignored";
  }

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
      input.customer.displayName ?? "Cliente senza nome",
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
  const normalizedSnapshot = {
    ...input,
    customerSnapshot: customerSnapshot(input, identity),
    totalAmount: grossAmount,
    shippingAmount,
    localOrderDate: localDate,
    customerIdentity: identity.confidence,
    customerReviewRequired: identity.reviewRequired,
    preparationReviewRequired,
    totalsReconciled,
    reviewFingerprint: fingerprint,
  };
  const oldOrder = previous.rows[0];
  const invoiced = ["APPROVED", "CLOSED"].includes(oldOrder?.billing_case_status ?? "");
  const sourceConflict = Boolean(
    oldOrder?.billing_case_id && oldOrder.review_fingerprint !== fingerprint,
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
          JSON.stringify(oldOrder!.normalized_snapshot_json),
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
       display_number = EXCLUDED.display_number,
       updated_at_source = EXCLUDED.updated_at_source,
       local_order_date = EXCLUDED.local_order_date,
       gross_amount = EXCLUDED.gross_amount,
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
       raw_snapshot_json = EXCLUDED.raw_snapshot_json,
       normalized_snapshot_json = EXCLUDED.normalized_snapshot_json,
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
  if (sourceConflict) {
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
    const transitionedCase = await client.query(
      `UPDATE billing_cases
       SET status = $2,
           do_not_transmit_reason = $3,
           updated_at = now()
       WHERE id = $1 AND status IN ('DRAFT', 'READY', 'NEEDS_REVIEW')`,
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
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "ORDER_SOURCE_CONFLICT",
      eventClass: "CRITICAL",
      entityType: "ORDER",
      entityId: orderId,
      metadata: {
        billingCaseId: oldOrder!.billing_case_id!,
        revisionId: revision!.rows[0]!.id,
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
        metadata: { billingCaseId: oldOrder!.billing_case_id!, reason },
        requestId: actor.requestId,
      });
      const remainingOrders = await client.query<{
        id: string;
        customer_id: string;
        local_order_date: string;
        currency: string;
        review_required: boolean;
        customer_snapshot: Record<string, unknown>;
      }>(
        `UPDATE orders
         SET billing_case_id = NULL, trigger_status = 'ELIGIBLE'
         WHERE billing_case_id = $1 AND id <> $2
           AND cancelled_at IS NULL AND payment_status <> 'REFUNDED'
         RETURNING id, customer_id, local_order_date::text, currency,
           (normalized_snapshot_json ->> 'preparationReviewRequired')::boolean AS review_required,
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
            reviewRequired: remainingOrder.review_required,
            customerSnapshot: remainingOrder.customer_snapshot,
            localOrderDate: remainingOrder.local_order_date,
            currency: remainingOrder.currency,
          },
          actor,
        );
      }
    }
  }
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
  for (const identifier of input.customer.taxIdentifiers) {
    const value = identifier.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    await client.query(
      `INSERT INTO order_tax_identifiers
        (order_id, type, raw_value, normalized_value, source_field)
       VALUES ($1, $2, $3, $4, $5)`,
      [orderId, identifier.type, identifier.value, value, identifier.sourceField],
    );
  }
  await client.query("DELETE FROM payments WHERE order_id = $1", [orderId]);
  for (const [index, payment] of input.payments.entries()) {
    await client.query(
      `INSERT INTO payments
        (order_id, external_payment_id, method, status, amount, paid_at, raw_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
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
  await writeAudit(client, {
    actorType: "ADMIN",
    actorId: String(actor.id),
    action: previous.rows[0] ? "ORDER_SOURCE_UPDATED" : "ORDER_IMPORTED",
    eventClass: "OPERATIONAL",
    entityType: "ORDER",
    entityId: orderId,
    metadata: { provider: input.provider },
    requestId: actor.requestId,
  });
  if (!order.rows[0]!.billing_case_id && status === "ELIGIBLE") {
    await groupOrder(
      client,
      {
        id: orderId,
        customerId: order.rows[0]!.customer_id,
        reviewRequired: preparationReviewRequired,
        customerSnapshot: normalizedSnapshot.customerSnapshot,
        localOrderDate: localDate,
        currency: input.currency,
      },
      actor,
    );
  }
  return previous.rows[0] ? "updated" : "imported";
}

export async function importOrders(input: unknown, actor: Actor) {
  let orders: OrderInput[];
  try {
    orders = orderInputSchema.array().min(1).parse(input);
  } catch {
    throw new AppError("ORDER_INVALID_INPUT", 422);
  }
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('setting:draft_trigger'))");
    // ponytail: lock globale adatto al single tenant; usare lock ordinati per ordine se la concorrenza misurata lo richiede.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('order-import-batch'))");
    const trigger = await currentTrigger(client);
    const results = [];
    // Il batch resta seriale: ogni raggruppamento deve osservare gli ordini precedenti nella stessa transazione.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    for (const order of orders) results.push(await importOne(client, order, trigger, actor));
    return {
      imported: results.filter((result) => result === "imported").length,
      updated: results.filter((result) => result === "updated").length,
      ignored: results.filter((result) => result === "ignored").length,
    };
  });
}

export async function getDraftTrigger() {
  const result = await getPool().query<{ value_json: unknown; version: number }>(
    "SELECT value_json, version FROM settings WHERE key = 'draft_trigger'",
  );
  return {
    value: draftTriggerSchema.parse(result.rows[0]?.value_json ?? "PAID"),
    version: result.rows[0]?.version ?? 0,
  };
}

export async function setDraftTrigger(value: unknown, expectedVersion: number, actor: Actor) {
  const trigger = draftTriggerSchema.safeParse(value);
  if (!trigger.success) throw new AppError("ORDER_INVALID_INPUT", 422);
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('setting:draft_trigger'))");
    const setting = await client.query<{ version: number }>(
      "SELECT version FROM settings WHERE key = 'draft_trigger' FOR UPDATE",
    );
    if (setting.rows[0]?.version !== expectedVersion) {
      throw new AppError("CONFLICT_REVISION", 409);
    }
    const updated = await client.query<{ version: number }>(
      `UPDATE settings
       SET value_json = $1, version = version + 1, updated_at = now()
       WHERE key = 'draft_trigger'
       RETURNING version`,
      [JSON.stringify(trigger.data)],
    );
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "DRAFT_TRIGGER_CHANGED",
      eventClass: "CRITICAL",
      entityType: "SETTING",
      entityId: "draft_trigger",
      metadata: { value: trigger.data },
      requestId: actor.requestId,
    });
    const ungrouped = await client.query<{
      id: string;
      customer_id: string;
      review_required: boolean;
      customer_snapshot: Record<string, unknown>;
      local_order_date: string;
      currency: string;
      payment_status: OrderInput["paymentStatus"];
      fulfillment_status: OrderInput["fulfillmentStatus"];
      cancelled_at: string | null;
    }>(
      `SELECT orders.id, orders.customer_id,
              (orders.normalized_snapshot_json ->> 'preparationReviewRequired')::boolean AS review_required,
              orders.normalized_snapshot_json -> 'customerSnapshot' AS customer_snapshot,
              orders.local_order_date::text, orders.currency, orders.payment_status,
              orders.fulfillment_status, orders.cancelled_at
       FROM orders
       WHERE orders.billing_case_id IS NULL`,
    );
    for (const order of ungrouped.rows) {
      const status = triggerStatus(
        {
          cancelledAt: order.cancelled_at,
          paymentStatus: order.payment_status,
          fulfillmentStatus: order.fulfillment_status,
        },
        trigger.data,
      );
      const updatedOrder = await client.query(
        `UPDATE orders SET trigger_status = $2
         WHERE id = $1 AND billing_case_id IS NULL
         RETURNING id`,
        [order.id, status],
      );
      if (status === "ELIGIBLE" && updatedOrder.rowCount) {
        await groupOrder(
          client,
          {
            id: order.id,
            customerId: order.customer_id,
            reviewRequired: order.review_required,
            customerSnapshot: order.customer_snapshot,
            localOrderDate: order.local_order_date,
            currency: order.currency,
          },
          actor,
        );
      }
    }
    return { value: trigger.data, version: updated.rows[0]!.version };
  });
}

export async function forcePrepareOrder(id: string, actor: Actor) {
  if (!/^[1-9]\d*$/.test(id)) return null;
  return withTransaction(async (client) => {
    const identity = await client.query<{
      provider: string;
      external_account_id: string;
      external_order_id: string;
    }>("SELECT provider, external_account_id, external_order_id FROM orders WHERE id = $1", [id]);
    if (!identity.rows[0]) return null;
    const source = identity.rows[0];
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `order:${source.provider}:${source.external_account_id}:${source.external_order_id}`,
    ]);
    const order = await client.query<{
      id: string;
      customer_id: string;
      billing_case_id: string | null;
      review_required: boolean;
      customer_snapshot: Record<string, unknown>;
      local_order_date: string;
      currency: string;
      cancelled_at: string | null;
      payment_status: OrderInput["paymentStatus"];
    }>(
      `SELECT orders.id, orders.customer_id, orders.billing_case_id,
              (orders.normalized_snapshot_json ->> 'preparationReviewRequired')::boolean AS review_required,
              orders.normalized_snapshot_json -> 'customerSnapshot' AS customer_snapshot,
              orders.local_order_date::text,
              orders.currency, orders.cancelled_at, orders.payment_status
       FROM orders
       WHERE orders.id = $1
       FOR UPDATE OF orders`,
      [id],
    );
    const current = order.rows[0];
    if (!current) return null;
    if (current.billing_case_id) return current.billing_case_id;
    if (current.cancelled_at || current.payment_status === "REFUNDED") {
      throw new AppError("ORDER_NOT_PREPARABLE", 409);
    }
    return groupOrder(
      client,
      {
        id: current.id,
        customerId: current.customer_id,
        reviewRequired: current.review_required,
        customerSnapshot: current.customer_snapshot,
        localOrderDate: current.local_order_date,
        currency: current.currency,
      },
      actor,
      true,
    );
  });
}

export async function listOrders(filters: {
  query?: string;
  provider?: string;
  status?: string;
  localDate?: string;
  paymentStatus?: string;
}) {
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
            OR orders.normalized_snapshot_json #>> '{customerSnapshot,displayName}' ILIKE $1
            OR orders.normalized_snapshot_json #>> '{customerSnapshot,email}' ILIKE $1
            OR EXISTS (SELECT 1 FROM order_tax_identifiers
                       WHERE order_tax_identifiers.order_id = orders.id
                         AND order_tax_identifiers.normalized_value ILIKE $1))
       AND ($2::text IS NULL OR orders.provider = $2)
       AND ($3::text IS NULL
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
  if (!/^[1-9]\d*$/.test(id)) return null;
  const order = await getPool().query(
    `SELECT orders.*, orders.local_order_date::text,
            orders.normalized_snapshot_json #>> '{customerSnapshot,displayName}' AS customer_name,
            orders.normalized_snapshot_json #>> '{customerSnapshot,kind}' AS customer_kind,
            orders.normalized_snapshot_json #>> '{customerSnapshot,email}' AS customer_email,
            orders.normalized_snapshot_json #> '{customerSnapshot,billingAddress}' AS billing_address_json,
            orders.normalized_snapshot_json #>> '{customerSnapshot,sourceConfidence}' AS source_confidence,
            (orders.normalized_snapshot_json ->> 'customerReviewRequired')::boolean AS review_required,
            billing_cases.public_number AS case_number
     FROM orders
     LEFT JOIN billing_cases ON billing_cases.id = orders.billing_case_id
     WHERE orders.id = $1`,
    [id],
  );
  if (!order.rows[0]) return null;
  const [lines, taxes, payments] = await Promise.all([
    getPool().query("SELECT * FROM order_lines WHERE order_id = $1 ORDER BY id", [id]),
    getPool().query("SELECT * FROM order_tax_identifiers WHERE order_id = $1 ORDER BY id", [id]),
    getPool().query("SELECT * FROM payments WHERE order_id = $1 ORDER BY id", [id]),
  ]);
  return {
    ...order.rows[0],
    lines: lines.rows,
    taxIdentifiers: taxes.rows,
    payments: payments.rows,
  };
}

export async function listBillingCases() {
  const result = await getPool().query<{
    id: string;
    public_number: string;
    local_order_date: string;
    status: string;
    customer_name: string;
    order_count: string;
    total_amount: string;
  }>(
    `SELECT billing_cases.id, billing_cases.public_number, billing_cases.local_order_date::text,
            billing_cases.status,
            billing_cases.customer_snapshot_json ->> 'displayName' AS customer_name,
            count(orders.id)::text AS order_count, coalesce(sum(orders.gross_amount), 0)::text AS total_amount
     FROM billing_cases
     LEFT JOIN orders ON orders.billing_case_id = billing_cases.id
     GROUP BY billing_cases.id
     ORDER BY billing_cases.local_order_date DESC, billing_cases.id DESC`,
  );
  return result.rows;
}

export async function getBillingCase(id: string) {
  if (!/^[1-9]\d*$/.test(id)) return null;
  const billingCase = await getPool().query(
    `SELECT billing_cases.*, billing_cases.local_order_date::text,
            billing_cases.customer_snapshot_json ->> 'displayName' AS customer_name,
            billing_cases.customer_snapshot_json ->> 'email' AS customer_email,
            (billing_cases.customer_snapshot_json ->> 'reviewRequired')::boolean AS review_required,
            billing_cases.customer_snapshot_json -> 'billingAddress' AS billing_address_json
     FROM billing_cases
     WHERE billing_cases.id = $1`,
    [id],
  );
  if (!billingCase.rows[0]) return null;
  const [orders, audit, revisions] = await Promise.all([
    getPool().query(
      `SELECT id, provider, display_number, gross_amount, payment_status, fulfillment_status
       FROM orders WHERE billing_case_id = $1 ORDER BY id`,
      [id],
    ),
    getPool().query(
      `SELECT id, action, actor_id, metadata_json, created_at
       FROM audit_events
       WHERE (entity_type = 'BILLING_CASE' AND entity_id = $1)
          OR (entity_type = 'ORDER' AND metadata_json ->> 'billingCaseId' = $1)
       ORDER BY created_at DESC`,
      [id],
    ),
    getPool().query<{
      id: string;
      order_id: string;
      display_number: string;
      previous_normalized_snapshot_json: Record<string, unknown>;
      current_normalized_snapshot_json: Record<string, unknown>;
      created_at: string;
    }>(
      `SELECT order_source_revisions.*, orders.display_number
       FROM order_source_revisions
       JOIN orders ON orders.id = order_source_revisions.order_id
       WHERE order_source_revisions.billing_case_id = $1
       ORDER BY order_source_revisions.created_at DESC`,
      [id],
    ),
  ]);
  return {
    ...billingCase.rows[0],
    orders: orders.rows,
    audit: audit.rows,
    revisions: revisions.rows.map((revision) => ({
      ...revision,
      changedFields: Array.from(
        new Set([
          ...Object.keys(revision.previous_normalized_snapshot_json),
          ...Object.keys(revision.current_normalized_snapshot_json),
        ]),
      ).filter(
        (field) =>
          JSON.stringify(revision.previous_normalized_snapshot_json[field]) !==
          JSON.stringify(revision.current_normalized_snapshot_json[field]),
      ),
    })),
  };
}

export async function dashboardSummary() {
  const result = await getPool().query<{
    orders: string;
    ready_cases: string;
    review_cases: string;
    waiting_orders: string;
  }>(
    `SELECT
       (SELECT count(*) FROM orders)::text AS orders,
       (SELECT count(*) FROM billing_cases WHERE status = 'READY')::text AS ready_cases,
       (SELECT count(*) FROM billing_cases WHERE status = 'NEEDS_REVIEW')::text AS review_cases,
       (SELECT count(*) FROM orders WHERE trigger_status = 'WAITING_FOR_TRIGGER')::text AS waiting_orders`,
  );
  return result.rows[0]!;
}
