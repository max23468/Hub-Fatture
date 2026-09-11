import type { ArubaOrderCandidate, FiscalIdentity } from "./aruba-inbound.ts";

export interface ArubaOrderCandidateSource {
  id: string;
  provider: "SHOPIFY" | "EBAY";
  display_number: string;
  local_order_date: string;
  billable_amount: number;
  recipient_name: string | null;
  recipient_tax_identifiers: FiscalIdentity[];
  recipient_country_code: string | null;
  recipient_city?: string | null;
  recipient_address: string | null;
  billing_case_id: string | null;
  refund_timing_ambiguous?: boolean;
  bank_transfer_paid_on_document_date?: boolean;
  payment_rounding_amount?: number;
}

export function arubaOrderCandidateFromSource(
  source: ArubaOrderCandidateSource,
  overrides: {
    billingCaseId?: string | null;
    billableAmount?: number;
    localOrderDate?: string;
    paymentRoundingAmount?: number;
  } = {},
): ArubaOrderCandidate & { billingCaseId: string | null } {
  const paymentRoundingAmount = overrides.paymentRoundingAmount ?? source.payment_rounding_amount;
  return {
    id: source.id,
    billingCaseId:
      overrides.billingCaseId === undefined ? source.billing_case_id : overrides.billingCaseId,
    provider: source.provider,
    displayNumber: source.display_number,
    localOrderDate: overrides.localOrderDate ?? source.local_order_date,
    billableAmount: overrides.billableAmount ?? source.billable_amount,
    recipientName: source.recipient_name,
    recipientTaxIdentifiers: source.recipient_tax_identifiers,
    recipientCountryCode: source.recipient_country_code,
    recipientCity: source.recipient_city ?? null,
    recipientAddress: source.recipient_address,
    ...(source.refund_timing_ambiguous === undefined
      ? {}
      : { refundTimingAmbiguous: source.refund_timing_ambiguous }),
    ...(paymentRoundingAmount ? { paymentRoundingAmount } : {}),
    ...(source.bank_transfer_paid_on_document_date === undefined
      ? {}
      : { bankTransferPaidOnDocumentDate: source.bank_transfer_paid_on_document_date }),
  };
}
