const BANK_TRANSFER_OVERPAYMENT_TOLERANCE_CENTS = 2n;

interface PaymentForReconciliation {
  method: string;
  status: string;
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

export function paymentsReconciled(input: {
  provider: "SHOPIFY" | "EBAY";
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
  const overpayment = observablePaymentAmount - grossAmount;
  return (
    paidPayments.length > 0 &&
    paidPayments.every((payment) => isBankTransferMethod(payment.method)) &&
    overpayment > 0n &&
    overpayment <= BANK_TRANSFER_OVERPAYMENT_TOLERANCE_CENTS
  );
}
