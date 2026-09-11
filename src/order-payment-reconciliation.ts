/** Scarto massimo, in centesimi, fra incasso e totale ordine accettato come arrotondamento. */
export const PAYMENT_ROUNDING_TOLERANCE_CENTS = 2;

interface PaymentForReconciliation {
  method: string;
  status: string;
  presentmentCurrency?: string | null;
}

interface PaymentForFiscalMethod extends PaymentForReconciliation {
  amount: number;
}

interface OrderPaymentsForFiscalMethod {
  provider: "SHOPIFY" | "EBAY";
  payments: readonly PaymentForFiscalMethod[];
}

function normalizedPaymentMethod(method: string) {
  return method
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_");
}

export function isBankTransferMethod(method: string) {
  const normalized = normalizedPaymentMethod(method);
  return normalized.includes("bonifico") || normalized.includes("bank_transfer");
}

function isManualPaymentMethod(method: string) {
  const normalized = normalizedPaymentMethod(method);
  return normalized === "manual" || normalized === "manuale";
}

function isShopifyBankTransferOrder(order: OrderPaymentsForFiscalMethod) {
  if (order.provider !== "SHOPIFY") return false;
  const transfers = order.payments.filter((payment) => isBankTransferMethod(payment.method));
  if (transfers.length === 0) return false;
  return order.payments.every(
    (payment) =>
      isBankTransferMethod(payment.method) ||
      (payment.status === "PAID" &&
        isManualPaymentMethod(payment.method) &&
        transfers.some((transfer) => transfer.amount === payment.amount)),
  );
}

export function inferredInvoicePaymentMethod(
  orders: readonly OrderPaymentsForFiscalMethod[],
): "MP05" | null {
  return orders.length > 0 && orders.every(isShopifyBankTransferOrder) ? "MP05" : null;
}

function isConvertedShopifyPayment(payment: PaymentForReconciliation, currency: string) {
  return (
    normalizedPaymentMethod(payment.method) === "shopify_payments" &&
    Boolean(payment.presentmentCurrency) &&
    payment.presentmentCurrency !== currency
  );
}

export function paymentsReconciled(input: {
  provider: "SHOPIFY" | "EBAY";
  currency: string;
  grossAmount: number;
  payments: readonly PaymentForReconciliation[];
  paymentAmounts: readonly number[];
}) {
  if (input.provider === "EBAY") return true;

  const paidPaymentAmount = input.payments.reduce(
    (sum, payment, index) =>
      payment.status === "PAID" ? sum + BigInt(input.paymentAmounts[index]!) : sum,
    0n,
  );
  const grossAmount = BigInt(input.grossAmount);
  const observablePaymentAmount =
    paidPaymentAmount >= grossAmount
      ? paidPaymentAmount
      : input.payments.reduce(
          (sum, payment, index) =>
            payment.status === "REFUNDED" ? sum : sum + BigInt(input.paymentAmounts[index]!),
          0n,
        );
  if (observablePaymentAmount === grossAmount) return true;

  const paidPayments = input.payments.filter((payment) => payment.status === "PAID");
  const difference = observablePaymentAmount - grossAmount;
  const tolerance = BigInt(PAYMENT_ROUNDING_TOLERANCE_CENTS);
  if (paidPayments.length === 0 || difference === 0n) return false;
  // Un bonifico può essere arrotondato soltanto per eccesso; la conversione valuta di Shopify
  // Payments può scostare l'incasso in entrambe le direzioni. Il fatturabile resta il totale ordine.
  if (paidPayments.every((payment) => isBankTransferMethod(payment.method))) {
    return difference > 0n && difference <= tolerance;
  }
  return (
    paidPayments.every((payment) => isConvertedShopifyPayment(payment, input.currency)) &&
    difference >= -tolerance &&
    difference <= tolerance
  );
}
