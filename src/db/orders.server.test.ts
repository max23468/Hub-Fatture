import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import { AppError } from "../errors.ts";
import {
  canonicalCustomerProfile,
  customerIdentity,
  decimalToCents,
  localOrderDate,
  orderInputSchema,
  PAGE_SIZE,
  type OrderInput,
} from "../orders.ts";
import { runMigrations } from "./migrations.server.ts";
import { temporaryDatabase, withClient } from "./database-fixture.ts";

async function waitForBlockedQuery(client: pg.Client) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await client.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database()
           AND pid <> pg_backend_pid()
           AND wait_event_type = 'Lock'
       ) AS waiting`,
    );
    if (waiting.rows[0]!.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Nessuna query bloccata nel database di test");
}

function canonicalTestTimestamp(value: string | null): string | null {
  if (!value) return null;
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1]?.replace(/0+$/, "");
  const instant = new Date(value).toISOString();
  const seconds = instant.slice(0, instant.indexOf("."));
  return fraction ? `${seconds}.${fraction}Z` : `${seconds}Z`;
}

function legacyReviewFingerprint(raw: OrderInput): string {
  const input = orderInputSchema.parse(raw);
  const lines = input.lines
    .map((line) => ({
      ...line,
      grossAmount: decimalToCents(line.grossAmount),
      discountAmount: decimalToCents(line.discountAmount),
    }))
    .sort((left, right) => left.externalLineId.localeCompare(right.externalLineId));
  const payments = input.payments
    .map((payment) => {
      const { shopifyPaymentsFeeAmount: _, ...legacyPayment } = payment;
      return {
        ...legacyPayment,
        amount: decimalToCents(payment.amount),
        paidAt: canonicalTestTimestamp(payment.paidAt),
      };
    })
    .sort((left, right) => left.externalPaymentId.localeCompare(right.externalPaymentId));
  const refunds = input.refunds
    .map((refund) => ({
      externalRefundId: refund.externalRefundId,
      status: refund.status,
      amount: refund.amount === null ? null : decimalToCents(refund.amount),
      completedAt: canonicalTestTimestamp(refund.completedAt),
    }))
    .sort((left, right) => left.externalRefundId.localeCompare(right.externalRefundId));
  return createHash("sha256")
    .update(
      JSON.stringify({
        displayNumber: input.displayNumber,
        totalAmount: decimalToCents(input.total),
        localDate: localOrderDate(input.createdAt),
        paymentStatus: input.paymentStatus,
        fulfillmentStatus: input.fulfillmentStatus,
        cancelledAt: canonicalTestTimestamp(input.cancelledAt),
        sourceReviewRequired: input.sourceReviewRequired,
        customerIdentity: customerIdentity(input).matchKey,
        customer: canonicalCustomerProfile(input),
        lines,
        payments,
        refunds,
        shippingAmount: decimalToCents(input.shippingAmount),
      }),
    )
    .digest("hex");
}

test("il dominio ordini resta coerente su PostgreSQL reale", { timeout: 30_000 }, async () => {
  const clean = await temporaryDatabase("orders");
  try {
    await runMigrations({ connectionString: clean.connectionString });
    process.env.APP_ENV = "test";
    process.env.APP_BASE_URL = "http://localhost:8080";
    process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
    process.env.DATABASE_URL = clean.connectionString;
    const orders = await import("./orders.server.ts");
    const refunds = await import("./refunds.server.ts");
    const database = await import("./client.server.ts");
    const caseRevision = async (caseId: string | number) =>
      (
        await database
          .getPool()
          .query<{ revision: number }>("SELECT revision FROM billing_cases WHERE id = $1", [
            String(caseId),
          ])
      ).rows[0]?.revision ?? 0;
    await database.getPool().query(
      `INSERT INTO connections
          (provider, environment, account_reference, encrypted_credentials, status, last_synced_at)
       VALUES
          ('SHOPIFY', 'DEVELOPMENT', 'revoked-shop.invalid', 'synthetic', 'REVOKED', now()),
          ('EBAY', 'SANDBOX', 'connected-ebay', 'synthetic', 'CONNECTED', now())`,
    );
    const connectionSummary = await orders.dashboardSummary();
    assert.equal(connectionSummary.shopify_connection_status, "REVOKED");
    assert.ok(connectionSummary.last_shopify_sync);
    assert.equal(connectionSummary.ebay_connection_status, "CONNECTED");
    assert.equal(connectionSummary.open_aruba_batches, "0");
    const fixture = JSON.parse(
      await readFile("tests/fixtures/orders/normalized.mock.json", "utf8"),
    );
    await assert.rejects(
      orders.importOrders([fixture[0], fixture[0]], {
        id: 1,
        requestId: "test-duplicate-order-in-batch",
      }),
      (error: unknown) => error instanceof AppError && error.code === "ORDER_INVALID_INPUT",
    );
    assert.deepEqual(
      await orders.importOrders(fixture, { id: 1, requestId: "test-order-import" }),
      { imported: 3, updated: 0, ignored: 0 },
    );
    assert.deepEqual(
      await orders.importOrders(fixture, { id: 1, requestId: "test-order-reimport" }),
      { imported: 0, updated: 3, ignored: 0 },
    );
    const feeOrder = structuredClone(fixture[0]);
    feeOrder.externalOrderId = "shop-order-shopify-payments-fee";
    feeOrder.displayNumber = "#S-FEE";
    feeOrder.createdAt = "2026-08-09T08:15:00Z";
    feeOrder.updatedAt = "2026-08-09T09:00:00Z";
    feeOrder.customer.taxIdentifiers[0].value = "VRDLGI80A01H501Z";
    feeOrder.payments[0].externalPaymentId = "shop-payment-fee";
    feeOrder.payments[0].method = "shopify_payments";
    feeOrder.payments[0].shopifyPaymentsFeeAmount = "2.57";
    await orders.importOrders([feeOrder], { id: 1, requestId: "test-shopify-payment-fee" });
    const feeState = async () =>
      (
        await database.getPool().query(
          `SELECT orders.gross_amount, orders.shopify_payments_fee_amount,
                  orders.deducted_shopify_payments_fee_amount, orders.billable_amount,
                  payments.shopify_payments_fee_amount AS payment_fee
           FROM orders JOIN payments ON payments.order_id = orders.id
           WHERE orders.external_order_id = $1`,
          [feeOrder.externalOrderId],
        )
      ).rows[0];
    assert.deepEqual(await feeState(), {
      gross_amount: 12_200,
      shopify_payments_fee_amount: 257,
      deducted_shopify_payments_fee_amount: 257,
      billable_amount: 11_943,
      payment_fee: 257,
    });
    const feeSetting = await orders.getShopifyPaymentFeeMode();
    assert.equal(feeSetting.value, "DEDUCT");
    await orders.setShopifyPaymentFeeMode("INCLUDE", feeSetting.version, {
      id: 1,
      requestId: "test-include-shopify-payment-fee",
    });
    assert.deepEqual(await feeState(), {
      gross_amount: 12_200,
      shopify_payments_fee_amount: 257,
      deducted_shopify_payments_fee_amount: 0,
      billable_amount: 12_200,
      payment_fee: 257,
    });
    const includedSetting = await orders.getShopifyPaymentFeeMode();
    await orders.setShopifyPaymentFeeMode("DEDUCT", includedSetting.version, {
      id: 1,
      requestId: "test-deduct-shopify-payment-fee",
    });
    assert.equal((await feeState()).billable_amount, 11_943);
    await database.getPool().query(
      `UPDATE orders
       SET normalized_snapshot_json = jsonb_set(normalized_snapshot_json, '{historical}', 'true'),
           historical_reconciliation_outcome = 'NOT_INVOICED',
           historical_reconciliation_reference = 'Riconciliazione storica chiusa nel test',
           historical_reconciled_at = now()
       WHERE external_order_id = $1`,
      [feeOrder.externalOrderId],
    );
    const closedHistorySetting = await orders.getShopifyPaymentFeeMode();
    await orders.setShopifyPaymentFeeMode("INCLUDE", closedHistorySetting.version, {
      id: 1,
      requestId: "test-closed-history-shopify-payment-fee",
    });
    assert.equal((await feeState()).billable_amount, 11_943);
    const restoredFeeSetting = await orders.getShopifyPaymentFeeMode();
    await orders.setShopifyPaymentFeeMode("DEDUCT", restoredFeeSetting.version, {
      id: 1,
      requestId: "test-restore-shopify-payment-fee-mode",
    });
    const feeCaseId = (
      await database
        .getPool()
        .query<{ billing_case_id: string | null }>(
          "SELECT billing_case_id::text FROM orders WHERE external_order_id = $1",
          [feeOrder.externalOrderId],
        )
    ).rows[0]!.billing_case_id;
    await database
      .getPool()
      .query("DELETE FROM orders WHERE external_order_id = $1", [feeOrder.externalOrderId]);
    if (feeCaseId) {
      await database.getPool().query("DELETE FROM billing_cases WHERE id = $1", [feeCaseId]);
    }
    await database
      .getPool()
      .query(`DELETE FROM audit_events WHERE request_id = ANY($1::text[])`, [
        [
          "test-shopify-payment-fee",
          "test-include-shopify-payment-fee",
          "test-deduct-shopify-payment-fee",
          "test-closed-history-shopify-payment-fee",
          "test-restore-shopify-payment-fee-mode",
        ],
      ]);
    const preFeeMigrationOrders = [
      {
        ...structuredClone(fixture[0]),
        externalOrderId: "shop-order-pre-fee-paypal",
        externalCustomerId: "shop-customer-pre-fee-paypal",
        displayNumber: "#PRE-FEE-PAYPAL",
        createdAt: "2026-09-10T08:00:00Z",
        updatedAt: "2026-09-10T09:00:00Z",
        customer: {
          ...structuredClone(fixture[0].customer),
          taxIdentifiers: [
            {
              ...structuredClone(fixture[0].customer.taxIdentifiers[0]),
              value: "RSSMRA80A01H501X",
            },
          ],
        },
        payments: [
          {
            ...structuredClone(fixture[0].payments[0]),
            externalPaymentId: "shop-payment-pre-fee-paypal",
            method: "paypal",
            paidAt: "2026-09-10T09:00:00Z",
          },
        ],
      },
      {
        ...structuredClone(fixture[1]),
        externalOrderId: "ebay-order-pre-fee",
        externalCustomerId: "ebay-customer-pre-fee",
        displayNumber: "E-PRE-FEE",
        createdAt: "2026-09-11T08:00:00Z",
        updatedAt: "2026-09-11T09:00:00Z",
        customer: {
          ...structuredClone(fixture[1].customer),
          taxIdentifiers: [
            {
              ...structuredClone(fixture[1].customer.taxIdentifiers[0]),
              value: "RSSMRA80A01H501Y",
            },
          ],
        },
        payments: [
          {
            ...structuredClone(fixture[1].payments[0]),
            externalPaymentId: "ebay-payment-pre-fee",
            paidAt: "2026-09-11T09:00:00Z",
          },
        ],
      },
    ];
    for (const candidate of preFeeMigrationOrders) {
      await orders.importOrders([candidate], {
        id: 1,
        requestId: `test-${candidate.externalOrderId}-initial`,
      });
      const storedOrder = (
        await database
          .getPool()
          .query<{ id: string; billing_case_id: string }>(
            `SELECT id, billing_case_id FROM orders WHERE external_order_id = $1`,
            [candidate.externalOrderId],
          )
      ).rows[0]!;
      await database.getPool().query(
        `UPDATE orders
         SET normalized_snapshot_json = jsonb_set(
           normalized_snapshot_json #- '{payments,0,shopifyPaymentsFeeAmount}',
           '{reviewFingerprint}', to_jsonb($2::text)
         )
         WHERE id = $1`,
        [storedOrder.id, legacyReviewFingerprint(candidate)],
      );
      candidate.updatedAt = candidate.updatedAt.replace("09:00:00Z", "10:00:00Z");
      await orders.importOrders([candidate], {
        id: 1,
        requestId: `test-${candidate.externalOrderId}-unchanged`,
      });
      assert.deepEqual(
        (
          await database.getPool().query(
            `SELECT billing_cases.status,
                    count(order_source_revisions.id)::int AS revision_count
             FROM orders
             JOIN billing_cases ON billing_cases.id = orders.billing_case_id
             LEFT JOIN order_source_revisions ON order_source_revisions.order_id = orders.id
             WHERE orders.id = $1
             GROUP BY billing_cases.status`,
            [storedOrder.id],
          )
        ).rows[0],
        { status: "READY", revision_count: 0 },
      );
    }
    const preFeeRows = await database.getPool().query<{
      id: string;
      billing_case_id: string;
      customer_id: string;
    }>(
      `SELECT id, billing_case_id, customer_id FROM orders
       WHERE external_order_id = ANY($1::text[])`,
      [preFeeMigrationOrders.map((candidate) => candidate.externalOrderId)],
    );
    await database
      .getPool()
      .query("DELETE FROM orders WHERE id = ANY($1::bigint[])", [
        preFeeRows.rows.map((row) => row.id),
      ]);
    await database
      .getPool()
      .query("DELETE FROM billing_cases WHERE id = ANY($1::bigint[])", [
        preFeeRows.rows.map((row) => row.billing_case_id),
      ]);
    await database
      .getPool()
      .query("DELETE FROM customer_source_records WHERE external_customer_id = ANY($1::text[])", [
        preFeeMigrationOrders.map((candidate) => candidate.externalCustomerId),
      ]);
    await database
      .getPool()
      .query("DELETE FROM customers WHERE id = ANY($1::bigint[])", [
        preFeeRows.rows.map((row) => row.customer_id),
      ]);
    await database.getPool().query(
      `DELETE FROM audit_events
       WHERE request_id = ANY($1::text[])`,
      [
        preFeeMigrationOrders.flatMap((candidate) => [
          `test-${candidate.externalOrderId}-initial`,
          `test-${candidate.externalOrderId}-unchanged`,
        ]),
      ],
    );
    await database.getPool().query(
      `INSERT INTO payments
          (order_id, external_payment_id, method, status, amount, paid_at,
           recorded_manually, raw_json)
         SELECT id, 'manual-payment', 'Contanti', 'PAID', 100, now(), true, '{}'::jsonb
         FROM orders WHERE external_order_id = $1`,
      [fixture[0].externalOrderId],
    );
    await orders.importOrders([fixture[0]], {
      id: 1,
      requestId: "test-manual-payment-preserved",
    });
    assert.equal(
      (
        await database.getPool().query(
          `SELECT count(*) FROM payments
             JOIN orders ON orders.id = payments.order_id
             WHERE orders.external_order_id = $1 AND payments.recorded_manually = true`,
          [fixture[0].externalOrderId],
        )
      ).rows[0].count,
      "1",
    );
    const snapshotOrder = (
      await database
        .getPool()
        .query("SELECT id, billing_case_id FROM orders WHERE external_order_id = $1", [
          fixture[0].externalOrderId,
        ])
    ).rows[0];
    let orderDetailPromise: ReturnType<typeof orders.getOrder> | undefined;
    await withClient(clean.connectionString, async (orderBlocker) => {
      await orderBlocker.query("BEGIN");
      await orderBlocker.query("LOCK TABLE order_lines IN ACCESS EXCLUSIVE MODE");
      orderDetailPromise = orders.getOrder(String(snapshotOrder.id));
      await waitForBlockedQuery(orderBlocker);
      await orderBlocker.query("UPDATE orders SET gross_amount = 12345 WHERE id = $1", [
        snapshotOrder.id,
      ]);
      await orderBlocker.query("UPDATE order_lines SET gross_amount = 12345 WHERE order_id = $1", [
        snapshotOrder.id,
      ]);
      await orderBlocker.query("COMMIT");
    });
    const snapshotOrderDetail = await orderDetailPromise;
    assert.equal(
      snapshotOrderDetail!.gross_amount,
      snapshotOrderDetail!.lines.reduce(
        (total: number, line: { gross_amount: number }) => total + line.gross_amount,
        0,
      ),
    );
    await database
      .getPool()
      .query("UPDATE orders SET gross_amount = 12200 WHERE id = $1", [snapshotOrder.id]);
    await database
      .getPool()
      .query("UPDATE order_lines SET gross_amount = 12200 WHERE order_id = $1", [snapshotOrder.id]);

    let caseDetailPromise: ReturnType<typeof orders.getBillingCase> | undefined;
    await withClient(clean.connectionString, async (auditBlocker) => {
      await auditBlocker.query("BEGIN");
      await auditBlocker.query("LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE");
      caseDetailPromise = orders.getBillingCase(String(snapshotOrder.billing_case_id));
      await waitForBlockedQuery(auditBlocker);
      await auditBlocker.query("UPDATE billing_cases SET status = 'NEEDS_REVIEW' WHERE id = $1", [
        snapshotOrder.billing_case_id,
      ]);
      await auditBlocker.query(
        `INSERT INTO audit_events
            (actor_type, action, event_class, entity_type, entity_id, request_id)
           VALUES ('SYSTEM', 'BILLING_CASE_REACTIVATED', 'CRITICAL',
                   'BILLING_CASE', $1, 'test-snapshot-marker')`,
        [snapshotOrder.billing_case_id],
      );
      await auditBlocker.query("COMMIT");
    });
    const snapshotCaseDetail = await caseDetailPromise;
    assert.equal(snapshotCaseDetail!.status, "NEEDS_REVIEW");
    assert.ok(
      snapshotCaseDetail!.audit.some(
        (event: { request_id: string }) => event.request_id === "test-snapshot-marker",
      ),
    );
    await database
      .getPool()
      .query("UPDATE billing_cases SET status = 'READY' WHERE id = $1", [
        snapshotOrder.billing_case_id,
      ]);
    await database
      .getPool()
      .query("DELETE FROM audit_events WHERE request_id = 'test-snapshot-marker'");

    await withClient(clean.connectionString, async (client) => {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('setting:draft_trigger'))");
      let completed = false;
      const blockedImport = orders
        .importOrders([fixture[0]], { id: 1, requestId: "test-trigger-lock" })
        .finally(() => {
          completed = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 75));
      assert.equal(completed, false);
      await client.query("COMMIT");
      assert.deepEqual(await blockedImport, { imported: 0, updated: 1, ignored: 0 });
    });
    assert.equal(await orders.getOrder("non-numerico"), null);
    assert.equal(await orders.getBillingCase("0"), null);
    assert.deepEqual((await orders.listOrders({ query: "test\0non valido" })).rows, []);
    assert.deepEqual((await orders.listOrders({ localDate: "0000-01-01" })).rows, []);
    const outOfRangeId = "9223372036854775808";
    assert.deepEqual(
      await Promise.all([
        orders.getOrder(outOfRangeId),
        orders.getBillingCase(outOfRangeId),
        orders.forcePrepareOrder(outOfRangeId, { id: 1, requestId: "test-invalid-order-id" }),
        orders.updateBillingCaseTransmission(outOfRangeId, null, 0, {
          id: 1,
          requestId: "test-invalid-case-id",
        }),
      ]),
      [null, null, null, null],
    );
    assert.equal(typeof (await orders.getOrder("1"))?.local_order_date, "string");
    assert.equal(
      (await database.getPool().query("SELECT count(*) FROM orders")).rows[0].count,
      "3",
    );
    assert.equal(
      (await database.getPool().query("SELECT count(*) FROM billing_cases")).rows[0].count,
      "1",
    );
    assert.equal(
      (
        await database
          .getPool()
          .query(
            "SELECT count(DISTINCT billing_case_id) FROM orders WHERE external_order_id IN ('shop-order-1001', 'ebay-order-2001')",
          )
      ).rows[0].count,
      "1",
    );
    assert.equal((await orders.listOrders({ paymentStatus: "PENDING" })).rows.length, 1);
    assert.equal((await orders.listOrders({ query: "shop-order-1001" })).rows.length, 1);
    const waitingOrderId = (
      await database
        .getPool()
        .query("SELECT id FROM orders WHERE external_order_id = 'shop-order-1002'")
    ).rows[0].id;
    const forcedCaseId = await orders.forcePrepareOrder(waitingOrderId, {
      id: 1,
      requestId: "test-force-prepare",
    });
    assert.equal(
      await orders.forcePrepareOrder(waitingOrderId, {
        id: 1,
        requestId: "test-force-prepare-idempotent",
      }),
      forcedCaseId,
    );
    assert.deepEqual(
      await orders.setDraftTrigger("FULFILLED", 1, {
        id: 1,
        requestId: "test-trigger-change",
      }),
      { value: "FULFILLED", version: 2 },
    );
    await assert.rejects(
      orders.setDraftTrigger("PAID", Number.POSITIVE_INFINITY, {
        id: 1,
        requestId: "test-trigger-invalid-version",
      }),
      /I dati dell’ordine non sono validi/,
    );
    await assert.rejects(
      orders.setDraftTrigger("PAID", 2_147_483_648, {
        id: 1,
        requestId: "test-trigger-version-overflow",
      }),
      /I dati dell’ordine non sono validi/,
    );
    assert.equal(
      (await database.getPool().query("SELECT count(*) FROM billing_cases")).rows[0].count,
      "2",
    );
    assert.equal(
      (
        await database
          .getPool()
          .query("SELECT bool_and(public_number ~ '^[0-9]{6}$') AS valid FROM billing_cases")
      ).rows[0].valid,
      true,
    );
    assert.equal(
      (
        await database
          .getPool()
          .query("SELECT count(*) FROM billing_cases WHERE status = 'NEEDS_REVIEW'")
      ).rows[0].count,
      "1",
    );
    await assert.rejects(
      orders.setDraftTrigger("PAID", 1, { id: 1, requestId: "test-stale-trigger" }),
      /I dati sono cambiati/,
    );
    const unsupported = structuredClone(fixture);
    unsupported[0].externalOrderId = "shop-order-usd";
    unsupported[0].currency = "USD";
    const validBeforeInvalid = structuredClone(fixture[0]);
    validBeforeInvalid.externalOrderId = "shop-order-rolled-back";
    await assert.rejects(
      orders.importOrders([validBeforeInvalid, unsupported[0]], {
        id: 1,
        requestId: "test-usd",
      }),
      /soltanto ordini in euro/,
    );
    assert.equal(
      (await database.getPool().query("SELECT count(*) FROM orders")).rows[0].count,
      "3",
    );
    assert.equal(
      (
        await database
          .getPool()
          .query("SELECT count(*) FROM orders WHERE external_order_id = 'shop-order-rolled-back'")
      ).rows[0].count,
      "0",
    );
    assert.equal(
      (
        await database
          .getPool()
          .query(
            "SELECT count(*) FROM audit_events WHERE action IN ('ORDER_IMPORTED', 'ORDER_GROUPED', 'DRAFT_TRIGGER_CHANGED')",
          )
      ).rows[0].count,
      "6",
    );
    assert.equal(
      (
        await database
          .getPool()
          .query("SELECT count(*) FROM audit_events WHERE action = 'ORDER_GROUPING_FORCED'")
      ).rows[0].count,
      "1",
    );
    const approvedGroup = [structuredClone(fixture[0]), structuredClone(fixture[1])];
    approvedGroup[0].externalOrderId = "shop-order-approved-1";
    approvedGroup[1].externalOrderId = "ebay-order-approved-2";
    for (const approvedOrder of approvedGroup) {
      approvedOrder.createdAt = "2026-08-12T08:00:00Z";
      approvedOrder.updatedAt = "2026-08-12T09:00:00Z";
    }
    approvedGroup[1].paymentStatus = "PENDING";
    approvedGroup[1].payments[0].status = "PENDING";
    await orders.importOrders(approvedGroup, { id: 1, requestId: "test-approved-group" });
    const approvedCaseId = (
      await database
        .getPool()
        .query("SELECT billing_case_id FROM orders WHERE external_order_id = $1", [
          approvedGroup[0].externalOrderId,
        ])
    ).rows[0].billing_case_id;
    await database
      .getPool()
      .query("UPDATE billing_cases SET status = 'APPROVED' WHERE id = $1", [approvedCaseId]);
    approvedGroup[1].lines[0].description = "Descrizione aggiornata dopo l’emissione";
    approvedGroup[1].paymentStatus = "PAID";
    approvedGroup[1].payments[0].status = "PAID";
    approvedGroup[1].total = "130.00";
    approvedGroup[1].lines[0].grossAmount = "130.00";
    approvedGroup[1].payments[0].amount = "130.00";
    approvedGroup[1].customer.displayName = "Cliente modificato dopo l’emissione";
    approvedGroup[1].updatedAt = "2026-08-12T09:30:00Z";
    await orders.importOrders([approvedGroup[1]], {
      id: 1,
      requestId: "test-approved-non-refund-conflict",
    });
    assert.equal(
      (
        await database
          .getPool()
          .query("SELECT trigger_status FROM orders WHERE external_order_id = $1", [
            approvedGroup[1].externalOrderId,
          ])
      ).rows[0].trigger_status,
      "INVOICED",
    );
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT orders.gross_amount, orders.payment_status,
                    (SELECT gross_amount FROM order_lines WHERE order_id = orders.id) AS line_amount,
                    (SELECT amount FROM payments WHERE order_id = orders.id) AS payment_amount,
                    (SELECT status FROM payments WHERE order_id = orders.id) AS payment_row_status,
                    customers.display_name
             FROM orders JOIN customers ON customers.id = orders.customer_id
             WHERE orders.external_order_id = $1`,
          [approvedGroup[1].externalOrderId],
        )
      ).rows[0],
      {
        gross_amount: 7500,
        payment_status: "PAID",
        line_amount: 7500,
        payment_amount: 13000,
        payment_row_status: "PAID",
        display_name: "Mario Rossi",
      },
    );
    approvedGroup[1].updatedAt = "2026-08-12T09:45:00Z";
    await orders.importOrders([approvedGroup[1]], {
      id: 1,
      requestId: "test-approved-identical-reimport",
    });
    assert.equal(
      (
        await database.getPool().query(
          `SELECT count(*) FROM order_source_revisions
             JOIN orders ON orders.id = order_source_revisions.order_id
             WHERE orders.external_order_id = $1`,
          [approvedGroup[1].externalOrderId],
        )
      ).rows[0].count,
      "1",
    );
    approvedGroup[1].payments = [
      {
        ...approvedGroup[1].payments[0],
        externalPaymentId: "replacement-payment",
        method: "BANK_TRANSFER",
      },
    ];
    approvedGroup[1].updatedAt = "2026-08-12T09:50:00Z";
    await orders.importOrders([approvedGroup[1]], {
      id: 1,
      requestId: "test-approved-replaced-payment",
    });
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT payments.external_payment_id, payments.method, payments.amount
               FROM payments JOIN orders ON orders.id = payments.order_id
               WHERE orders.external_order_id = $1`,
          [approvedGroup[1].externalOrderId],
        )
      ).rows,
      [{ external_payment_id: "replacement-payment", method: "BANK_TRANSFER", amount: 13000 }],
    );
    approvedGroup[0].paymentStatus = "REFUNDED";
    approvedGroup[0].payments[0].status = "REFUNDED";
    approvedGroup[0].updatedAt = "2026-08-12T10:00:00Z";
    await orders.importOrders([approvedGroup[0]], {
      id: 1,
      requestId: "test-approved-source-conflict",
    });
    const preservedApprovedGroup = await database.getPool().query(
      `SELECT billing_cases.status, count(*)::int AS order_count
           FROM billing_cases JOIN orders ON orders.billing_case_id = billing_cases.id
           WHERE billing_cases.id = $1 GROUP BY billing_cases.status`,
      [approvedCaseId],
    );
    assert.equal(preservedApprovedGroup.rows[0].status, "APPROVED");
    assert.equal(preservedApprovedGroup.rows[0].order_count, 2);
    assert.equal(
      (
        await database
          .getPool()
          .query("SELECT trigger_status FROM orders WHERE external_order_id = $1", [
            approvedGroup[0].externalOrderId,
          ])
      ).rows[0].trigger_status,
      "INVOICED",
    );
    assert.equal(
      (
        await database
          .getPool()
          .query("SELECT count(*) FROM audit_events WHERE action = 'BILLING_CASE_DO_NOT_TRANSMIT'")
      ).rows[0].count,
      "0",
    );
    const sourceChanged = structuredClone(fixture[0]);
    sourceChanged.paymentStatus = "REFUNDED";
    sourceChanged.payments[0].status = "REFUNDED";
    sourceChanged.updatedAt = "2026-08-08T10:00:00Z";
    await orders.importOrders([sourceChanged], {
      id: 1,
      requestId: "test-source-conflict",
    });
    const conflictedCase = (
      await database.getPool().query(
        `SELECT billing_cases.id, orders.id AS order_id, billing_cases.status, customers.review_required
             FROM billing_cases
             JOIN customers ON customers.id = billing_cases.customer_id
             JOIN orders ON orders.billing_case_id = billing_cases.id
             WHERE orders.external_order_id = 'shop-order-1001'`,
      )
    ).rows[0];
    assert.equal(conflictedCase.status, "DO_NOT_TRANSMIT");
    assert.equal(conflictedCase.review_required, false);
    assert.equal((await orders.getBillingCase(conflictedCase.id))?.status, "DO_NOT_TRANSMIT");
    assert.equal(
      (await orders.listOrders({ status: "ACTIVE" })).rows.some(
        (order) => order.id === conflictedCase.order_id,
      ),
      false,
    );
    assert.equal(
      (await orders.listOrders({ status: "NO_DOCUMENT" })).rows.some(
        (order) => order.id === conflictedCase.order_id,
      ),
      true,
    );
    const regroupedOrder = (
      await database.getPool().query(
        `SELECT orders.billing_case_id, orders.trigger_status, billing_cases.status
             FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
             WHERE orders.external_order_id = 'ebay-order-2001'`,
      )
    ).rows[0];
    assert.notEqual(regroupedOrder.billing_case_id, conflictedCase.id);
    assert.equal(regroupedOrder.trigger_status, "GROUPED");
    assert.equal(regroupedOrder.status, "READY");
    assert.equal(
      (
        await database
          .getPool()
          .query("SELECT count(*) FROM audit_events WHERE action = 'ORDER_SOURCE_CONFLICT'")
      ).rows[0].count,
      "4",
    );
    assert.equal(
      (
        await database.getPool().query(
          `SELECT count(*) FROM order_source_revisions
             WHERE billing_case_id = $1
               AND previous_normalized_snapshot_json ->> 'paymentStatus' = 'PAID'
               AND current_normalized_snapshot_json ->> 'paymentStatus' = 'REFUNDED'`,
          [conflictedCase.id],
        )
      ).rows[0].count,
      "1",
    );
    assert.equal(
      (
        await database
          .getPool()
          .query(`SELECT do_not_transmit_reason FROM billing_cases WHERE id = $1`, [
            conflictedCase.id,
          ])
      ).rows[0].do_not_transmit_reason,
      "Ordine rimborsato prima dell’emissione",
    );
    assert.deepEqual(
      await orders.importOrders([fixture[0]], {
        id: 1,
        requestId: "test-stale-source-update",
      }),
      { imported: 0, updated: 0, ignored: 1 },
    );
    const preservedSource = (
      await database.getPool().query(
        `SELECT updated_at_source::text, payment_status, trigger_status
             FROM orders WHERE external_order_id = 'shop-order-1001'`,
      )
    ).rows[0];
    assert.equal(preservedSource.payment_status, "REFUNDED");
    assert.equal(preservedSource.trigger_status, "REFUNDED_BEFORE_ISSUE");
    assert.match(preservedSource.updated_at_source, /^2026-08-08 10:00:00/);
    await database.getPool().query(
      `UPDATE orders SET updated_at_source = '2026-08-08T10:00:00.123457Z'
         WHERE external_order_id = 'shop-order-1001'`,
    );
    const staleMicrosecond = structuredClone(sourceChanged);
    staleMicrosecond.paymentStatus = "PAID";
    staleMicrosecond.payments[0].status = "PAID";
    staleMicrosecond.updatedAt = "2026-08-08T10:00:00.123456Z";
    assert.deepEqual(
      await orders.importOrders([staleMicrosecond], {
        id: 1,
        requestId: "test-stale-source-microsecond",
      }),
      { imported: 0, updated: 0, ignored: 1 },
    );
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT updated_at_source::text, payment_status
             FROM orders WHERE external_order_id = 'shop-order-1001'`,
        )
      ).rows[0],
      { updated_at_source: "2026-08-08 10:00:00.123457+00", payment_status: "REFUNDED" },
    );
    const reactivatedPending = structuredClone(sourceChanged);
    reactivatedPending.paymentStatus = "PENDING";
    reactivatedPending.fulfillmentStatus = "UNFULFILLED";
    reactivatedPending.payments[0].status = "PENDING";
    reactivatedPending.payments[0].paidAt = null;
    reactivatedPending.updatedAt = "2026-08-08T11:00:00Z";
    await orders.importOrders([reactivatedPending], {
      id: 1,
      requestId: "test-reactivated-pending",
    });
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT billing_case_id, trigger_status,
                    normalized_snapshot_json ->> 'deferredReviewRequired' AS deferred_review
               FROM orders WHERE external_order_id = $1`,
          [reactivatedPending.externalOrderId],
        )
      ).rows[0],
      { billing_case_id: null, trigger_status: "WAITING_FOR_TRIGGER", deferred_review: "true" },
    );
    reactivatedPending.paymentStatus = "PAID";
    reactivatedPending.fulfillmentStatus = "FULFILLED";
    reactivatedPending.payments[0].status = "PAID";
    reactivatedPending.payments[0].paidAt = "2026-08-08T12:00:00Z";
    reactivatedPending.updatedAt = "2026-08-08T12:00:00Z";
    await orders.importOrders([reactivatedPending], {
      id: 1,
      requestId: "test-reactivated-paid",
    });
    assert.equal(
      (
        await database.getPool().query(
          `SELECT billing_cases.status
               FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
               WHERE orders.external_order_id = $1`,
          [reactivatedPending.externalOrderId],
        )
      ).rows[0].status,
      "NEEDS_REVIEW",
    );
    const invalidAmount = structuredClone(fixture[1]);
    invalidAmount.externalOrderId = "ebay-invalid-amount";
    invalidAmount.lines[0].grossAmount = "12.345";
    await assert.rejects(
      orders.importOrders([invalidAmount], { id: 1, requestId: "test-invalid-amount" }),
      (error: unknown) => error instanceof AppError && error.code === "ORDER_INVALID_INPUT",
    );
    const excessiveDiscount = structuredClone(fixture[1]);
    excessiveDiscount.externalOrderId = "ebay-invalid-discount";
    excessiveDiscount.lines[0].discountAmount = "75.01";
    await assert.rejects(
      orders.importOrders([excessiveDiscount], {
        id: 1,
        requestId: "test-invalid-discount",
      }),
      (error: unknown) => error instanceof AppError && error.code === "ORDER_INVALID_INPUT",
    );
    const excessiveQuantity = structuredClone(fixture[1]);
    excessiveQuantity.externalOrderId = "ebay-invalid-quantity";
    excessiveQuantity.lines[0].quantity = 2_147_483_648;
    await assert.rejects(
      orders.importOrders([excessiveQuantity], {
        id: 1,
        requestId: "test-invalid-quantity",
      }),
      (error: unknown) => error instanceof AppError && error.code === "ORDER_INVALID_INPUT",
    );
    const nullByteText = structuredClone(fixture[1]);
    nullByteText.externalOrderId = "ebay-invalid-null-byte";
    nullByteText.lines[0].description = "Test\0non persistibile";
    await assert.rejects(
      orders.importOrders([nullByteText], { id: 1, requestId: "test-invalid-null-byte" }),
      (error: unknown) => error instanceof AppError && error.code === "ORDER_INVALID_INPUT",
    );
    const invalidTimestamp = structuredClone(fixture[1]);
    invalidTimestamp.externalOrderId = "ebay-invalid-timestamp";
    invalidTimestamp.createdAt = "0000-01-01T00:00:00Z";
    await assert.rejects(
      orders.importOrders([invalidTimestamp], { id: 1, requestId: "test-invalid-timestamp" }),
      (error: unknown) => error instanceof AppError && error.code === "ORDER_INVALID_INPUT",
    );
    await assert.rejects(
      orders.updateBillingCaseTransmission("1", "Test\0non persistibile", await caseRevision("1"), {
        id: 1,
        requestId: "test-invalid-reason-null-byte",
      }),
      (error: unknown) => error instanceof AppError && error.code === "ORDER_INVALID_INPUT",
    );
    const cancelled = structuredClone(fixture[2]);
    cancelled.externalOrderId = "shop-order-cancelled";
    cancelled.cancelledAt = "2026-08-08T11:00:00Z";
    const pendingBeforeCancelled = (await orders.dashboardSummary()).pending_payments;
    await orders.importOrders([cancelled], { id: 1, requestId: "test-cancelled" });
    assert.equal((await orders.dashboardSummary()).pending_payments, pendingBeforeCancelled);
    const cancelledId = (
      await database
        .getPool()
        .query("SELECT id FROM orders WHERE external_order_id = 'shop-order-cancelled'")
    ).rows[0].id;
    await assert.rejects(
      orders.forcePrepareOrder(cancelledId, { id: 1, requestId: "test-force-cancelled" }),
      (error: unknown) => error instanceof AppError && error.code === "ORDER_NOT_PREPARABLE",
    );
    const refunded = structuredClone(fixture[2]);
    refunded.externalOrderId = "shop-order-refunded";
    refunded.paymentStatus = "REFUNDED";
    refunded.payments = [];
    await orders.importOrders([refunded], { id: 1, requestId: "test-refunded" });
    const refundedId = (
      await database
        .getPool()
        .query("SELECT id FROM orders WHERE external_order_id = 'shop-order-refunded'")
    ).rows[0].id;
    await assert.rejects(
      orders.forcePrepareOrder(refundedId, { id: 1, requestId: "test-force-refunded" }),
      (error: unknown) => error instanceof AppError && error.code === "ORDER_NOT_PREPARABLE",
    );
    refunded.createdAt = "2026-08-09T08:00:00Z";
    refunded.updatedAt = "2026-08-09T09:00:00Z";
    await orders.importOrders([refunded], { id: 1, requestId: "test-corrected-created-at" });
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT created_at_source = $2::timestamptz AS created_at_matches,
                    local_order_date::text
               FROM orders WHERE external_order_id = $1`,
          [refunded.externalOrderId, refunded.createdAt],
        )
      ).rows[0],
      { created_at_matches: true, local_order_date: "2026-08-09" },
    );
    const pendingPaymentsBefore = Number((await orders.dashboardSummary()).pending_payments);
    const pendingPayment = structuredClone(fixture[0]);
    pendingPayment.externalOrderId = "shop-order-pending-payment";
    pendingPayment.externalCustomerId = "shop-customer-pending-payment";
    pendingPayment.customer.taxIdentifiers[0].value = "RSSMRA80A01H501W";
    pendingPayment.paymentStatus = "PAID";
    pendingPayment.payments[0].status = "PENDING";
    pendingPayment.payments[0].paidAt = null;
    pendingPayment.createdAt = "2026-08-11T08:15:00Z";
    pendingPayment.updatedAt = "2026-08-11T09:00:00Z";
    await orders.importOrders([pendingPayment], {
      id: 1,
      requestId: "test-pending-payment",
    });
    assert.equal(
      (
        await database.getPool().query(
          `SELECT billing_cases.status
               FROM billing_cases JOIN orders ON orders.billing_case_id = billing_cases.id
               WHERE orders.external_order_id = 'shop-order-pending-payment'`,
        )
      ).rows[0].status,
      "NEEDS_REVIEW",
    );
    assert.equal(
      Number((await orders.dashboardSummary()).pending_payments),
      pendingPaymentsBefore + 1,
    );
    assert.ok(
      (await orders.listOrders({ status: "ACTIVE", paymentStatus: "PENDING" })).rows.some(
        (order) => order.display_number === pendingPayment.displayNumber,
      ),
    );
    const incompleteCustomer = structuredClone(fixture[0]);
    incompleteCustomer.externalOrderId = "shop-order-incomplete-customer";
    incompleteCustomer.externalCustomerId = "shop-customer-incomplete";
    incompleteCustomer.customer.taxIdentifiers[0].value = "RSSMRA80A01H501V";
    incompleteCustomer.customer.billingAddress = {};
    incompleteCustomer.updatedAt = "2026-08-08T12:00:00Z";
    assert.deepEqual(
      await orders.importOrders([incompleteCustomer], {
        id: 1,
        requestId: "test-incomplete-customer",
      }),
      { imported: 1, updated: 0, ignored: 0 },
    );
    assert.equal(
      (
        await database.getPool().query(
          `SELECT billing_cases.status
               FROM billing_cases JOIN orders ON orders.billing_case_id = billing_cases.id
               WHERE orders.external_order_id = 'shop-order-incomplete-customer'`,
        )
      ).rows[0].status,
      "NEEDS_REVIEW",
    );
    const completedCustomer = structuredClone(incompleteCustomer);
    completedCustomer.externalOrderId = "shop-order-completed-customer";
    completedCustomer.createdAt = "2026-08-09T08:15:00Z";
    completedCustomer.updatedAt = "2026-08-09T09:00:00Z";
    completedCustomer.customer.billingAddress = fixture[0].customer.billingAddress;
    await orders.importOrders([completedCustomer], {
      id: 1,
      requestId: "test-completed-customer",
    });
    const completedCase = (
      await database.getPool().query(
        `SELECT billing_cases.status, customers.review_required,
                  customers.billing_address_json ->> 'city' AS city
             FROM billing_cases
             JOIN customers ON customers.id = billing_cases.customer_id
             JOIN orders ON orders.billing_case_id = billing_cases.id
             WHERE orders.external_order_id = 'shop-order-completed-customer'`,
      )
    ).rows[0];
    assert.deepEqual(completedCase, {
      status: "READY",
      review_required: false,
      city: "Milano",
    });
    const laterIncompleteCustomer = structuredClone(incompleteCustomer);
    laterIncompleteCustomer.externalOrderId = "shop-order-later-incomplete-customer";
    laterIncompleteCustomer.createdAt = "2026-08-10T08:15:00Z";
    laterIncompleteCustomer.updatedAt = "2026-08-10T09:00:00Z";
    await orders.importOrders([laterIncompleteCustomer], {
      id: 1,
      requestId: "test-later-incomplete-customer",
    });
    const preservedCase = (
      await database.getPool().query(
        `SELECT billing_cases.status,
                  billing_cases.customer_snapshot_json ->> 'reviewRequired' AS review_required,
                  billing_cases.customer_snapshot_json #>> '{billingAddress,city}' AS city
             FROM billing_cases
             JOIN orders ON orders.billing_case_id = billing_cases.id
             WHERE orders.external_order_id = 'shop-order-completed-customer'`,
      )
    ).rows[0];
    assert.deepEqual(preservedCase, {
      status: "READY",
      review_required: "false",
      city: "Milano",
    });

    const { externalCustomerId: _, ...noExternalCustomer } = structuredClone(fixture[0]);
    noExternalCustomer.externalOrderId = "shop-order-without-external-customer";
    noExternalCustomer.createdAt = "2026-08-13T08:00:00Z";
    noExternalCustomer.updatedAt = "2026-08-13T09:00:00Z";
    noExternalCustomer.customer = {
      kind: "UNKNOWN",
      billingAddress: {},
      taxIdentifiers: [],
    };
    await orders.importOrders([noExternalCustomer], {
      id: 1,
      requestId: "test-without-external-customer",
    });
    assert.equal(
      (
        await database.getPool().query(
          `SELECT billing_cases.status
               FROM billing_cases JOIN orders ON orders.billing_case_id = billing_cases.id
               WHERE orders.external_order_id = $1`,
          [noExternalCustomer.externalOrderId],
        )
      ).rows[0].status,
      "NEEDS_REVIEW",
    );

    const unreconciled = structuredClone(fixture[0]);
    unreconciled.externalOrderId = "shop-order-unreconciled";
    unreconciled.externalCustomerId = "shop-customer-unreconciled";
    unreconciled.customer.taxIdentifiers[0].value = "RSSMRA80A01H501X";
    unreconciled.createdAt = "2026-08-14T08:00:00Z";
    unreconciled.updatedAt = "2026-08-14T09:00:00Z";
    unreconciled.total = "123.00";
    await orders.importOrders([unreconciled], { id: 1, requestId: "test-unreconciled" });
    const unreconciledCase = (
      await database.getPool().query(
        `SELECT billing_cases.status,
                  orders.normalized_snapshot_json ->> 'totalsReconciled' AS totals_reconciled
             FROM billing_cases JOIN orders ON orders.billing_case_id = billing_cases.id
             WHERE orders.external_order_id = $1`,
        [unreconciled.externalOrderId],
      )
    ).rows[0];
    assert.deepEqual(unreconciledCase, {
      status: "NEEDS_REVIEW",
      totals_reconciled: "false",
    });

    const lowerCountry = {
      ...structuredClone(fixture[0]),
      externalOrderId: "shop-order-country-lower",
      externalCustomerId: "shop-customer-country-lower",
      createdAt: "2026-08-15T08:00:00Z",
      updatedAt: "2026-08-15T09:00:00Z",
      customer: {
        ...structuredClone(fixture[0].customer),
        kind: "EU" as const,
        billingAddress: {
          ...structuredClone(fixture[0].customer.billingAddress),
          countryCode: "DE",
        },
        taxIdentifiers: [
          {
            ...structuredClone(fixture[0].customer.taxIdentifiers[0]),
            type: "ALTRO" as const,
            value: "DE123456789",
            countryCode: "de",
          },
        ],
      },
    };
    const upperCountry = structuredClone(lowerCountry);
    upperCountry.externalOrderId = "shop-order-country-upper";
    upperCountry.externalCustomerId = "shop-customer-country-upper";
    upperCountry.customer.taxIdentifiers[0].countryCode = "DE";
    await orders.importOrders([lowerCountry, upperCountry], {
      id: 1,
      requestId: "test-country-grouping",
    });
    assert.equal(
      (
        await database.getPool().query(
          `SELECT count(DISTINCT billing_case_id) FROM orders
             WHERE external_order_id IN ($1, $2)`,
          [lowerCountry.externalOrderId, upperCountry.externalOrderId],
        )
      ).rows[0].count,
      "1",
    );
    lowerCountry.customer.taxIdentifiers[0].countryCode = "DE";
    lowerCountry.updatedAt = "2026-08-15T10:00:00Z";
    await orders.importOrders([lowerCountry], { id: 1, requestId: "test-country-reimport" });
    assert.equal(
      (
        await database.getPool().query(
          `SELECT count(*) FROM order_source_revisions
             JOIN orders ON orders.id = order_source_revisions.order_id
             WHERE orders.external_order_id = $1`,
          [lowerCountry.externalOrderId],
        )
      ).rows[0].count,
      "0",
    );

    const shipped = structuredClone(fixture[0]);
    shipped.externalOrderId = "shop-order-with-shipping";
    shipped.externalCustomerId = "shop-customer-with-shipping";
    shipped.customer.taxIdentifiers[0].value = "RSSMRA80A01H501Y";
    shipped.createdAt = "2026-08-16T08:00:00Z";
    shipped.updatedAt = "2026-08-16T09:00:00Z";
    shipped.total = "127.00";
    shipped.shippingAmount = "5.00";
    shipped.payments[0].amount = "127.00";
    await orders.importOrders([shipped], { id: 1, requestId: "test-shipping" });
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT billing_cases.status,
                    orders.normalized_snapshot_json ->> 'shippingAmount' AS shipping_amount,
                    orders.normalized_snapshot_json ->> 'totalsReconciled' AS totals_reconciled
               FROM billing_cases JOIN orders ON orders.billing_case_id = billing_cases.id
               WHERE orders.external_order_id = $1`,
          [shipped.externalOrderId],
        )
      ).rows[0],
      { status: "READY", shipping_amount: "500", totals_reconciled: "true" },
    );
    const manuallyClosedCaseId = (
      await database
        .getPool()
        .query("SELECT billing_case_id FROM orders WHERE external_order_id = $1", [
          shipped.externalOrderId,
        ])
    ).rows[0].billing_case_id;
    assert.equal(
      await orders.updateBillingCaseTransmission(
        manuallyClosedCaseId,
        "Già fatturato altrove",
        await caseRevision(manuallyClosedCaseId),
        {
          id: 1,
          requestId: "test-manual-do-not-transmit",
        },
      ),
      "DO_NOT_TRANSMIT",
    );
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT status, do_not_transmit_reason
             FROM billing_cases WHERE id = $1`,
          [manuallyClosedCaseId],
        )
      ).rows[0],
      { status: "DO_NOT_TRANSMIT", do_not_transmit_reason: "Già fatturato altrove" },
    );
    shipped.lines[0].description = "Descrizione aggiornata mentre la preparazione è chiusa";
    shipped.updatedAt = "2026-08-16T10:00:00Z";
    await orders.importOrders([shipped], {
      id: 1,
      requestId: "test-manual-do-not-transmit-source-update",
    });
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT billing_cases.id, billing_cases.status, billing_cases.do_not_transmit_reason
             FROM billing_cases JOIN orders ON orders.billing_case_id = billing_cases.id
             WHERE orders.external_order_id = $1`,
          [shipped.externalOrderId],
        )
      ).rows[0],
      {
        id: manuallyClosedCaseId,
        status: "DO_NOT_TRANSMIT",
        do_not_transmit_reason: "Già fatturato altrove",
      },
    );
    assert.equal(
      await orders.updateBillingCaseTransmission(
        manuallyClosedCaseId,
        null,
        await caseRevision(manuallyClosedCaseId),
        {
          id: 1,
          requestId: "test-manual-reactivation",
        },
      ),
      "NEEDS_REVIEW",
    );
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT status, do_not_transmit_reason,
                    (SELECT count(*)::int FROM audit_events
                     WHERE entity_type = 'BILLING_CASE'
                       AND entity_id = billing_cases.id::text
                       AND action IN ('BILLING_CASE_DO_NOT_TRANSMIT', 'BILLING_CASE_REACTIVATED'))
                      AS audit_count
             FROM billing_cases WHERE id = $1`,
          [manuallyClosedCaseId],
        )
      ).rows[0],
      { status: "NEEDS_REVIEW", do_not_transmit_reason: null, audit_count: 2 },
    );

    const reorderedCollections = structuredClone(fixture[0]);
    reorderedCollections.externalOrderId = "shop-order-reordered-collections";
    reorderedCollections.externalCustomerId = "shop-customer-reordered-collections";
    reorderedCollections.customer.taxIdentifiers[0].value = "RSSMRA80A01H501W";
    reorderedCollections.customer.taxIdentifiers.push({
      ...reorderedCollections.customer.taxIdentifiers[0],
      sourceField: "duplicate-source-field",
    });
    reorderedCollections.customer.taxIdentifiers.push(
      { type: "ALTRO", value: "DUPLICATO42", countryCode: "DE", sourceField: "field-de" },
      { type: "ALTRO", value: "DUPLICATO42", countryCode: "FR", sourceField: "field-fr" },
    );
    reorderedCollections.createdAt = "2026-08-17T08:00:00Z";
    reorderedCollections.updatedAt = "2026-08-17T09:00:00Z";
    reorderedCollections.lines = [
      { ...reorderedCollections.lines[0], externalLineId: "line-a", grossAmount: "60.00" },
      { ...reorderedCollections.lines[0], externalLineId: "line-b", grossAmount: "62.00" },
    ];
    reorderedCollections.payments = [
      { ...reorderedCollections.payments[0], externalPaymentId: "payment-a", amount: "60.00" },
      { ...reorderedCollections.payments[0], externalPaymentId: "payment-b", amount: "62.00" },
    ];
    await orders.importOrders([reorderedCollections], {
      id: 1,
      requestId: "test-collection-order-import",
    });
    reorderedCollections.lines.reverse();
    reorderedCollections.payments.reverse();
    reorderedCollections.payments.forEach(
      (payment: { paidAt: string | null }) => (payment.paidAt = "2026-08-07T11:00:00+02:00"),
    );
    reorderedCollections.updatedAt = "2026-08-17T10:00:00Z";
    await orders.importOrders([reorderedCollections], {
      id: 1,
      requestId: "test-collection-order-reimport",
    });
    assert.equal(
      (
        await database.getPool().query(
          `SELECT count(*) FROM order_source_revisions
             JOIN orders ON orders.id = order_source_revisions.order_id
             WHERE orders.external_order_id = $1`,
          [reorderedCollections.externalOrderId],
        )
      ).rows[0].count,
      "0",
    );
    assert.equal(
      (
        await database.getPool().query(
          `SELECT count(*) FROM order_tax_identifiers
             JOIN orders ON orders.id = order_tax_identifiers.order_id
             WHERE orders.external_order_id = $1`,
          [reorderedCollections.externalOrderId],
        )
      ).rows[0].count,
      "3",
    );
    reorderedCollections.cancelledAt = "2026-08-17T12:00:00Z";
    reorderedCollections.updatedAt = "2026-08-17T11:00:00Z";
    await orders.importOrders([reorderedCollections], {
      id: 1,
      requestId: "test-canonical-cancelled-at",
    });
    reorderedCollections.cancelledAt = "2026-08-17T14:00:00+02:00";
    reorderedCollections.updatedAt = "2026-08-17T12:00:00Z";
    await orders.importOrders([reorderedCollections], {
      id: 1,
      requestId: "test-canonical-cancelled-at-reimport",
    });
    assert.equal(
      (
        await database.getPool().query(
          `SELECT count(*) FROM order_source_revisions
             JOIN orders ON orders.id = order_source_revisions.order_id
             WHERE orders.external_order_id = $1`,
          [reorderedCollections.externalOrderId],
        )
      ).rows[0].count,
      "1",
    );

    const canonicalA = structuredClone(fixture[0]);
    canonicalA.externalOrderId = "shop-order-tax-order-a";
    canonicalA.externalCustomerId = "shop-customer-tax-order-a";
    canonicalA.createdAt = "2026-08-18T08:00:00Z";
    canonicalA.updatedAt = "2026-08-18T09:00:00Z";
    canonicalA.customer.kind = "EU";
    canonicalA.customer.billingAddress.countryCode = "DE";
    canonicalA.customer.taxIdentifiers = [
      {
        type: "PARTITA_IVA",
        value: "DE123456789",
        countryCode: "DE",
        sourceField: "fixture-vat",
      },
      {
        type: "ALTRO",
        value: "DE-ALT-42",
        countryCode: "DE",
        sourceField: "fixture-other",
      },
    ];
    delete canonicalA.customer.billingAddress.province;
    const canonicalB = structuredClone(canonicalA);
    canonicalB.externalOrderId = "shop-order-tax-order-b";
    canonicalB.externalCustomerId = "shop-customer-tax-order-b";
    canonicalB.customer.taxIdentifiers.reverse();
    canonicalB.customer.taxIdentifiers.find(
      (identifier: { type: string }) => identifier.type === "PARTITA_IVA",
    )!.value = "123456789";
    canonicalB.customer.phone = "";
    canonicalB.customer.billingAddress.province = "";
    await orders.importOrders([canonicalA, canonicalB], {
      id: 1,
      requestId: "test-tax-order-grouping",
    });
    const canonicalAOrderId = (
      await database
        .getPool()
        .query("SELECT id FROM orders WHERE external_order_id = $1", [canonicalA.externalOrderId])
    ).rows[0].id;
    assert.ok(
      (await orders.listOrders({ query: "DE123456789" })).rows.some(
        (order: { id: string }) => order.id === canonicalAOrderId,
      ),
    );
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT count(DISTINCT billing_case_id)::int AS case_count,
                    min(billing_cases.status) AS status
               FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
               WHERE external_order_id IN ($1, $2)`,
          [canonicalA.externalOrderId, canonicalB.externalOrderId],
        )
      ).rows[0],
      { case_count: 1, status: "READY" },
    );
    canonicalA.customer.taxIdentifiers.reverse();
    canonicalA.customer.phone = "";
    canonicalA.customer.billingAddress.province = "";
    canonicalA.updatedAt = "2026-08-18T10:00:00Z";
    await orders.importOrders([canonicalA], {
      id: 1,
      requestId: "test-tax-order-reimport",
    });
    assert.equal(
      (
        await database.getPool().query(
          `SELECT count(*) FROM order_source_revisions
             JOIN orders ON orders.id = order_source_revisions.order_id
             WHERE orders.external_order_id = $1`,
          [canonicalA.externalOrderId],
        )
      ).rows[0].count,
      "0",
    );
    canonicalA.displayNumber = "#1001-corretto";
    canonicalA.updatedAt = "2026-08-18T11:00:00Z";
    await orders.importOrders([canonicalA], {
      id: 1,
      requestId: "test-display-number-conflict",
    });
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT count(order_source_revisions.*)::int AS revision_count,
                    billing_cases.status
               FROM orders
               JOIN billing_cases ON billing_cases.id = orders.billing_case_id
               LEFT JOIN order_source_revisions ON order_source_revisions.order_id = orders.id
               WHERE orders.external_order_id = $1
               GROUP BY billing_cases.status`,
          [canonicalA.externalOrderId],
        )
      ).rows[0],
      { revision_count: 1, status: "NEEDS_REVIEW" },
    );
    canonicalA.updatedAt = "2026-08-18T12:00:00Z";
    await orders.importOrders([canonicalA], {
      id: 1,
      requestId: "test-technical-update-after-conflict",
    });
    canonicalA.lines[0].description = "Descrizione dopo aggiornamento tecnico";
    canonicalA.updatedAt = "2026-08-18T13:00:00Z";
    await orders.importOrders([canonicalA], {
      id: 1,
      requestId: "test-second-conflict-after-technical-update",
    });
    assert.equal(
      (
        await database.getPool().query(
          `SELECT previous_normalized_snapshot_json ->> 'updatedAt' AS previous_updated_at
             FROM order_source_revisions
             JOIN orders ON orders.id = order_source_revisions.order_id
             WHERE orders.external_order_id = $1
             ORDER BY order_source_revisions.id DESC LIMIT 1`,
          [canonicalA.externalOrderId],
        )
      ).rows[0].previous_updated_at,
      "2026-08-18T12:00:00Z",
    );

    const profileA = structuredClone(fixture[0]);
    profileA.externalOrderId = "shop-order-profile-a";
    profileA.externalCustomerId = "shop-customer-profile-a";
    profileA.createdAt = "2026-08-21T08:00:00Z";
    profileA.updatedAt = "2026-08-21T09:00:00Z";
    profileA.customer.kind = "EU";
    profileA.customer.displayName = "Entreprise Exemple";
    profileA.customer.billingAddress.line1 = "Rue de Rome 1";
    profileA.customer.billingAddress.countryCode = "FR";
    profileA.customer.taxIdentifiers = [];
    const profileB = structuredClone(profileA);
    profileB.externalOrderId = "shop-order-profile-b";
    profileB.externalCustomerId = "shop-customer-profile-b";
    profileB.customer.displayName = "ENTREPRISE  EXEMPLE";
    profileB.customer.billingAddress.line1 = "RUE DE  ROME 1";
    await orders.importOrders([profileA, profileB], {
      id: 1,
      requestId: "test-profile-format-grouping",
    });
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT count(DISTINCT billing_case_id)::int AS case_count,
                    min(billing_cases.status) AS status
               FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
               WHERE external_order_id IN ($1, $2)`,
          [profileA.externalOrderId, profileB.externalOrderId],
        )
      ).rows[0],
      { case_count: 1, status: "READY" },
    );
    profileA.customer.displayName = "ENTREPRISE  EXEMPLE";
    profileA.customer.billingAddress.line1 = "RUE DE  ROME 1";
    profileA.updatedAt = "2026-08-21T10:00:00Z";
    await orders.importOrders([profileA], {
      id: 1,
      requestId: "test-profile-format-reimport",
    });
    assert.equal(
      (
        await database.getPool().query(
          `SELECT count(*) FROM order_source_revisions
             JOIN orders ON orders.id = order_source_revisions.order_id
             WHERE orders.external_order_id = $1`,
          [profileA.externalOrderId],
        )
      ).rows[0].count,
      "0",
    );

    const conflictingProfileA = structuredClone(fixture[0]);
    conflictingProfileA.externalOrderId = "shop-order-conflicting-profile-a";
    conflictingProfileA.externalCustomerId = "shop-customer-conflicting-profile-a";
    conflictingProfileA.customer.taxIdentifiers[0].value = "RSSMRA80A01H501L";
    conflictingProfileA.createdAt = "2026-08-22T08:00:00Z";
    conflictingProfileA.updatedAt = "2026-08-22T09:00:00Z";
    const conflictingProfileB = structuredClone(conflictingProfileA);
    conflictingProfileB.externalOrderId = "shop-order-conflicting-profile-b";
    conflictingProfileB.externalCustomerId = "shop-customer-conflicting-profile-b";
    conflictingProfileB.customer.billingAddress.line1 = "Via Milano 2";
    await orders.importOrders([conflictingProfileA, conflictingProfileB], {
      id: 1,
      requestId: "test-conflicting-profile-grouping",
    });
    const conflictingProfileCase = (
      await database.getPool().query(
        `SELECT billing_cases.id, billing_cases.status,
                  bool_and(orders.trigger_status = 'GROUPED') AS orders_grouped
             FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
             WHERE orders.external_order_id IN ($1, $2)
             GROUP BY billing_cases.id, billing_cases.status`,
        [conflictingProfileA.externalOrderId, conflictingProfileB.externalOrderId],
      )
    ).rows[0];
    assert.deepEqual(conflictingProfileCase, {
      id: conflictingProfileCase.id,
      status: "NEEDS_REVIEW",
      orders_grouped: true,
    });
    await orders.updateBillingCaseTransmission(
      String(conflictingProfileCase.id),
      "Anagrafica da verificare",
      await caseRevision(String(conflictingProfileCase.id)),
      { id: 1, requestId: "test-archive-conflicting-profile" },
    );
    assert.equal(
      await orders.updateBillingCaseTransmission(
        String(conflictingProfileCase.id),
        null,
        await caseRevision(String(conflictingProfileCase.id)),
        {
          id: 1,
          requestId: "test-reactivate-conflicting-profile",
        },
      ),
      "NEEDS_REVIEW",
    );

    const reviewedA = structuredClone(fixture[0]);
    reviewedA.externalOrderId = "shop-order-reviewed-a";
    reviewedA.externalCustomerId = "shop-customer-reviewed-a";
    reviewedA.createdAt = "2026-08-19T08:00:00Z";
    reviewedA.updatedAt = "2026-08-19T09:00:00Z";
    reviewedA.customer.taxIdentifiers[0].value = "RSSMRA80A01H501O";
    const reviewedB = structuredClone(reviewedA);
    reviewedB.externalOrderId = "shop-order-reviewed-b";
    reviewedB.externalCustomerId = "shop-customer-reviewed-b";
    await orders.importOrders([reviewedA, reviewedB], {
      id: 1,
      requestId: "test-reviewed-grouping",
    });
    reviewedA.lines[0].description = "Descrizione da verificare";
    reviewedA.updatedAt = "2026-08-19T10:00:00Z";
    await orders.importOrders([reviewedA], {
      id: 1,
      requestId: "test-reviewed-conflict",
    });
    reviewedB.lines[0].description = "Secondo ordine da verificare";
    reviewedB.updatedAt = "2026-08-19T10:15:00Z";
    await orders.importOrders([reviewedB], {
      id: 1,
      requestId: "test-reviewed-second-conflict",
    });
    reviewedB.cancelledAt = "2026-08-19T10:30:00Z";
    reviewedB.updatedAt = "2026-08-19T10:30:00Z";
    await orders.importOrders([reviewedB], {
      id: 1,
      requestId: "test-reviewed-cancellation",
    });
    const archivedCancelledCaseId = (
      await database.getPool().query(
        `SELECT entity_id FROM audit_events
           WHERE request_id = 'test-reviewed-cancellation'
             AND action = 'BILLING_CASE_DO_NOT_TRANSMIT'`,
      )
    ).rows[0].entity_id;
    assert.equal(
      (await orders.getBillingCase(String(archivedCancelledCaseId)))!.reactivation_blocker,
      "INCOMPATIBLE_ORDERS",
    );
    const recoveredReviewed = (
      await database.getPool().query(
        `SELECT orders.billing_case_id, billing_cases.status,
                  orders.normalized_snapshot_json ->> 'deferredReviewRequired'
                    AS deferred_review
             FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
             WHERE orders.external_order_id = $1`,
        [reviewedA.externalOrderId],
      )
    ).rows[0];
    assert.equal(recoveredReviewed.status, "NEEDS_REVIEW");
    assert.equal(recoveredReviewed.deferred_review, "true");
    await orders.updateBillingCaseTransmission(
      String(recoveredReviewed.billing_case_id),
      "Conflitto sorgente da verificare",
      await caseRevision(String(recoveredReviewed.billing_case_id)),
      { id: 1, requestId: "test-archive-recovered-review" },
    );
    assert.equal(
      await orders.updateBillingCaseTransmission(
        String(recoveredReviewed.billing_case_id),
        null,
        await caseRevision(String(recoveredReviewed.billing_case_id)),
        {
          id: 1,
          requestId: "test-reactivate-recovered-review",
        },
      ),
      "NEEDS_REVIEW",
    );
    reviewedB.cancelledAt = null;
    reviewedB.customer.taxIdentifiers[0].value = "RSSMRA80A01H501N";
    reviewedB.updatedAt = "2026-08-19T11:00:00Z";
    await orders.importOrders([reviewedB], {
      id: 1,
      requestId: "test-cancellation-revoked",
    });
    const reidentifiedOrder = (
      await database.getPool().query(
        `SELECT orders.billing_case_id, orders.trigger_status, orders.customer_id,
                  billing_cases.customer_id AS case_customer_id, billing_cases.status
             FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
             WHERE orders.external_order_id = $1`,
        [reviewedB.externalOrderId],
      )
    ).rows[0];
    assert.notEqual(reidentifiedOrder.billing_case_id, recoveredReviewed.billing_case_id);
    assert.equal(reidentifiedOrder.trigger_status, "GROUPED");
    assert.equal(reidentifiedOrder.customer_id, reidentifiedOrder.case_customer_id);
    assert.equal(reidentifiedOrder.status, "NEEDS_REVIEW");
    assert.ok(
      (await orders.getBillingCase(String(reidentifiedOrder.billing_case_id)))!.revisions.length >
        0,
    );
    await orders.updateBillingCaseTransmission(
      String(reidentifiedOrder.billing_case_id),
      "Preparazione sostitutiva archiviata per il test",
      await caseRevision(String(reidentifiedOrder.billing_case_id)),
      { id: 1, requestId: "test-archive-replacement-case" },
    );
    await assert.rejects(
      orders.updateBillingCaseTransmission(
        String(archivedCancelledCaseId),
        null,
        await caseRevision(String(archivedCancelledCaseId)),
        {
          id: 1,
          requestId: "test-empty-case-reactivation",
        },
      ),
      (error: unknown) => error instanceof AppError && error.code === "BILLING_CASE_EMPTY",
    );
    assert.equal(
      (await orders.getBillingCase(String(archivedCancelledCaseId)))!.reactivation_blocker,
      "EMPTY",
    );
    await orders.updateBillingCaseTransmission(
      String(reidentifiedOrder.billing_case_id),
      null,
      await caseRevision(String(reidentifiedOrder.billing_case_id)),
      {
        id: 1,
        requestId: "test-reactivate-replacement-case",
      },
    );

    const precisePayment = structuredClone(fixture[0]);
    precisePayment.externalOrderId = "shop-order-precise-payment";
    precisePayment.externalCustomerId = "shop-customer-precise-payment";
    precisePayment.customer.taxIdentifiers[0].value = "RSSMRA80A01H501V";
    precisePayment.createdAt = "2026-08-25T08:00:00Z";
    precisePayment.updatedAt = "2026-08-25T09:00:00Z";
    precisePayment.payments[0].paidAt = "2026-08-25T08:30:00.000001Z";
    await orders.importOrders([precisePayment], {
      id: 1,
      requestId: "test-precise-payment-import",
    });
    precisePayment.payments[0].paidAt = "2026-08-25T08:30:00.000002Z";
    precisePayment.updatedAt = "2026-08-25T10:00:00Z";
    await orders.importOrders([precisePayment], {
      id: 1,
      requestId: "test-precise-payment-update",
    });
    assert.equal(
      (
        await database.getPool().query(
          `SELECT count(*) FROM order_source_revisions
             JOIN orders ON orders.id = order_source_revisions.order_id
             WHERE orders.external_order_id = $1`,
          [precisePayment.externalOrderId],
        )
      ).rows[0].count,
      "1",
    );

    const preciseCancellation = structuredClone(fixture[0]);
    preciseCancellation.externalOrderId = "shop-order-precise-cancellation";
    preciseCancellation.externalCustomerId = "shop-customer-precise-cancellation";
    preciseCancellation.customer.taxIdentifiers[0].value = "RSSMRA80A01H501Q";
    preciseCancellation.createdAt = "2026-08-26T08:00:00Z";
    preciseCancellation.updatedAt = "2026-08-26T09:00:00Z";
    await orders.importOrders([preciseCancellation], {
      id: 1,
      requestId: "test-precise-cancellation-import",
    });
    preciseCancellation.cancelledAt = "2026-08-26T09:30:00.000001Z";
    preciseCancellation.updatedAt = "2026-08-26T09:30:00Z";
    await orders.importOrders([preciseCancellation], {
      id: 1,
      requestId: "test-precise-cancellation-first",
    });
    preciseCancellation.cancelledAt = "2026-08-26T09:30:00.000002Z";
    preciseCancellation.updatedAt = "2026-08-26T10:00:00Z";
    await orders.importOrders([preciseCancellation], {
      id: 1,
      requestId: "test-precise-cancellation-second",
    });
    assert.equal(
      (
        await database.getPool().query(
          `SELECT count(*) FROM order_source_revisions
             JOIN orders ON orders.id = order_source_revisions.order_id
             WHERE orders.external_order_id = $1`,
          [preciseCancellation.externalOrderId],
        )
      ).rows[0].count,
      "2",
    );

    const healthySibling = structuredClone(fixture[0]);
    healthySibling.externalOrderId = "shop-order-healthy-sibling";
    healthySibling.externalCustomerId = "shop-customer-sibling-review";
    healthySibling.customer.taxIdentifiers[0].value = "RSSMRA80A01H501R";
    healthySibling.createdAt = "2026-08-27T08:00:00Z";
    healthySibling.updatedAt = "2026-08-27T09:00:00Z";
    const problematicSibling = structuredClone(healthySibling);
    problematicSibling.externalOrderId = "shop-order-problematic-sibling";
    problematicSibling.payments[0].status = "PENDING";
    await orders.importOrders([healthySibling, problematicSibling], {
      id: 1,
      requestId: "test-sibling-review-import",
    });
    problematicSibling.cancelledAt = "2026-08-27T10:00:00Z";
    problematicSibling.updatedAt = "2026-08-27T10:00:00Z";
    await orders.importOrders([problematicSibling], {
      id: 1,
      requestId: "test-sibling-review-cancellation",
    });
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT billing_cases.status,
                    orders.normalized_snapshot_json ->> 'deferredReviewRequired'
                      AS deferred_review
             FROM orders
             JOIN billing_cases ON billing_cases.id = orders.billing_case_id
             WHERE orders.external_order_id = $1`,
          [healthySibling.externalOrderId],
        )
      ).rows[0],
      { status: "READY", deferred_review: "false" },
    );

    const triggerConcurrentA = structuredClone(fixture[0]);
    triggerConcurrentA.externalOrderId = "shop-order-trigger-concurrent-a";
    triggerConcurrentA.externalCustomerId = "shop-customer-trigger-concurrent";
    triggerConcurrentA.customer.taxIdentifiers[0].value = "RSSMRA80A01H501M";
    triggerConcurrentA.createdAt = "2026-08-20T08:00:00Z";
    triggerConcurrentA.updatedAt = "2026-08-20T09:00:00Z";
    const triggerConcurrentB = structuredClone(triggerConcurrentA);
    triggerConcurrentB.externalOrderId = "shop-order-trigger-concurrent-b";
    await orders.importOrders([triggerConcurrentA, triggerConcurrentB], {
      id: 1,
      requestId: "test-trigger-concurrent-import",
    });
    const triggerConcurrentBId = (
      await database
        .getPool()
        .query("SELECT id FROM orders WHERE external_order_id = $1", [
          triggerConcurrentB.externalOrderId,
        ])
    ).rows[0].id;
    await Promise.all([
      orders.setDraftTrigger("PAID", 2, {
        id: 1,
        requestId: "test-trigger-concurrent-change",
      }),
      orders.forcePrepareOrder(triggerConcurrentBId, {
        id: 1,
        requestId: "test-trigger-concurrent-force",
      }),
    ]);
    assert.equal(
      (
        await database.getPool().query(
          `SELECT count(DISTINCT billing_case_id) FROM orders
             WHERE external_order_id IN ($1, $2)`,
          [triggerConcurrentA.externalOrderId, triggerConcurrentB.externalOrderId],
        )
      ).rows[0].count,
      "1",
    );

    const upgradedHistorical = structuredClone(fixture[0]);
    upgradedHistorical.externalOrderId = "shop-order-upgraded-historical";
    upgradedHistorical.externalCustomerId = "shop-customer-upgraded-historical";
    upgradedHistorical.customer.taxIdentifiers[0].value = "RSSMRA80A01H501E";
    upgradedHistorical.createdAt = "2026-08-18T08:00:00Z";
    upgradedHistorical.updatedAt = "2026-08-18T09:00:00Z";
    upgradedHistorical.historical = false;
    await orders.importOrders([upgradedHistorical], {
      id: 1,
      requestId: "test-before-history-upgrade",
    });
    const upgradedBefore = (
      await database.getPool().query(
        `SELECT orders.id, orders.billing_case_id, billing_cases.status
         FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
         WHERE orders.external_order_id = $1`,
        [upgradedHistorical.externalOrderId],
      )
    ).rows[0];
    assert.equal(upgradedBefore.status, "READY");
    upgradedHistorical.historical = true;
    upgradedHistorical.updatedAt = "2026-08-18T10:00:00Z";
    upgradedHistorical.refunds = [
      {
        externalRefundId: "upgraded-historical-total-refund",
        status: "COMPLETED",
        amount: upgradedHistorical.total,
        completedAt: "2026-08-18T10:00:00Z",
        raw: {},
      },
    ];
    await orders.importOrders([upgradedHistorical], {
      id: 1,
      requestId: "test-history-upgrade",
    });
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT billing_case_id, trigger_status,
                  normalized_snapshot_json ->> 'historical' AS historical
           FROM orders WHERE id = $1`,
          [upgradedBefore.id],
        )
      ).rows[0],
      { billing_case_id: null, trigger_status: "LEGACY_BILLING_REVIEW", historical: "true" },
    );
    assert.equal(
      (
        await database
          .getPool()
          .query("SELECT status FROM billing_cases WHERE id = $1", [upgradedBefore.billing_case_id])
      ).rows[0].status,
      "DO_NOT_TRANSMIT",
    );
    await assert.rejects(
      orders.forcePrepareOrder(upgradedBefore.id, {
        id: 1,
        requestId: "test-force-upgraded-historical",
      }),
      (error: unknown) => error instanceof AppError && error.code === "ORDER_NOT_PREPARABLE",
    );

    const historical = structuredClone(fixture[0]);
    historical.externalOrderId = "shop-order-historical";
    historical.externalCustomerId = "shop-customer-historical";
    historical.customer.taxIdentifiers[0].value = "RSSMRA80A01H501C";
    historical.historical = true;
    historical.createdAt = "2026-08-19T08:00:00Z";
    historical.updatedAt = "2026-08-19T09:00:00Z";
    const reviewCountBeforeHistorical = Number((await orders.dashboardSummary()).review_cases);
    await orders.importOrders([historical], {
      id: 1,
      requestId: "test-historical-import",
    });
    const historicalId = (
      await database
        .getPool()
        .query("SELECT id FROM orders WHERE external_order_id = $1", [historical.externalOrderId])
    ).rows[0].id;
    assert.equal(
      Number((await orders.dashboardSummary()).review_cases),
      reviewCountBeforeHistorical + 1,
    );
    assert.ok(
      (await orders.listOpenActivities()).rows.some(
        (activity) => activity.kind === "ORDER" && activity.id === String(historicalId),
      ),
    );
    await orders.setDraftTrigger("PAID", 3, {
      id: 1,
      requestId: "test-historical-trigger-change",
    });
    assert.deepEqual(
      (
        await database
          .getPool()
          .query("SELECT trigger_status, billing_case_id FROM orders WHERE id = $1", [historicalId])
      ).rows[0],
      { trigger_status: "LEGACY_BILLING_REVIEW", billing_case_id: null },
    );
    await assert.rejects(
      orders.forcePrepareOrder(historicalId, { id: 1, requestId: "test-force-historical" }),
      (error: unknown) => error instanceof AppError && error.code === "ORDER_NOT_PREPARABLE",
    );
    await assert.rejects(
      orders.reconcileHistoricalOrder(
        historicalId,
        {
          outcome: "ALREADY_INVOICED",
          reference: "Tentativo diretto dell’account operatore",
        },
        { id: 2, canApprove: false, requestId: "test-reconcile-historical-forbidden" },
      ),
      (error: unknown) =>
        error instanceof AppError && error.code === "ORDER_HISTORY_RECONCILIATION_FORBIDDEN",
    );
    assert.equal((await orders.getOrder(historicalId))!.historical_reconciliation_outcome, null);
    const reconciledHistorical = await orders.reconcileHistoricalOrder(
      historicalId,
      {
        outcome: "NOT_INVOICED",
        reference: "Ricerca Aruba per ordine, data, cliente e totale: nessun documento",
      },
      { id: 1, canApprove: true, requestId: "test-reconcile-historical-clear" },
    );
    assert.ok(reconciledHistorical?.caseId);
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT trigger_status, historical_reconciliation_outcome,
                  historical_reconciled_at IS NOT NULL AS reconciled
           FROM orders WHERE id = $1`,
          [historicalId],
        )
      ).rows[0],
      {
        trigger_status: "GROUPED",
        historical_reconciliation_outcome: "NOT_INVOICED",
        reconciled: true,
      },
    );
    historical.updatedAt = "2026-08-19T09:30:00Z";
    historical.historical = false;
    await orders.importOrders([historical], {
      id: 1,
      requestId: "test-reimport-historical-clear",
    });
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT trigger_status,
                  normalized_snapshot_json ->> 'historical' AS historical,
                  historical_reconciliation_outcome
           FROM orders WHERE id = $1`,
          [historicalId],
        )
      ).rows[0],
      {
        trigger_status: "GROUPED",
        historical: "true",
        historical_reconciliation_outcome: "NOT_INVOICED",
      },
    );

    const alreadyInvoiced = structuredClone(historical);
    alreadyInvoiced.externalOrderId = "shop-order-historical-invoiced";
    alreadyInvoiced.customer.taxIdentifiers[0].value = "RSSMRA80A01H501U";
    alreadyInvoiced.historical = true;
    alreadyInvoiced.refunds = [
      {
        externalRefundId: "historical-invoiced-existing-refund",
        status: "COMPLETED",
        amount: "10.00",
        completedAt: "2026-08-20T09:45:00Z",
        raw: {},
      },
    ];
    await orders.importOrders([alreadyInvoiced], {
      id: 1,
      requestId: "test-import-historical-invoiced",
    });
    const alreadyInvoicedId = (
      await database
        .getPool()
        .query("SELECT id FROM orders WHERE external_order_id = $1", [
          alreadyInvoiced.externalOrderId,
        ])
    ).rows[0].id;
    await database.getPool().query(
      `INSERT INTO fiscal_profiles (version, status, profile_json)
       VALUES (1, 'MOCK', $1)`,
      [JSON.parse(await readFile("tests/fixtures/fatturapa/profile.mock.json", "utf8"))],
    );
    const shopifyWithoutReference = structuredClone(historical);
    shopifyWithoutReference.externalOrderId = "shop-order-historical-without-reference";
    shopifyWithoutReference.displayNumber = "#S-HIST-NO-REF";
    shopifyWithoutReference.customer.taxIdentifiers[0].value = "RSSMRA80A01H501U";
    shopifyWithoutReference.historical = true;
    shopifyWithoutReference.createdAt = "2026-08-18T08:00:00Z";
    shopifyWithoutReference.updatedAt = "2026-08-18T09:00:00Z";
    shopifyWithoutReference.payments[0].externalPaymentId =
      "shop-payment-historical-without-reference";
    shopifyWithoutReference.payments[0].method = "shopify_payments";
    shopifyWithoutReference.payments[0].shopifyPaymentsFeeAmount = "2.00";
    shopifyWithoutReference.lines[0].externalLineId = "shop-line-historical-without-reference";
    shopifyWithoutReference.refunds = [];
    await orders.importOrders([shopifyWithoutReference], {
      id: 1,
      requestId: "test-import-shopify-history-without-reference",
    });
    const shopifyWithoutReferenceId = (
      await database
        .getPool()
        .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
          shopifyWithoutReference.externalOrderId,
        ])
    ).rows[0]!.id;
    const shopifyInvoiceWithoutReference = Buffer.from(
      (await readFile("tests/fixtures/fatturapa/accepted-invoice.anonymized.xml", "utf8"))
        .replace("FPR 0001/26", "FPR 0030/26")
        .replace("Vendita beni usati - Ordine Shopify #1001", "Vendita beni usati")
        .replace("<Data>2026-08-10</Data>", "<Data>2026-08-19</Data>")
        .replaceAll("123.45", "120.00"),
    );
    await assert.rejects(
      orders.reconcileHistoricalOrder(
        shopifyWithoutReferenceId,
        {
          outcome: "ALREADY_INVOICED",
          reference: "Documento Aruba al lordo della commissione Shopify Payments",
          invoiceXml: Buffer.from(
            shopifyInvoiceWithoutReference.toString().replaceAll("120.00", "122.00"),
          ),
        },
        { id: 1, canApprove: true, requestId: "test-reconcile-shopify-history-gross-amount" },
      ),
      (error: unknown) =>
        error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
    );
    await assert.rejects(
      orders.reconcileHistoricalOrder(
        shopifyWithoutReferenceId,
        {
          outcome: "ALREADY_INVOICED",
          reference: "Documento Aruba riferito a un altro ordine Shopify",
          invoiceXml: Buffer.from(
            shopifyInvoiceWithoutReference
              .toString()
              .replace("Vendita beni usati", "Vendita beni usati - Ordine #1002 Shopify"),
          ),
        },
        {
          id: 1,
          canApprove: true,
          requestId: "test-reconcile-shopify-history-reference-before-provider",
        },
      ),
      (error: unknown) =>
        error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
    );
    await assert.rejects(
      orders.reconcileHistoricalOrder(
        shopifyWithoutReferenceId,
        {
          outcome: "ALREADY_INVOICED",
          reference: "Documento Aruba con riferimento Shopify distante",
          invoiceXml: Buffer.from(
            shopifyInvoiceWithoutReference
              .toString()
              .replace(
                "Vendita beni usati",
                `Ordine #1002 ${"descrizione estesa ".repeat(8)}Shopify`,
              ),
          ),
        },
        {
          id: 1,
          canApprove: true,
          requestId: "test-reconcile-shopify-history-distant-reference",
        },
      ),
      (error: unknown) =>
        error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
    );
    await orders.reconcileHistoricalOrder(
      shopifyWithoutReferenceId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba univoco sul totale fatturabile Shopify Payments",
        invoiceXml: shopifyInvoiceWithoutReference,
      },
      { id: 1, canApprove: true, requestId: "test-reconcile-shopify-history-without-reference" },
    );
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT document_orders.amount, documents.origin
           FROM document_orders
           JOIN documents ON documents.id = document_orders.document_id
           WHERE document_orders.order_id = $1`,
          [shopifyWithoutReferenceId],
        )
      ).rows[0],
      { amount: 12_000, origin: "ARUBA_HISTORY" },
    );
    const ambiguousShopifyFirst = structuredClone(shopifyWithoutReference);
    ambiguousShopifyFirst.externalOrderId = "shop-order-historical-ambiguous-first";
    ambiguousShopifyFirst.displayNumber = "#S-HIST-AMB-1";
    ambiguousShopifyFirst.total = "91.00";
    ambiguousShopifyFirst.payments[0].externalPaymentId = "shop-payment-historical-ambiguous-first";
    ambiguousShopifyFirst.payments[0].amount = "91.00";
    delete ambiguousShopifyFirst.payments[0].shopifyPaymentsFeeAmount;
    ambiguousShopifyFirst.lines[0].externalLineId = "shop-line-historical-ambiguous-first";
    ambiguousShopifyFirst.lines[0].grossAmount = "91.00";
    const ambiguousShopifySecond = structuredClone(ambiguousShopifyFirst);
    ambiguousShopifySecond.externalOrderId = "shop-order-historical-ambiguous-second";
    ambiguousShopifySecond.displayNumber = "#S-HIST-AMB-2";
    ambiguousShopifySecond.updatedAt = "2026-08-18T09:15:00Z";
    ambiguousShopifySecond.payments[0].externalPaymentId =
      "shop-payment-historical-ambiguous-second";
    ambiguousShopifySecond.lines[0].externalLineId = "shop-line-historical-ambiguous-second";
    await orders.importOrders([ambiguousShopifyFirst, ambiguousShopifySecond], {
      id: 1,
      requestId: "test-import-shopify-history-ambiguous-without-reference",
    });
    const ambiguousShopifyIds = (
      await database.getPool().query<{ id: string; external_order_id: string }>(
        `SELECT id, external_order_id FROM orders
         WHERE external_order_id IN ($1, $2)`,
        [ambiguousShopifyFirst.externalOrderId, ambiguousShopifySecond.externalOrderId],
      )
    ).rows;
    const ambiguousShopifyFirstId = ambiguousShopifyIds.find(
      (order) => order.external_order_id === ambiguousShopifyFirst.externalOrderId,
    )!.id;
    const ambiguousShopifySecondId = ambiguousShopifyIds.find(
      (order) => order.external_order_id === ambiguousShopifySecond.externalOrderId,
    )!.id;
    await assert.rejects(
      orders.reconcileHistoricalOrder(
        ambiguousShopifyFirstId,
        {
          outcome: "ALREADY_INVOICED",
          reference: "Documento Aruba ambiguo fra due ordini Shopify",
          invoiceXml: Buffer.from(
            shopifyInvoiceWithoutReference
              .toString()
              .replace("FPR 0030/26", "FPR 0031/26")
              .replaceAll("120.00", "91.00"),
          ),
        },
        { id: 1, canApprove: true, requestId: "test-reconcile-shopify-history-ambiguous" },
      ),
      (error: unknown) =>
        error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
    );
    await orders.reconcileHistoricalOrder(
      ambiguousShopifySecondId,
      {
        outcome: "NOT_INVOICED",
        reference: "Ordine duplicato di prova escluso dopo il confronto Aruba",
      },
      { id: 1, canApprove: true, requestId: "test-clear-shopify-history-ambiguous" },
    );
    const ebayWithoutReference = structuredClone(fixture[1]);
    ebayWithoutReference.externalOrderId = "ebay-order-historical-without-reference";
    ebayWithoutReference.externalCustomerId = "ebay-customer-historical-without-reference";
    ebayWithoutReference.displayNumber = "26-12345-67890";
    ebayWithoutReference.customer.taxIdentifiers = [];
    delete ebayWithoutReference.customer.firstName;
    delete ebayWithoutReference.customer.lastName;
    ebayWithoutReference.customer.billingAddress = {
      line1: "Via Cliente 2",
      postalCode: "00100",
      city: "Roma",
      province: "RM",
      countryCode: "IT",
    };
    ebayWithoutReference.historical = true;
    ebayWithoutReference.createdAt = "2026-08-18T08:00:00Z";
    ebayWithoutReference.updatedAt = "2026-08-18T09:00:00Z";
    ebayWithoutReference.refunds = [];
    ebayWithoutReference.payments[0].externalPaymentId =
      "ebay-payment-historical-without-reference";
    ebayWithoutReference.lines[0].externalLineId = "ebay-line-historical-without-reference";
    const indistinguishableEbay = structuredClone(ebayWithoutReference);
    indistinguishableEbay.externalOrderId = "ebay-order-historical-indistinguishable";
    indistinguishableEbay.displayNumber = "26-12345-67891";
    indistinguishableEbay.payments[0].externalPaymentId =
      "ebay-payment-historical-indistinguishable";
    indistinguishableEbay.lines[0].externalLineId = "ebay-line-historical-indistinguishable";
    await orders.importOrders([ebayWithoutReference, indistinguishableEbay], {
      id: 1,
      requestId: "test-import-ebay-history-without-reference",
    });
    const ebayWithoutReferenceIds = (
      await database.getPool().query<{ id: string; external_order_id: string }>(
        `SELECT id, external_order_id FROM orders
         WHERE external_order_id IN ($1, $2) ORDER BY external_order_id`,
        [ebayWithoutReference.externalOrderId, indistinguishableEbay.externalOrderId],
      )
    ).rows;
    const ebayWithoutReferenceId = ebayWithoutReferenceIds.find(
      (order) => order.external_order_id === ebayWithoutReference.externalOrderId,
    )!.id;
    const indistinguishableEbayId = ebayWithoutReferenceIds.find(
      (order) => order.external_order_id === indistinguishableEbay.externalOrderId,
    )!.id;
    const ebayInvoiceWithoutReference = Buffer.from(
      (await readFile("tests/fixtures/fatturapa/accepted-invoice.anonymized.xml", "utf8"))
        .replace("FPR 0001/26", "FPR 0020/26")
        .replace("Vendita beni usati - Ordine Shopify #1001", "Vendita beni usati")
        .replace("<Data>2026-08-10</Data>", "<Data>2026-08-19</Data>")
        .replaceAll("123.45", "75.00"),
    );
    await assert.rejects(
      orders.reconcileHistoricalOrder(
        ebayWithoutReferenceId,
        {
          outcome: "ALREADY_INVOICED",
          reference: "Documento Aruba senza riferimento eBay ma con due ordini compatibili",
          invoiceXml: ebayInvoiceWithoutReference,
        },
        { id: 1, canApprove: true, requestId: "test-reconcile-ebay-history-ambiguous" },
      ),
      (error: unknown) =>
        error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
    );
    await orders.reconcileHistoricalOrder(
      indistinguishableEbayId,
      {
        outcome: "NOT_INVOICED",
        reference: "Ordine duplicato di prova escluso dopo verifica Aruba",
      },
      { id: 1, canApprove: true, requestId: "test-clear-indistinguishable-ebay-history" },
    );
    const indistinguishableShopify = structuredClone(ebayWithoutReference);
    indistinguishableShopify.provider = "SHOPIFY";
    indistinguishableShopify.externalAccountId = "shop.example.invalid";
    indistinguishableShopify.externalOrderId = "shop-order-historical-indistinguishable";
    indistinguishableShopify.externalCustomerId = "shop-customer-historical-indistinguishable";
    indistinguishableShopify.displayNumber = "#S-HIST-INDISTINGUISHABLE";
    indistinguishableShopify.updatedAt = "2026-08-18T09:15:00Z";
    indistinguishableShopify.payments[0].externalPaymentId =
      "shop-payment-historical-indistinguishable";
    indistinguishableShopify.lines[0].externalLineId = "shop-line-historical-indistinguishable";
    await orders.importOrders([indistinguishableShopify], {
      id: 1,
      requestId: "test-import-shopify-history-indistinguishable-from-ebay",
    });
    const indistinguishableShopifyId = (
      await database
        .getPool()
        .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
          indistinguishableShopify.externalOrderId,
        ])
    ).rows[0]!.id;
    await assert.rejects(
      orders.reconcileHistoricalOrder(
        ebayWithoutReferenceId,
        {
          outcome: "ALREADY_INVOICED",
          reference: "Documento Aruba senza riferimento ambiguo fra eBay e Shopify",
          invoiceXml: ebayInvoiceWithoutReference,
        },
        { id: 1, canApprove: true, requestId: "test-reconcile-cross-provider-ambiguous" },
      ),
      (error: unknown) =>
        error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
    );
    await orders.reconcileHistoricalOrder(
      indistinguishableShopifyId,
      {
        outcome: "NOT_INVOICED",
        reference: "Ordine Shopify di prova escluso dopo verifica Aruba",
      },
      { id: 1, canApprove: true, requestId: "test-clear-indistinguishable-shopify-history" },
    );
    await assert.rejects(
      orders.reconcileHistoricalOrder(
        ebayWithoutReferenceId,
        {
          outcome: "ALREADY_INVOICED",
          reference: "Documento Aruba senza riferimento eBay con destinatario diverso",
          invoiceXml: Buffer.from(
            ebayInvoiceWithoutReference
              .toString()
              .replace("<Nome>Mario</Nome>", "<Nome>Luigi</Nome>"),
          ),
        },
        { id: 1, canApprove: true, requestId: "test-reconcile-ebay-history-wrong-recipient" },
      ),
      (error: unknown) =>
        error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
    );
    await assert.rejects(
      orders.reconcileHistoricalOrder(
        ebayWithoutReferenceId,
        {
          outcome: "ALREADY_INVOICED",
          reference: "Documento Aruba senza riferimento eBay con importo diverso",
          invoiceXml: Buffer.from(
            ebayInvoiceWithoutReference.toString().replaceAll("75.00", "74.00"),
          ),
        },
        { id: 1, canApprove: true, requestId: "test-reconcile-ebay-history-wrong-amount" },
      ),
      (error: unknown) =>
        error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
    );
    await orders.reconcileHistoricalOrder(
      ebayWithoutReferenceId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba senza riferimento eBay con prova univoca completa",
        invoiceXml: ebayInvoiceWithoutReference,
      },
      { id: 1, canApprove: true, requestId: "test-reconcile-ebay-history-without-reference" },
    );
    assert.equal(
      (
        await database.getPool().query(
          `SELECT count(*)::int AS count
           FROM document_orders
           JOIN documents ON documents.id = document_orders.document_id
           WHERE document_orders.order_id = $1 AND documents.origin = 'ARUBA_HISTORY'`,
          [ebayWithoutReferenceId],
        )
      ).rows[0].count,
      1,
    );
    const reusedEbayInvoice = structuredClone(ebayWithoutReference);
    reusedEbayInvoice.externalOrderId = "ebay-order-historical-reused-document";
    reusedEbayInvoice.displayNumber = "26-12345-67892";
    reusedEbayInvoice.updatedAt = "2026-08-18T09:30:00Z";
    reusedEbayInvoice.payments[0].externalPaymentId = "ebay-payment-historical-reused-document";
    reusedEbayInvoice.lines[0].externalLineId = "ebay-line-historical-reused-document";
    await orders.importOrders([reusedEbayInvoice], {
      id: 1,
      requestId: "test-import-ebay-history-reused-document",
    });
    const reusedEbayInvoiceId = (
      await database
        .getPool()
        .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
          reusedEbayInvoice.externalOrderId,
        ])
    ).rows[0]!.id;
    await assert.rejects(
      orders.reconcileHistoricalOrder(
        reusedEbayInvoiceId,
        {
          outcome: "ALREADY_INVOICED",
          reference: "Lo stesso documento Aruba non può essere riutilizzato senza riferimento",
          invoiceXml: ebayInvoiceWithoutReference,
        },
        { id: 1, canApprove: true, requestId: "test-reconcile-ebay-history-reused-document" },
      ),
      (error: unknown) =>
        error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
    );
    await orders.reconcileHistoricalOrder(
      reusedEbayInvoiceId,
      {
        outcome: "NOT_INVOICED",
        reference: "Ordine di prova escluso dopo il controllo sul documento già collegato",
      },
      { id: 1, canApprove: true, requestId: "test-clear-ebay-history-reused-document" },
    );
    const ambiguousRefundEbay = structuredClone(ebayWithoutReference);
    ambiguousRefundEbay.externalOrderId = "ebay-order-historical-ambiguous-refund";
    ambiguousRefundEbay.displayNumber = "26-12345-67893";
    ambiguousRefundEbay.updatedAt = "2026-08-18T09:45:00Z";
    ambiguousRefundEbay.payments[0].externalPaymentId = "ebay-payment-historical-ambiguous-refund";
    ambiguousRefundEbay.lines[0].externalLineId = "ebay-line-historical-ambiguous-refund";
    ambiguousRefundEbay.refunds = [
      {
        externalRefundId: "ebay-refund-historical-ambiguous",
        status: "AMBIGUOUS",
        amount: null,
        completedAt: "2026-08-18T09:40:00Z",
        raw: {},
      },
    ];
    await orders.importOrders([ambiguousRefundEbay], {
      id: 1,
      requestId: "test-import-ebay-history-ambiguous-refund",
    });
    const ambiguousRefundEbayId = (
      await database
        .getPool()
        .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
          ambiguousRefundEbay.externalOrderId,
        ])
    ).rows[0]!.id;
    await assert.rejects(
      orders.reconcileHistoricalOrder(
        ambiguousRefundEbayId,
        {
          outcome: "ALREADY_INVOICED",
          reference: "Il rimborso ambiguo impedisce il fallback senza riferimento eBay",
          invoiceXml: Buffer.from(
            ebayInvoiceWithoutReference.toString().replace("FPR 0020/26", "FPR 0021/26"),
          ),
        },
        { id: 1, canApprove: true, requestId: "test-reconcile-ebay-history-ambiguous-refund" },
      ),
      (error: unknown) =>
        error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
    );
    const historicalInvoiceXml = Buffer.from(
      (await readFile("tests/fixtures/fatturapa/accepted-invoice.anonymized.xml", "utf8"))
        .replace("FPR 0001/26", "FPR 0010/26")
        .replace("#1001", "#S-1001")
        .replace("<Data>2026-08-10</Data>", "<Data>2026-08-19</Data>")
        .replaceAll("123.45", "122.00"),
    );
    await database.getPool().query(
      `UPDATE orders SET trigger_status = 'INVOICED',
         historical_reconciliation_outcome = 'ALREADY_INVOICED',
         historical_reconciliation_reference = 'Documento Aruba da collegare dopo aggiornamento',
         historical_reconciled_at = now()
       WHERE id = $1`,
      [alreadyInvoicedId],
    );
    assert.ok(
      (await orders.listOpenActivities()).rows.some(
        (activity) => activity.kind === "ORDER" && activity.id === String(alreadyInvoicedId),
      ),
    );
    await assert.rejects(
      orders.reconcileHistoricalOrder(
        alreadyInvoicedId,
        {
          outcome: "ALREADY_INVOICED",
          reference: "Documento Aruba precedente all’ordine",
          invoiceXml: Buffer.from(
            historicalInvoiceXml
              .toString()
              .replace("<Data>2026-08-19</Data>", "<Data>2026-08-18</Data>"),
          ),
        },
        { id: 1, canApprove: true, requestId: "test-reconcile-invoice-before-order" },
      ),
      (error: unknown) =>
        error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
    );
    await assert.rejects(
      orders.reconcileHistoricalOrder(
        alreadyInvoicedId,
        {
          outcome: "ALREADY_INVOICED",
          reference: "Documento Aruba non riferito all’ordine",
          invoiceXml: Buffer.from(
            historicalInvoiceXml
              .toString()
              .replace("#S-1001", "#S-10010")
              .replace("</FatturaElettronica>", "<!-- Shopify #S-1001 --></FatturaElettronica>"),
          ),
        },
        { id: 1, canApprove: true, requestId: "test-reconcile-unrelated-invoice" },
      ),
      (error: unknown) =>
        error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
    );
    await orders.reconcileHistoricalOrder(
      alreadyInvoicedId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba FPR 0010/26 verificato",
        invoiceXml: historicalInvoiceXml,
      },
      { id: 1, canApprove: true, requestId: "test-reconcile-historical-invoiced" },
    );
    const historicalDocumentCount = Number(
      (
        await database
          .getPool()
          .query("SELECT count(*) FROM documents WHERE origin = 'ARUBA_HISTORY'")
      ).rows[0].count,
    );
    await assert.rejects(
      orders.reconcileHistoricalOrder(
        alreadyInvoicedId,
        {
          outcome: "ALREADY_INVOICED",
          reference: "Secondo collegamento non consentito",
          invoiceXml: Buffer.from(historicalInvoiceXml.toString().replace("0010/26", "0011/26")),
        },
        { id: 1, canApprove: true, requestId: "test-reconcile-historical-twice" },
      ),
      (error: unknown) => error instanceof AppError && error.code === "CONFLICT_REVISION",
    );
    assert.equal(
      Number(
        (
          await database
            .getPool()
            .query("SELECT count(*) FROM documents WHERE origin = 'ARUBA_HISTORY'")
        ).rows[0].count,
      ),
      historicalDocumentCount,
    );
    const existingHistoricalRefundId = (
      await database
        .getPool()
        .query<{ id: string }>(
          "SELECT id FROM refunds WHERE external_refund_id = 'historical-invoiced-existing-refund'",
        )
    ).rows[0]!.id;
    const historicalCreditNoteId = await refunds.processRefund(existingHistoricalRefundId);
    assert.ok(historicalCreditNoteId);
    assert.equal(
      (await refunds.getCreditNoteProjection(historicalCreditNoteId!))?.invoiceNumber,
      "FPR 0010/26",
    );
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT applied_before_issue,
                  (SELECT count(*)::int FROM jobs
                   WHERE type = 'process_refund'
                     AND payload_json ->> 'refundId' = refunds.id::text) AS jobs
           FROM refunds WHERE external_refund_id = 'historical-invoiced-existing-refund'`,
        )
      ).rows[0],
      { applied_before_issue: false, jobs: 1 },
    );

    const netHistorical = structuredClone(historical);
    netHistorical.externalOrderId = "shop-order-historical-net-invoice";
    netHistorical.displayNumber = "#S-HIST-NET";
    netHistorical.customer.taxIdentifiers[0].value = "RSSMRA80A01H501U";
    netHistorical.historical = true;
    netHistorical.updatedAt = "2026-08-19T09:50:00Z";
    netHistorical.payments[0].externalPaymentId = "historical-net-invoice-payment";
    netHistorical.payments[0].method = "shopify_payments";
    netHistorical.payments[0].shopifyPaymentsFeeAmount = "2.00";
    netHistorical.refunds = [
      {
        externalRefundId: "historical-net-invoice-refund",
        status: "COMPLETED",
        amount: "10.00",
        completedAt: "2026-08-18T09:40:00Z",
        raw: {},
      },
      {
        externalRefundId: "historical-net-invoice-post-refund",
        status: "COMPLETED",
        amount: "5.00",
        completedAt: "2026-08-20T09:40:00Z",
        raw: {},
      },
    ];
    await orders.importOrders([netHistorical], {
      id: 1,
      requestId: "test-import-historical-net-invoice",
    });
    const netHistoricalId = (
      await database
        .getPool()
        .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
          netHistorical.externalOrderId,
        ])
    ).rows[0]!.id;
    await orders.reconcileHistoricalOrder(
      netHistoricalId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba netto del rimborso pre-emissione",
        invoiceXml: Buffer.from(
          (await readFile("tests/fixtures/fatturapa/accepted-invoice.anonymized.xml", "utf8"))
            .replace("FPR 0001/26", "FPR 0011/26")
            .replace("#1001", netHistorical.displayNumber)
            .replace("<Data>2026-08-10</Data>", "<Data>2026-08-19</Data>")
            .replaceAll("123.45", "110.00")
            .replace(/\s*<Contatti>[\s\S]*?<\/Contatti>/, ""),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reconcile-historical-net-invoice" },
    );
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT refunds.external_refund_id, refunds.applied_before_issue,
                  document_orders.amount,
                  (SELECT count(*)::int FROM jobs
                   WHERE type = 'process_refund'
                     AND payload_json ->> 'refundId' = refunds.id::text) AS jobs
           FROM refunds
           JOIN document_orders ON document_orders.order_id = refunds.order_id
           WHERE refunds.external_refund_id IN
             ('historical-net-invoice-refund', 'historical-net-invoice-post-refund')
           ORDER BY refunds.external_refund_id`,
        )
      ).rows,
      [
        {
          external_refund_id: "historical-net-invoice-post-refund",
          applied_before_issue: false,
          amount: 11000,
          jobs: 1,
        },
        {
          external_refund_id: "historical-net-invoice-refund",
          applied_before_issue: true,
          amount: 11000,
          jobs: 0,
        },
      ],
    );
    const groupedHistoricalFirst = structuredClone(historical);
    groupedHistoricalFirst.externalOrderId = "shop-order-historical-grouped-first";
    groupedHistoricalFirst.displayNumber = "#S-HIST-GROUP-1";
    groupedHistoricalFirst.customer.taxIdentifiers[0].value = "RSSMRA80A01H501U";
    groupedHistoricalFirst.historical = true;
    groupedHistoricalFirst.updatedAt = "2026-08-19T09:55:00Z";
    groupedHistoricalFirst.payments[0].externalPaymentId = "historical-grouped-first-payment";
    const groupedHistoricalSecond = structuredClone(groupedHistoricalFirst);
    groupedHistoricalSecond.externalOrderId = "shop-order-historical-grouped-second";
    groupedHistoricalSecond.displayNumber = "#S-HIST-GROUP-2";
    groupedHistoricalSecond.payments[0].externalPaymentId = "historical-grouped-second-payment";
    await orders.importOrders([groupedHistoricalFirst, groupedHistoricalSecond], {
      id: 1,
      requestId: "test-import-historical-grouped-invoice",
    });
    const groupedIds = (
      await database.getPool().query<{ id: string; external_order_id: string }>(
        `SELECT id, external_order_id FROM orders
         WHERE external_order_id IN ($1, $2) ORDER BY external_order_id`,
        [groupedHistoricalFirst.externalOrderId, groupedHistoricalSecond.externalOrderId],
      )
    ).rows;
    const groupedLine = `<DettaglioLinee>
        <NumeroLinea>2</NumeroLinea>
        <Descrizione>Vendita beni usati - Ordine Shopify #S-HIST-GROUP-2</Descrizione>
        <Quantita>1.00</Quantita>
        <PrezzoUnitario>122.00</PrezzoUnitario>
        <PrezzoTotale>122.00</PrezzoTotale>
        <AliquotaIVA>0.00</AliquotaIVA>
        <Natura>N5</Natura>
      </DettaglioLinee>`;
    const groupedInvoiceXml = Buffer.from(
      (await readFile("tests/fixtures/fatturapa/accepted-invoice.anonymized.xml", "utf8"))
        .replace("FPR 0001/26", "FPR 0012/26")
        .replace("#1001", "#S-HIST-GROUP-1")
        .replace("<Data>2026-08-10</Data>", "<Data>2026-08-19</Data>")
        .replaceAll("123.45", "122.00")
        .replace("</DettaglioLinee>", `</DettaglioLinee>\n      ${groupedLine}`)
        .replace("<ImportoTotaleDocumento>122.00", "<ImportoTotaleDocumento>244.00")
        .replace("<ImponibileImporto>122.00", "<ImponibileImporto>244.00")
        .replace("<ImportoPagamento>122.00", "<ImportoPagamento>244.00"),
    );
    for (const grouped of groupedIds) {
      await orders.reconcileHistoricalOrder(
        grouped.id,
        {
          outcome: "ALREADY_INVOICED",
          reference: "Documento Aruba cumulativo verificato",
          invoiceXml: groupedInvoiceXml,
        },
        { id: 1, canApprove: true, requestId: `test-reconcile-${grouped.external_order_id}` },
      );
    }
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT count(DISTINCT documents.id)::int AS documents,
                  count(document_orders.order_id)::int AS orders,
                  sum(document_orders.amount)::int AS attributed_amount,
                  max(documents.total_amount)::int AS document_total
           FROM documents
           JOIN document_orders ON document_orders.document_id = documents.id
           WHERE documents.fiscal_number = 12 AND documents.fiscal_year = 2026`,
        )
      ).rows[0],
      { documents: 1, orders: 2, attributed_amount: 24400, document_total: 24400 },
    );
    const historicalWithoutTaxId = structuredClone(historical);
    historicalWithoutTaxId.externalOrderId = "shop-order-historical-without-tax-id";
    historicalWithoutTaxId.externalCustomerId = "shop-customer-historical-without-tax-id";
    historicalWithoutTaxId.displayNumber = "#S-HIST-NO-TAX-ID";
    historicalWithoutTaxId.customer.taxIdentifiers = [];
    historicalWithoutTaxId.customer.billingAddress = {
      line1: "Via Cliente 2",
      postalCode: "00100",
      city: "Roma",
      province: "RM",
      countryCode: "IT",
    };
    historicalWithoutTaxId.historical = true;
    historicalWithoutTaxId.updatedAt = "2026-08-19T09:57:00Z";
    historicalWithoutTaxId.payments[0].externalPaymentId = "historical-without-tax-id-payment";
    await orders.importOrders([historicalWithoutTaxId], {
      id: 1,
      requestId: "test-import-historical-without-tax-id",
    });
    const historicalWithoutTaxIdId = (
      await database
        .getPool()
        .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
          historicalWithoutTaxId.externalOrderId,
        ])
    ).rows[0]!.id;
    const historicalWithoutTaxIdXml = Buffer.from(
      (await readFile("tests/fixtures/fatturapa/accepted-invoice.anonymized.xml", "utf8"))
        .replace("FPR 0001/26", "FPR 0013/26")
        .replace("#1001", historicalWithoutTaxId.displayNumber)
        .replace("<Data>2026-08-10</Data>", "<Data>2026-08-19</Data>")
        .replaceAll("123.45", "122.00"),
    );
    await assert.rejects(
      orders.reconcileHistoricalOrder(
        historicalWithoutTaxIdId,
        {
          outcome: "ALREADY_INVOICED",
          reference: "Documento Aruba con destinatario diverso",
          invoiceXml: Buffer.from(
            historicalWithoutTaxIdXml
              .toString()
              .replace("<Nome>Mario</Nome>", "<Nome>Luigi</Nome>"),
          ),
        },
        { id: 1, canApprove: true, requestId: "test-reconcile-wrong-recipient-without-tax-id" },
      ),
      (error: unknown) =>
        error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
    );
    await orders.reconcileHistoricalOrder(
      historicalWithoutTaxIdId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba con destinatario verificato senza identificativo fiscale",
        invoiceXml: historicalWithoutTaxIdXml,
      },
      { id: 1, canApprove: true, requestId: "test-reconcile-recipient-without-tax-id" },
    );
    const historicalWithDifferentTaxIdType = structuredClone(historical);
    historicalWithDifferentTaxIdType.externalOrderId = "shop-order-historical-tax-id-type";
    historicalWithDifferentTaxIdType.externalCustomerId = "shop-customer-historical-tax-id-type";
    historicalWithDifferentTaxIdType.displayNumber = "#S-HIST-TAX-ID-TYPE";
    historicalWithDifferentTaxIdType.customer.kind = "BUSINESS_IT";
    historicalWithDifferentTaxIdType.customer.companyName = "Cliente Esempio Srl";
    historicalWithDifferentTaxIdType.customer.taxIdentifiers = [
      {
        type: "PARTITA_IVA",
        value: "10987654321",
        countryCode: "IT",
        sourceField: "test",
      },
    ];
    historicalWithDifferentTaxIdType.historical = true;
    historicalWithDifferentTaxIdType.updatedAt = "2026-08-19T09:59:00Z";
    historicalWithDifferentTaxIdType.payments[0].externalPaymentId =
      "historical-tax-id-type-payment";
    await orders.importOrders([historicalWithDifferentTaxIdType], {
      id: 1,
      requestId: "test-import-historical-tax-id-type",
    });
    const historicalWithDifferentTaxIdTypeId = (
      await database
        .getPool()
        .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
          historicalWithDifferentTaxIdType.externalOrderId,
        ])
    ).rows[0]!.id;
    await assert.rejects(
      orders.reconcileHistoricalOrder(
        historicalWithDifferentTaxIdTypeId,
        {
          outcome: "ALREADY_INVOICED",
          reference: "Identificativo uguale ma tipo fiscale differente",
          invoiceXml: Buffer.from(
            (await readFile("tests/fixtures/fatturapa/accepted-invoice.anonymized.xml", "utf8"))
              .replace("FPR 0001/26", "FPR 0014/26")
              .replace("#1001", historicalWithDifferentTaxIdType.displayNumber)
              .replace("<Data>2026-08-10</Data>", "<Data>2026-08-19</Data>")
              .replace("RSSMRA80A01H501U", "10987654321")
              .replaceAll("123.45", "122.00"),
          ),
        },
        { id: 1, canApprove: true, requestId: "test-reconcile-tax-id-type-mismatch" },
      ),
      (error: unknown) =>
        error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
    );
    await assert.rejects(
      orders.reconcileHistoricalOrder(
        historicalWithDifferentTaxIdTypeId,
        {
          outcome: "ALREADY_INVOICED",
          reference: "Partita IVA uguale ma paese fiscale differente",
          invoiceXml: Buffer.from(
            (await readFile("tests/fixtures/fatturapa/accepted-invoice.anonymized.xml", "utf8"))
              .replace("FPR 0001/26", "FPR 0015/26")
              .replace("#1001", historicalWithDifferentTaxIdType.displayNumber)
              .replace("<Data>2026-08-10</Data>", "<Data>2026-08-19</Data>")
              .replace(
                "<CodiceFiscale>",
                "<IdFiscaleIVA><IdPaese>DE</IdPaese><IdCodice>10987654321</IdCodice></IdFiscaleIVA><CodiceFiscale>",
              )
              .replaceAll("123.45", "122.00"),
          ),
        },
        { id: 1, canApprove: true, requestId: "test-reconcile-tax-id-country-mismatch" },
      ),
      (error: unknown) =>
        error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
    );
    alreadyInvoiced.updatedAt = "2026-08-19T10:00:00Z";
    alreadyInvoiced.historical = false;
    await orders.importOrders([alreadyInvoiced], {
      id: 1,
      requestId: "test-reimport-historical-invoiced",
    });
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT trigger_status, billing_case_id, historical_reconciliation_outcome,
                  normalized_snapshot_json ->> 'historical' AS historical
           FROM orders WHERE id = $1`,
          [alreadyInvoicedId],
        )
      ).rows[0],
      {
        trigger_status: "INVOICED",
        billing_case_id: null,
        historical_reconciliation_outcome: "ALREADY_INVOICED",
        historical: "true",
      },
    );
    alreadyInvoiced.updatedAt = "2026-08-19T10:30:00Z";
    alreadyInvoiced.refunds.push({
      externalRefundId: "historical-invoiced-total-refund",
      status: "COMPLETED",
      amount: alreadyInvoiced.total,
      completedAt: "2026-08-19T10:30:00Z",
      raw: {},
    });
    await orders.importOrders([alreadyInvoiced], {
      id: 1,
      requestId: "test-refund-reimported-historical-invoiced",
    });
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT orders.trigger_status, orders.billing_case_id,
                  orders.historical_reconciliation_outcome,
                  refunds.id AS refund_id, refunds.applied_before_issue,
                  (SELECT count(*)::int FROM jobs
                   WHERE type = 'process_refund'
                     AND payload_json ->> 'refundId' = refunds.id::text) AS jobs
           FROM orders JOIN refunds ON refunds.order_id = orders.id
           WHERE orders.id = $1
             AND refunds.external_refund_id = 'historical-invoiced-total-refund'`,
          [alreadyInvoicedId],
        )
      ).rows[0],
      {
        trigger_status: "INVOICED",
        billing_case_id: null,
        historical_reconciliation_outcome: "ALREADY_INVOICED",
        refund_id: (
          await database
            .getPool()
            .query(
              "SELECT id FROM refunds WHERE external_refund_id = 'historical-invoiced-total-refund'",
            )
        ).rows[0].id,
        applied_before_issue: false,
        jobs: 1,
      },
    );
    const historicalInvoicedRefundId = (
      await database
        .getPool()
        .query(
          "SELECT id FROM refunds WHERE external_refund_id = 'historical-invoiced-total-refund'",
        )
    ).rows[0].id;
    await assert.rejects(
      refunds.processRefund(historicalInvoicedRefundId),
      (error: unknown) => error instanceof AppError && error.code === "CREDIT_NOTE_LIMIT_EXCEEDED",
    );
    assert.equal(
      (
        await database.getPool().query(
          `SELECT count(*)::int AS count FROM audit_events
           WHERE action = 'REFUND_NEEDS_REVIEW' AND entity_type = 'REFUND' AND entity_id = $1`,
          [historicalInvoicedRefundId],
        )
      ).rows[0].count,
      0,
    );
    await assert.rejects(
      orders.forcePrepareOrder(alreadyInvoicedId, {
        id: 1,
        requestId: "test-force-reimported-historical",
      }),
      (error: unknown) => error instanceof AppError && error.code === "ORDER_NOT_PREPARABLE",
    );
    assert.equal(
      (
        await database
          .getPool()
          .query("SELECT count(*) FROM audit_events WHERE action = 'ORDER_HISTORY_RECONCILED'")
      ).rows[0].count,
      "12",
    );

    const historicalRefunded = structuredClone(fixture[0]);
    historicalRefunded.externalOrderId = "shop-order-historical-refunded";
    historicalRefunded.externalCustomerId = "shop-customer-historical-refunded";
    historicalRefunded.customer.taxIdentifiers[0].value = "RSSMRA80A01H501F";
    historicalRefunded.createdAt = "2026-08-19T11:00:00Z";
    historicalRefunded.updatedAt = "2026-08-19T12:00:00Z";
    historicalRefunded.historical = true;
    historicalRefunded.refunds = [
      {
        externalRefundId: "historical-total-refund",
        status: "COMPLETED",
        amount: historicalRefunded.total,
        completedAt: "2026-08-19T12:00:00Z",
        raw: {},
      },
    ];
    await orders.importOrders([historicalRefunded], {
      id: 1,
      requestId: "test-historical-refunded-import",
    });
    const historicalRefundedBefore = (
      await database
        .getPool()
        .query(
          `SELECT id, billing_case_id, trigger_status FROM orders WHERE external_order_id = $1`,
          [historicalRefunded.externalOrderId],
        )
    ).rows[0];
    assert.deepEqual(historicalRefundedBefore, {
      id: historicalRefundedBefore.id,
      billing_case_id: null,
      trigger_status: "LEGACY_BILLING_REVIEW",
    });
    const historicalRefundedResult = await orders.reconcileHistoricalOrder(
      historicalRefundedBefore.id,
      {
        outcome: "NOT_INVOICED",
        reference: "Ricerca Aruba per ordine rimborsato: nessun documento emesso",
      },
      { id: 1, canApprove: true, requestId: "test-historical-refunded-reconcile" },
    );
    assert.ok(historicalRefundedResult?.caseId);
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT orders.trigger_status, billing_cases.status
           FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
           WHERE orders.id = $1`,
          [historicalRefundedBefore.id],
        )
      ).rows[0],
      { trigger_status: "REFUNDED_BEFORE_ISSUE", status: "DO_NOT_TRANSMIT" },
    );

    const historicalPartialRefund = structuredClone(historicalRefunded);
    historicalPartialRefund.externalOrderId = "shop-order-historical-partial-refund";
    historicalPartialRefund.externalCustomerId = "shop-customer-historical-partial-refund";
    historicalPartialRefund.customer.taxIdentifiers[0].value = "RSSMRA80A01H501G";
    historicalPartialRefund.createdAt = "2026-08-19T13:00:00Z";
    historicalPartialRefund.updatedAt = "2026-08-19T14:00:00Z";
    historicalPartialRefund.refunds[0].externalRefundId = "historical-partial-refund";
    historicalPartialRefund.refunds[0].amount = "10.00";
    await orders.importOrders([historicalPartialRefund], {
      id: 1,
      requestId: "test-historical-partial-refund-import",
    });
    const historicalPartialId = (
      await database
        .getPool()
        .query("SELECT id FROM orders WHERE external_order_id = $1", [
          historicalPartialRefund.externalOrderId,
        ])
    ).rows[0].id;
    const historicalPartialResult = await orders.reconcileHistoricalOrder(
      historicalPartialId,
      {
        outcome: "NOT_INVOICED",
        reference: "Ricerca Aruba per ordine parzialmente rimborsato: nessun documento",
      },
      { id: 1, canApprove: true, requestId: "test-historical-partial-refund-reconcile" },
    );
    assert.ok(historicalPartialResult?.caseId);
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT orders.trigger_status, billing_cases.status,
                  (SELECT sum(amount)::integer FROM refunds
                   WHERE refunds.order_id = orders.id AND applied_before_issue) AS refunded
           FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
           WHERE orders.id = $1`,
          [historicalPartialId],
        )
      ).rows[0],
      { trigger_status: "GROUPED", status: "READY", refunded: 1000 },
    );

    const concurrentA = structuredClone(fixture[0]);
    concurrentA.externalOrderId = "shop-order-concurrent-a";
    concurrentA.externalCustomerId = "shop-customer-concurrent";
    concurrentA.customer.taxIdentifiers[0].value = "RSSMRA80A01H501Z";
    concurrentA.createdAt = "2026-08-17T08:00:00Z";
    concurrentA.updatedAt = "2026-08-17T09:00:00Z";
    const concurrentB = structuredClone(concurrentA);
    concurrentB.externalOrderId = "shop-order-concurrent-b";
    const concurrentImports = await Promise.all([
      orders.importOrders([concurrentA, concurrentB], {
        id: 1,
        requestId: "test-concurrent-forward",
      }),
      orders.importOrders([concurrentB, concurrentA], {
        id: 1,
        requestId: "test-concurrent-reverse",
      }),
    ]);
    assert.deepEqual(concurrentImports.map(({ imported }) => imported).sort(), [0, 2]);
    // Il criterio chiede una sola preparazione, non solo un solo import vincente.
    assert.equal(
      (
        await database.getPool().query(
          `SELECT count(DISTINCT billing_case_id) FROM orders
           WHERE external_order_id IN ($1, $2)`,
          [concurrentA.externalOrderId, concurrentB.externalOrderId],
        )
      ).rows[0].count,
      "1",
    );

    // 7.3: una preparazione già approvata non assorbe un ordine successivo dello stesso giorno.
    const afterApproval = structuredClone(fixture[0]);
    afterApproval.externalOrderId = "shop-order-after-approval";
    afterApproval.externalCustomerId = "shop-customer-after-approval";
    afterApproval.customer.taxIdentifiers[0].value = "RSSMRA80A01H501B";
    afterApproval.createdAt = "2026-08-23T08:00:00Z";
    afterApproval.updatedAt = "2026-08-23T09:00:00Z";
    await orders.importOrders([afterApproval], { id: 1, requestId: "test-before-approval" });
    const approvedDayCaseId = (
      await database
        .getPool()
        .query("SELECT billing_case_id FROM orders WHERE external_order_id = $1", [
          afterApproval.externalOrderId,
        ])
    ).rows[0].billing_case_id;
    await database
      .getPool()
      .query("UPDATE billing_cases SET status = 'APPROVED' WHERE id = $1", [approvedDayCaseId]);
    const sameDayOrder = structuredClone(afterApproval);
    sameDayOrder.externalOrderId = "shop-order-after-approval-second";
    sameDayOrder.payments[0].externalPaymentId = "shop-payment-after-approval-second";
    await orders.importOrders([sameDayOrder], { id: 1, requestId: "test-after-approval" });
    const sameDayCase = (
      await database.getPool().query(
        `SELECT orders.billing_case_id, billing_cases.status
           FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
           WHERE orders.external_order_id = $1`,
        [sameDayOrder.externalOrderId],
      )
    ).rows[0];
    assert.notEqual(sameDayCase.billing_case_id, approvedDayCaseId);
    assert.equal(sameDayCase.status, "READY");
    assert.equal(
      (
        await database
          .getPool()
          .query("SELECT status FROM billing_cases WHERE id = $1", [approvedDayCaseId])
      ).rows[0].status,
      "APPROVED",
    );

    // Il cambio del trigger non ricrea, non scioglie e non riapre una preparazione esistente.
    // Gli ordini ancora senza preparazione confluiscono invece nel giorno aperto.
    const settledCase = structuredClone(fixture[0]);
    settledCase.externalOrderId = "shop-order-trigger-settled";
    settledCase.externalCustomerId = "shop-customer-trigger-gate";
    settledCase.customer.taxIdentifiers[0].value = "RSSMRA80A01H501C";
    settledCase.createdAt = "2026-08-24T08:00:00Z";
    settledCase.updatedAt = "2026-08-24T09:00:00Z";
    const waitingSameDay = structuredClone(settledCase);
    waitingSameDay.externalOrderId = "shop-order-trigger-waiting";
    waitingSameDay.payments[0].externalPaymentId = "shop-payment-trigger-waiting";
    waitingSameDay.paymentStatus = "PENDING";
    waitingSameDay.payments[0].status = "PENDING";
    waitingSameDay.payments[0].paidAt = null;
    waitingSameDay.fulfillmentStatus = "FULFILLED";
    await database.getPool().query(
      `UPDATE settings SET value_json = '"PAID"', version = version + 1
       WHERE key = 'draft_trigger'`,
    );
    await orders.importOrders([settledCase, waitingSameDay], {
      id: 1,
      requestId: "test-trigger-gate-import",
    });
    const gateCaseBefore = (
      await database.getPool().query(
        `SELECT billing_cases.id, billing_cases.status,
                (SELECT count(*)::int FROM orders WHERE billing_case_id = billing_cases.id)
                  AS order_count
           FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
           WHERE orders.external_order_id = $1`,
        [settledCase.externalOrderId],
      )
    ).rows[0];
    assert.deepEqual(
      { status: gateCaseBefore.status, order_count: gateCaseBefore.order_count },
      { status: "READY", order_count: 1 },
    );
    const casesBeforeTrigger = (
      await database.getPool().query("SELECT count(*)::int AS total FROM billing_cases")
    ).rows[0].total;
    const triggerVersion = (
      await database.getPool().query("SELECT version FROM settings WHERE key = 'draft_trigger'")
    ).rows[0].version;
    await orders.setDraftTrigger("FULFILLED", triggerVersion, {
      id: 1,
      requestId: "test-trigger-gate-change",
    });
    const gateCaseAfter = (
      await database.getPool().query(
        `SELECT id, status,
                (SELECT count(*)::int FROM orders WHERE billing_case_id = billing_cases.id)
                  AS order_count
           FROM billing_cases WHERE id = $1`,
        [gateCaseBefore.id],
      )
    ).rows[0];
    assert.equal(gateCaseAfter.id, gateCaseBefore.id);
    assert.equal(gateCaseAfter.order_count, 2);
    assert.equal(gateCaseAfter.status, "NEEDS_REVIEW");
    assert.equal(
      (await database.getPool().query("SELECT count(*)::int AS total FROM billing_cases")).rows[0]
        .total,
      casesBeforeTrigger,
    );
    assert.equal(
      (
        await database.getPool().query(
          `SELECT count(*) FROM audit_events
           WHERE action = 'BILLING_CASE_CREATED' AND request_id = 'test-trigger-gate-change'`,
        )
      ).rows[0].count,
      "0",
    );

    // 13.5: separazione, aggiunta e ultimo ordine protetto sulla stessa preparazione.
    const gateCaseId = String(gateCaseBefore.id);
    const separatedOrderId = (
      await database
        .getPool()
        .query("SELECT id FROM orders WHERE external_order_id = $1", [
          waitingSameDay.externalOrderId,
        ])
    ).rows[0].id;
    await assert.rejects(
      orders.separateOrderFromBillingCase(gateCaseId, String(separatedOrderId), 0, {
        id: 1,
        requestId: "test-separate-stale-revision",
      }),
      (error: unknown) => error instanceof AppError && error.code === "CONFLICT_REVISION",
    );
    assert.equal(
      await orders.separateOrderFromBillingCase(
        gateCaseId,
        String(separatedOrderId),
        await caseRevision(gateCaseId),
        { id: 1, requestId: "test-separate-order" },
      ),
      "READY",
    );
    assert.deepEqual(
      (
        await database
          .getPool()
          .query("SELECT billing_case_id, trigger_status FROM orders WHERE id = $1", [
            separatedOrderId,
          ])
      ).rows[0],
      { billing_case_id: null, trigger_status: "ELIGIBLE" },
    );
    const separableCase = await orders.getBillingCase(gateCaseId);
    assert.equal(separableCase!.addableOrders.length, 1);
    assert.deepEqual(separableCase!.anomalies, []);
    await assert.rejects(
      orders.separateOrderFromBillingCase(
        gateCaseId,
        String(separableCase!.orders[0]!.id),
        await caseRevision(gateCaseId),
        { id: 1, requestId: "test-separate-last-order" },
      ),
      (error: unknown) => error instanceof AppError && error.code === "BILLING_CASE_EMPTY",
    );
    assert.equal(
      await orders.addOrderToBillingCase(
        gateCaseId,
        String(separatedOrderId),
        await caseRevision(gateCaseId),
        { id: 1, requestId: "test-add-order" },
      ),
      gateCaseId,
    );
    const recomposed = await orders.getBillingCase(gateCaseId);
    assert.equal(recomposed!.orders.length, 2);
    assert.deepEqual(recomposed!.anomalies, ["PENDING_PAYMENT"]);
    assert.equal(recomposed!.status, "NEEDS_REVIEW");

    // 7.5: un'anagrafica incompleta si chiude con la correzione, non cambiando la sorgente.
    const incompleteForCorrection = structuredClone(fixture[0]);
    incompleteForCorrection.externalOrderId = "shop-order-correction";
    incompleteForCorrection.externalCustomerId = "shop-customer-correction";
    incompleteForCorrection.customer.taxIdentifiers = [];
    incompleteForCorrection.customer.billingAddress = {};
    incompleteForCorrection.createdAt = "2026-08-25T08:00:00Z";
    incompleteForCorrection.updatedAt = "2026-08-25T09:00:00Z";
    await orders.importOrders([incompleteForCorrection], {
      id: 1,
      requestId: "test-correction-import",
    });
    const correctionCaseId = String(
      (
        await database
          .getPool()
          .query("SELECT billing_case_id FROM orders WHERE external_order_id = $1", [
            incompleteForCorrection.externalOrderId,
          ])
      ).rows[0].billing_case_id,
    );
    const beforeCorrection = await orders.getBillingCase(correctionCaseId);
    assert.equal(beforeCorrection!.status, "NEEDS_REVIEW");
    assert.ok(beforeCorrection!.anomalies.includes("CUSTOMER_INCOMPLETE"));
    const correction = {
      kind: "BUSINESS_IT",
      displayName: "Rossi Srl",
      companyName: "Rossi Srl",
      email: "amministrazione@example.invalid",
      billingAddress: {
        line1: "Via Esempio 1",
        postalCode: "20100",
        city: "Milano",
        province: "MI",
        countryCode: "IT",
      },
      taxIdentifiers: [
        { type: "CODICE_FISCALE", value: "RSSMRA80A01H501D", sourceField: "correzione-manuale" },
        { type: "PARTITA_IVA", value: "12345678901", sourceField: "correzione-manuale" },
      ],
    };
    await assert.rejects(
      orders.correctBillingCaseCustomer(correctionCaseId, correction, 0, null, {
        id: 1,
        requestId: "test-correction-stale",
      }),
      (error: unknown) => error instanceof AppError && error.code === "CONFLICT_REVISION",
    );
    await assert.rejects(
      orders.correctBillingCaseCustomer(
        correctionCaseId,
        { ...correction, email: "non-una-email" },
        await caseRevision(correctionCaseId),
        null,
        { id: 1, requestId: "test-correction-invalid" },
      ),
      (error: unknown) => error instanceof AppError && error.code === "ORDER_INVALID_INPUT",
    );
    assert.equal(
      await orders.correctBillingCaseCustomer(
        correctionCaseId,
        correction,
        await caseRevision(correctionCaseId),
        "Dati fiscali confermati dal cliente",
        { id: 1, requestId: "test-correction" },
      ),
      "READY",
    );
    const afterCorrection = await orders.getBillingCase(correctionCaseId);
    assert.deepEqual(afterCorrection!.anomalies, []);
    assert.equal(afterCorrection!.customer_name, "Rossi Srl");
    assert.ok(afterCorrection!.customer_corrected_at);
    // Una correzione non fiscale non cancella gli identificativi che non stava modificando.
    assert.equal(afterCorrection!.customer_snapshot_json.taxIdentifiers?.length, 2);
    assert.equal(
      await orders.correctBillingCaseCustomer(
        correctionCaseId,
        { ...correction, phone: "+39 02 0000000" },
        await caseRevision(correctionCaseId),
        null,
        { id: 1, requestId: "test-correction-non-fiscal" },
      ),
      "READY",
    );
    assert.equal(
      (await orders.getBillingCase(correctionCaseId))!.customer_snapshot_json.taxIdentifiers
        ?.length,
      2,
    );
    // L'ordine conserva il valore importato: la correzione non riscrive la storia.
    assert.equal(
      (
        await database.getPool().query(
          `SELECT normalized_snapshot_json #>> '{customerSnapshot,billingAddress,city}' AS city
           FROM orders WHERE external_order_id = $1`,
          [incompleteForCorrection.externalOrderId],
        )
      ).rows[0].city,
      null,
    );
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT before_json #>> '{billingAddress,city}' AS before_city,
                  after_json #>> '{billingAddress,city}' AS after_city, reason
             FROM audit_events
             WHERE action = 'CUSTOMER_CORRECTED' AND request_id = 'test-correction'`,
        )
      ).rows[0],
      {
        before_city: null,
        after_city: "Milano",
        reason: "Dati fiscali confermati dal cliente",
      },
    );

    // 7.3: l'identità non certa non accorpa e la corrispondenza possibile resta visibile.
    const ambiguousA = structuredClone(fixture[0]);
    ambiguousA.externalOrderId = "shop-order-ambiguous-a";
    delete ambiguousA.externalCustomerId;
    ambiguousA.createdAt = "2026-08-26T08:00:00Z";
    ambiguousA.updatedAt = "2026-08-26T09:00:00Z";
    ambiguousA.customer = { kind: "UNKNOWN", billingAddress: {}, taxIdentifiers: [] };
    const ambiguousB = structuredClone(ambiguousA);
    ambiguousB.externalOrderId = "shop-order-ambiguous-b";
    ambiguousB.payments[0].externalPaymentId = "shop-payment-ambiguous-b";
    await orders.importOrders([ambiguousA, ambiguousB], {
      id: 1,
      requestId: "test-ambiguous-grouping",
    });
    assert.equal(
      (
        await database.getPool().query(
          `SELECT count(DISTINCT billing_case_id) FROM orders
           WHERE external_order_id IN ($1, $2)`,
          [ambiguousA.externalOrderId, ambiguousB.externalOrderId],
        )
      ).rows[0].count,
      "2",
    );
    const ambiguousOrderId = (
      await database
        .getPool()
        .query("SELECT id FROM orders WHERE external_order_id = $1", [ambiguousA.externalOrderId])
    ).rows[0].id;
    assert.deepEqual((await orders.getOrder(String(ambiguousOrderId)))!.possibleMatches, []);
    const namedAmbiguous = structuredClone(ambiguousA);
    namedAmbiguous.externalOrderId = "shop-order-ambiguous-named";
    namedAmbiguous.payments[0].externalPaymentId = "shop-payment-ambiguous-named";
    namedAmbiguous.customer.displayName = fixture[0].customer.displayName;
    await orders.importOrders([namedAmbiguous], {
      id: 1,
      requestId: "test-ambiguous-named-match",
    });
    const namedAmbiguousOrderId = (
      await database
        .getPool()
        .query("SELECT id FROM orders WHERE external_order_id = $1", [
          namedAmbiguous.externalOrderId,
        ])
    ).rows[0].id;
    assert.ok(
      (await orders.getOrder(String(namedAmbiguousOrderId)))!.possibleMatches.some(
        (candidate) => candidate.display_name === fixture[0].customer.displayName,
      ),
    );
    assert.deepEqual((await orders.getOrder("1"))!.possibleMatches, []);

    // La ricerca tratta `%` come testo, non come carattere jolly.
    assert.deepEqual((await orders.listOrders({ query: "%" })).rows, []);
    assert.equal((await orders.listOrders({ query: "shop-order-ambiguous-a" })).rows.length, 1);
    // Una pagina fuori dal dominio PostgreSQL vale come prima pagina, non come errore.
    assert.deepEqual(
      (await orders.listOrders({ page: "Infinity" })).rows,
      (await orders.listOrders({ page: 1 })).rows,
    );

    // Le liste sono paginate: la pagina piena dichiara la successiva e non la ripete.
    await database.getPool().query(
      `INSERT INTO audit_events
        (actor_type, action, event_class, entity_type, entity_id, request_id)
       SELECT 'ADMIN', 'ORDER_GROUPED', 'OPERATIONAL', 'ORDER', generate_series::text,
              'test-pagina-' || generate_series
       FROM generate_series(1, $1)`,
      [PAGE_SIZE + 10],
    );
    const firstPage = await orders.listAuditHistory({ query: "test-pagina-" });
    const secondPage = await orders.listAuditHistory({ query: "test-pagina-", page: 2 });
    assert.equal(firstPage.rows.length, PAGE_SIZE);
    assert.equal(firstPage.hasNext, true);
    assert.equal(secondPage.rows.length, 10);
    assert.equal(secondPage.hasNext, false);
    assert.equal(
      firstPage.rows.some((event) => secondPage.rows.some((other) => other.id === event.id)),
      false,
    );
    await database
      .getPool()
      .query("DELETE FROM audit_events WHERE request_id LIKE 'test-pagina-%'");

    // Il registro attività espone ciò che richiede un intervento e la cronologia filtrabile.
    assert.ok(
      (await orders.listOpenActivities()).rows.some(
        (activity) => activity.href === `/ordini/preparazione/${gateCaseId}`,
      ),
    );
    const history = await orders.listAuditHistory({ action: "CUSTOMER_CORRECTED" });
    assert.equal(history.rows.length, 2);
    assert.equal(history.rows[1]!.reason, "Dati fiscali confermati dal cliente");
    assert.match(history.rows[0]!.case_number ?? "", /^\d{6}$/);
    // Un'azione fuori allowlist non deve valere "tutte".
    assert.deepEqual((await orders.listAuditHistory({ action: "NON_ESISTE" })).rows, []);
    assert.deepEqual((await orders.listAuditHistory({ query: "test\0non valido" })).rows, []);

    const mixedRefund = structuredClone(fixture[0]);
    mixedRefund.externalOrderId = "shop-order-mixed-refund";
    mixedRefund.displayNumber = "#MIXED-REFUND";
    mixedRefund.createdAt = "2026-08-20T08:00:00Z";
    mixedRefund.updatedAt = "2026-08-20T09:00:00Z";
    mixedRefund.refunds = [
      {
        externalRefundId: "completed-refund",
        status: "COMPLETED",
        amount: "25.00",
        completedAt: "2026-08-20T08:30:00Z",
        raw: {},
      },
      {
        externalRefundId: "pending-refund",
        status: "PENDING",
        amount: "10.00",
        completedAt: null,
        raw: {},
      },
    ];
    await orders.importOrders([mixedRefund], { id: 1, requestId: "test-mixed-refund" });
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT orders.trigger_status, billing_cases.status,
                  (orders.normalized_snapshot_json ->> 'orderReviewRequired')::boolean
                    AS review_required
           FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
           WHERE orders.external_order_id = $1`,
          [mixedRefund.externalOrderId],
        )
      ).rows[0],
      { trigger_status: "GROUPED", status: "READY", review_required: false },
    );
    const totalRefund = structuredClone(fixture[0]);
    totalRefund.externalOrderId = "shop-order-total-refund";
    totalRefund.displayNumber = "#TOTAL-REFUND";
    totalRefund.createdAt = "2026-08-20T10:00:00Z";
    totalRefund.updatedAt = "2026-08-20T11:00:00Z";
    totalRefund.refunds = [
      {
        externalRefundId: "total-refund",
        status: "COMPLETED",
        amount: totalRefund.total,
        completedAt: "2026-08-21T08:30:00Z",
        raw: {},
      },
    ];
    await orders.importOrders([totalRefund], { id: 1, requestId: "test-total-refund" });
    const isolatedRefund = (
      await database.getPool().query(
        `SELECT orders.trigger_status, billing_cases.id AS case_id, billing_cases.status,
                billing_cases.do_not_transmit_reason,
                healthy.billing_case_id AS healthy_case_id, healthy_case.status AS healthy_status
         FROM orders
         JOIN billing_cases ON billing_cases.id = orders.billing_case_id
         JOIN orders AS healthy ON healthy.external_order_id = $2
         JOIN billing_cases AS healthy_case ON healthy_case.id = healthy.billing_case_id
         WHERE orders.external_order_id = $1`,
        [totalRefund.externalOrderId, mixedRefund.externalOrderId],
      )
    ).rows[0];
    assert.deepEqual(
      {
        trigger_status: isolatedRefund.trigger_status,
        status: isolatedRefund.status,
        do_not_transmit_reason: isolatedRefund.do_not_transmit_reason,
        healthy_status: isolatedRefund.healthy_status,
      },
      {
        trigger_status: "REFUNDED_BEFORE_ISSUE",
        status: "DO_NOT_TRANSMIT",
        do_not_transmit_reason: "Ordine rimborsato prima dell’emissione",
        healthy_status: "READY",
      },
    );
    assert.notEqual(isolatedRefund.case_id, isolatedRefund.healthy_case_id);
    const totalRefundCase = await orders.getBillingCase(isolatedRefund.case_id);
    assert.equal(totalRefundCase!.reactivation_blocker, "INCOMPATIBLE_ORDERS");

    await database.getPool().query(
      `UPDATE settings SET value_json = '"PAID"', version = version + 1
       WHERE key = 'draft_trigger'`,
    );
    const refundAnchor = structuredClone(fixture[0]);
    refundAnchor.externalOrderId = "shop-order-historical-refund-anchor";
    refundAnchor.displayNumber = "#HISTORICAL-REFUND-ANCHOR";
    refundAnchor.createdAt = "2026-09-01T08:00:00Z";
    refundAnchor.updatedAt = "2026-09-01T09:00:00Z";
    refundAnchor.payments[0].externalPaymentId = "historical-refund-anchor-payment";
    await orders.importOrders([refundAnchor], {
      id: 1,
      requestId: "test-historical-refund-anchor-import",
    });
    const refundAnchorRow = (
      await database
        .getPool()
        .query<{ id: string; billing_case_id: string }>(
          "SELECT id, billing_case_id FROM orders WHERE external_order_id = $1",
          [refundAnchor.externalOrderId],
        )
    ).rows[0]!;
    await database.getPool().query(
      `INSERT INTO fiscal_profiles (version, status, profile_json)
       VALUES (1, 'MOCK', $1) ON CONFLICT (version) DO NOTHING`,
      [JSON.parse(await readFile("tests/fixtures/fatturapa/profile.mock.json", "utf8"))],
    );
    const refundDocumentId = (
      await database.getPool().query<{ id: string }>(
        `INSERT INTO documents
           (billing_case_id, kind, status, document_type, series, document_date,
            fiscal_profile_version, currency, total_amount, source_total_amount,
            difference_amount, projection_sha256, payment_status, payment_method,
            recipient_snapshot_json)
         VALUES ($1, 'INVOICE', 'DRAFT', 'TD01', 'FPR', '2026-09-01', 1, 'EUR',
                 12200, 12200, 0, $2, 'PAID', 'MP08', $3)
         RETURNING id`,
        [
          refundAnchorRow.billing_case_id,
          "0".repeat(64),
          {
            kind: refundAnchor.customer.kind,
            displayName: refundAnchor.customer.displayName,
            firstName: refundAnchor.customer.firstName,
            lastName: refundAnchor.customer.lastName,
            taxIdentifiers: refundAnchor.customer.taxIdentifiers.map(
              (identifier: { type: string; value: string; countryCode?: string }) => ({
                type: identifier.type,
                value: identifier.value,
                countryCode: identifier.countryCode,
              }),
            ),
            address: refundAnchor.customer.billingAddress,
          },
        ],
      )
    ).rows[0]!.id;
    await database.getPool().query(
      `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
       VALUES ($1, 'INVOICE', $2, 12200)`,
      [refundDocumentId, refundAnchorRow.id],
    );
    await database.getPool().query(
      `INSERT INTO document_lines
         (document_id, order_id, line_number, description, quantity, unit_amount,
          total_amount, tax_nature)
       VALUES ($1, $2, 1, 'Ordine di controllo', 1, 12200, 12200, 'N5')`,
      [refundDocumentId, refundAnchorRow.id],
    );
    const deferredHistorical = structuredClone(fixture[0]);
    deferredHistorical.externalOrderId = "shop-order-historical-refund-deferred-force";
    deferredHistorical.displayNumber = "#HISTORICAL-REFUND-DEFERRED-FORCE";
    deferredHistorical.createdAt = "2026-09-01T08:00:00Z";
    deferredHistorical.updatedAt = "2026-09-01T09:00:00Z";
    deferredHistorical.historical = true;
    deferredHistorical.paymentStatus = "PENDING";
    deferredHistorical.fulfillmentStatus = "FULFILLED";
    deferredHistorical.payments[0].externalPaymentId = "historical-refund-deferred-force-payment";
    deferredHistorical.payments[0].status = "PENDING";
    deferredHistorical.payments[0].paidAt = null;
    deferredHistorical.refunds = [
      {
        externalRefundId: "historical-refund-deferred-force",
        status: "COMPLETED",
        amount: "10.00",
        completedAt: "2026-09-01T09:00:00Z",
        raw: {},
      },
    ];
    const triggeredHistorical = structuredClone(deferredHistorical);
    triggeredHistorical.externalOrderId = "shop-order-historical-refund-deferred-trigger";
    triggeredHistorical.displayNumber = "#HISTORICAL-REFUND-DEFERRED-TRIGGER";
    triggeredHistorical.payments[0].externalPaymentId =
      "historical-refund-deferred-trigger-payment";
    triggeredHistorical.refunds[0].externalRefundId = "historical-refund-deferred-trigger";
    await orders.importOrders([deferredHistorical, triggeredHistorical], {
      id: 1,
      requestId: "test-historical-refund-deferred-import",
    });
    const deferredIds = (
      await database.getPool().query<{ id: string; external_order_id: string }>(
        `SELECT id, external_order_id FROM orders
         WHERE external_order_id IN ($1, $2)`,
        [deferredHistorical.externalOrderId, triggeredHistorical.externalOrderId],
      )
    ).rows;
    for (const order of deferredIds) {
      await orders.reconcileHistoricalOrder(
        order.id,
        {
          outcome: "NOT_INVOICED",
          reference: `Ricerca Aruba senza documento per ${order.external_order_id}`,
        },
        { id: 1, canApprove: true, requestId: `test-${order.external_order_id}-reconcile` },
      );
    }
    const forcedId = deferredIds.find(
      (order) => order.external_order_id === deferredHistorical.externalOrderId,
    )!.id;
    await orders.forcePrepareOrder(forcedId, {
      id: 1,
      requestId: "test-historical-refund-deferred-force",
    });
    const finalTriggerVersion = (
      await database.getPool().query("SELECT version FROM settings WHERE key = 'draft_trigger'")
    ).rows[0].version;
    await orders.setDraftTrigger("FULFILLED", finalTriggerVersion, {
      id: 1,
      requestId: "test-historical-refund-deferred-trigger",
    });
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT orders.external_order_id, orders.trigger_status, document_orders.amount
           FROM orders JOIN document_orders ON document_orders.order_id = orders.id
           WHERE orders.external_order_id IN ($1, $2)
           ORDER BY orders.external_order_id`,
          [deferredHistorical.externalOrderId, triggeredHistorical.externalOrderId],
        )
      ).rows,
      [
        {
          external_order_id: deferredHistorical.externalOrderId,
          trigger_status: "GROUPED",
          amount: 11_200,
        },
        {
          external_order_id: triggeredHistorical.externalOrderId,
          trigger_status: "GROUPED",
          amount: 11_200,
        },
      ],
    );

    const firstDraftHistorical = structuredClone(fixture[0]);
    firstDraftHistorical.externalOrderId = "shop-order-historical-refund-first-draft";
    firstDraftHistorical.displayNumber = "#HISTORICAL-REFUND-FIRST-DRAFT";
    firstDraftHistorical.createdAt = "2026-09-02T08:00:00Z";
    firstDraftHistorical.updatedAt = "2026-09-02T09:00:00Z";
    firstDraftHistorical.historical = true;
    firstDraftHistorical.payments[0].externalPaymentId = "historical-refund-first-draft-payment";
    firstDraftHistorical.refunds = [
      {
        externalRefundId: "historical-refund-first-draft",
        status: "COMPLETED",
        amount: "10.00",
        completedAt: "2026-09-02T09:00:00Z",
        raw: {},
      },
    ];
    await orders.importOrders([firstDraftHistorical], {
      id: 1,
      requestId: "test-historical-refund-first-draft-import",
    });
    const firstDraftHistoricalId = (
      await database
        .getPool()
        .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
          firstDraftHistorical.externalOrderId,
        ])
    ).rows[0]!.id;
    const firstDraftReconciliation = await orders.reconcileHistoricalOrder(
      firstDraftHistoricalId,
      {
        outcome: "NOT_INVOICED",
        reference: "Ricerca Aruba senza documento per prima bozza netta",
      },
      {
        id: 1,
        canApprove: true,
        requestId: "test-historical-refund-first-draft-reconcile",
      },
    );
    const documents = await import("./documents.server.ts");
    const firstProjection = await documents.getInvoiceProjection(firstDraftReconciliation!.caseId!);
    assert.ok(firstProjection && !firstProjection.profileMissing && "lines" in firstProjection);
    assert.equal(firstProjection.sourceTotal, 11_200);
    assert.equal(firstProjection.lines[0]!.unitAmount, 11_200);
    await documents.saveInvoiceDraft(
      firstDraftReconciliation!.caseId!,
      {
        caseRevision: firstProjection.caseRevision,
        draftVersion: firstProjection.draftVersion,
        differenceReason: "",
        paymentStatus: firstProjection.paymentStatus,
        paymentMethod: firstProjection.paymentMethod,
        causale: firstProjection.causale,
        notes: firstProjection.notes,
        lines: firstProjection.lines,
      },
      { id: 1, canApprove: true, requestId: "test-historical-refund-first-draft-save" },
    );
    assert.equal(
      (
        await database.getPool().query(
          `SELECT document_orders.amount FROM document_orders
           WHERE document_orders.order_id = $1`,
          [firstDraftHistoricalId],
        )
      ).rows[0].amount,
      11_200,
    );

    await database.closePool();
  } finally {
    await import("./client.server.ts").then(({ closePool }) => closePool());
    await clean.drop();
  }
});
