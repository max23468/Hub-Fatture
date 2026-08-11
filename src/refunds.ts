import { POSTGRES_INTEGER_MAX, refundNeedsReview } from "./orders.ts";

function money(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > POSTGRES_INTEGER_MAX) {
    throw new RangeError("Importo rimborso non valido");
  }
  return value;
}

export function creditableRemainder(invoiceTotal: number, creditedAmount: number): number {
  const remainder = money(invoiceTotal) - money(creditedAmount);
  if (remainder < 0) throw new RangeError("Le note superano la fattura originaria");
  return remainder;
}

export function preIssueRefund(
  orderTotal: number,
  refunds: Array<{ status: string; amount: number | null }>,
): { state: "UNCHANGED" | "PARTIAL" | "TOTAL" | "NEEDS_REVIEW"; billableAmount: number } {
  money(orderTotal);
  if (refunds.some(refundNeedsReview)) {
    return { state: "NEEDS_REVIEW", billableAmount: orderTotal };
  }
  const refunded = refunds
    .filter((refund) => refund.status === "COMPLETED")
    .reduce((sum, refund) => sum + money(refund.amount!), 0);
  if (refunded > orderTotal) return { state: "NEEDS_REVIEW", billableAmount: orderTotal };
  if (refunded === orderTotal) return { state: "TOTAL", billableAmount: 0 };
  if (refunded > 0) return { state: "PARTIAL", billableAmount: orderTotal - refunded };
  return { state: "UNCHANGED", billableAmount: orderTotal };
}
