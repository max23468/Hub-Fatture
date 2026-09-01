import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";

import {
  canonicalCustomerProfile,
  customerIdentity,
  decimalToCents,
  localOrderDate,
  orderInputSchema,
  type OrderInput,
} from "../../orders.ts";

export async function createOrdersTestContext(connectionString: string) {
  process.env.APP_ENV = "test";
  process.env.APP_BASE_URL = "http://localhost:8080";
  process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
  process.env.DATABASE_URL = connectionString;
  const orders = {
    ...(await import("../billing-cases.server.ts")),
    ...(await import("../historical-order-reconciliation.server.ts")),
    ...(await import("../order-commands.server.ts")),
    ...(await import("../order-import.server.ts")),
    ...(await import("../order-queries.server.ts")),
  };
  const refunds = await import("../refunds.server.ts");
  const database = await import("../client.server.ts");
  const caseRevision = async (caseId: string | number) =>
    (
      await database
        .getPool()
        .query<{ revision: number }>("SELECT revision FROM billing_cases WHERE id = $1", [
          String(caseId),
        ])
    ).rows[0]?.revision ?? 0;
  const fixture = JSON.parse(await readFile("tests/fixtures/orders/normalized.mock.json", "utf8"));
  return { orders, refunds, database, caseRevision, fixture, connectionString };
}

export type OrdersTestContext = Awaited<ReturnType<typeof createOrdersTestContext>>;

export async function waitForBlockedQuery(client: pg.Client) {
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

export function legacyReviewFingerprint(raw: OrderInput): string {
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
