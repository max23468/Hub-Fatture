const BANK_TRANSFER_OVERPAYMENT_TOLERANCE_CENTS = 2n;

interface PaymentForReconciliation {
  method: string;
  status: string;
}

function isBankTransferMethod(method: string) {
  const normalized = method
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_");
  return normalized.includes("bonifico") || normalized.includes("bank_transfer");
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
