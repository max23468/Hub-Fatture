import { z } from "zod";

export const draftTriggerSchema = z.enum(["PAID", "FULFILLED"]);
export type DraftTrigger = z.infer<typeof draftTriggerSchema>;

const addressSchema = z.object({
  line1: z.string().trim().min(1).optional(),
  line2: z.string().trim().optional(),
  postalCode: z.string().trim().min(1).optional(),
  city: z.string().trim().min(1).optional(),
  province: z.string().trim().optional(),
  countryCode: z
    .string()
    .trim()
    .length(2)
    .transform((value) => value.toUpperCase())
    .optional(),
});

const taxIdentifierSchema = z.object({
  type: z.enum(["CODICE_FISCALE", "PARTITA_IVA", "ALTRO"]),
  value: z.string().trim().min(1),
  countryCode: z
    .string()
    .trim()
    .length(2)
    .transform((value) => value.toUpperCase())
    .optional(),
  sourceField: z.string().trim().min(1),
});

export const orderInputSchema = z.object({
  provider: z.enum(["SHOPIFY", "EBAY"]),
  externalAccountId: z.string().trim().min(1),
  externalOrderId: z.string().trim().min(1),
  externalCustomerId: z.string().trim().min(1).optional(),
  displayNumber: z.string().trim().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  currency: z
    .string()
    .trim()
    .length(3)
    .transform((value) => value.toUpperCase()),
  total: z.string().trim().min(1),
  shippingAmount: z.string().trim().min(1).default("0.00"),
  paymentStatus: z.enum(["PAID", "PENDING", "REFUNDED"]),
  fulfillmentStatus: z.enum(["UNFULFILLED", "PARTIAL", "FULFILLED"]),
  cancelledAt: z.iso.datetime({ offset: true }).nullable().default(null),
  customer: z.object({
    kind: z.enum(["PRIVATE_IT", "BUSINESS_IT", "EU", "UNKNOWN"]),
    displayName: z.string().trim().min(1).optional(),
    firstName: z.string().trim().optional(),
    lastName: z.string().trim().optional(),
    companyName: z.string().trim().optional(),
    email: z.email().optional(),
    phone: z.string().trim().optional(),
    billingAddress: addressSchema.default({}),
    taxIdentifiers: z.array(taxIdentifierSchema).default([]),
  }),
  lines: z
    .array(
      z.object({
        externalLineId: z.string().trim().min(1),
        description: z.string().trim().min(1),
        quantity: z.number().int().positive(),
        grossAmount: z.string().trim().min(1),
        discountAmount: z.string().trim().min(1).default("0.00"),
      }),
    )
    .min(1),
  payments: z.array(
    z.object({
      externalPaymentId: z.string().trim().min(1),
      method: z.string().trim().min(1),
      status: z.enum(["PAID", "PENDING", "REFUNDED"]),
      amount: z.string().trim().min(1),
      paidAt: z.iso.datetime({ offset: true }).nullable().default(null),
    }),
  ),
});

export type OrderInput = z.infer<typeof orderInputSchema>;

export function customerDisplayName(customer: OrderInput["customer"]): string {
  return (
    customer.displayName ??
    customer.companyName ??
    [customer.firstName, customer.lastName].filter(Boolean).join(" ")
  );
}

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const romeDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Rome",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function decimalToCents(value: string): number {
  const match = /^(-?)(\d+)(?:\.(\d{1,2})0*)?$/.exec(value);
  if (!match) throw new Error("Importo non valido");
  const sign = match[1] === "-" ? -1 : 1;
  const amount = sign * (Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0")));
  if (!Number.isSafeInteger(amount) || Math.abs(amount) > POSTGRES_INTEGER_MAX) {
    throw new Error("Importo fuori limite");
  }
  return amount;
}

export function localOrderDate(instant: string): string {
  const parts = romeDateFormatter.formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function normalized(value: string | undefined): string {
  return value?.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("it") ?? "";
}

function normalizedTaxId(value: string): string {
  return value
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function validTaxId(type: OrderInput["customer"]["taxIdentifiers"][number]["type"], value: string) {
  if (type === "CODICE_FISCALE") return /^[A-Z0-9]{16}$/.test(value);
  if (type === "PARTITA_IVA") return /^\d{11}$/.test(value);
  return value.length >= 2;
}

export function customerIdentity(input: OrderInput): {
  matchKey: string;
  confidence: "TAX_ID" | "EXACT_PROFILE" | "AMBIGUOUS";
  reviewRequired: boolean;
  primaryTaxId: { type: string; value: string; countryCode?: string } | null;
} {
  const address = input.customer.billingAddress;
  const addressComplete = [
    address.line1,
    address.postalCode,
    address.city,
    address.countryCode,
  ].every(Boolean);
  const nameComplete =
    input.customer.kind === "PRIVATE_IT"
      ? Boolean(input.customer.firstName && input.customer.lastName)
      : input.customer.kind === "BUSINESS_IT"
        ? Boolean(
            input.customer.companyName || (input.customer.firstName && input.customer.lastName),
          )
        : Boolean(
            input.customer.displayName ||
            input.customer.companyName ||
            (input.customer.firstName && input.customer.lastName),
          );
  const profileComplete = addressComplete && nameComplete;
  const identifierOrder =
    input.customer.kind === "BUSINESS_IT"
      ? ["PARTITA_IVA", "CODICE_FISCALE", "ALTRO"]
      : input.customer.kind === "EU"
        ? ["ALTRO", "PARTITA_IVA", "CODICE_FISCALE"]
        : ["CODICE_FISCALE", "PARTITA_IVA", "ALTRO"];
  const identifiers = identifierOrder.flatMap((type) =>
    input.customer.taxIdentifiers.filter((identifier) => identifier.type === type),
  );
  const customerKind = input.customer.kind;
  for (const identifier of identifiers) {
    const value = normalizedTaxId(identifier.value);
    if (validTaxId(identifier.type, value)) {
      const needsCountry =
        identifier.type === "ALTRO" || !["PRIVATE_IT", "BUSINESS_IT"].includes(customerKind);
      const countryCode = needsCountry
        ? (identifier.countryCode?.toUpperCase() ?? address.countryCode)
        : undefined;
      if (needsCountry && !countryCode) continue;
      const expectedIdentifier =
        customerKind === "PRIVATE_IT"
          ? identifier.type === "CODICE_FISCALE"
          : customerKind === "BUSINESS_IT"
            ? identifier.type === "PARTITA_IVA"
            : customerKind === "EU";
      return {
        matchKey: `tax:${identifier.type}:${countryCode ?? ""}:${value}`,
        confidence: "TAX_ID",
        reviewRequired: !expectedIdentifier || !profileComplete,
        primaryTaxId: { type: identifier.type, value, countryCode },
      };
    }
  }

  const profile = [
    normalized(customerDisplayName(input.customer)),
    normalized(address.line1),
    normalized(address.postalCode),
    normalized(address.city),
    normalized(address.countryCode),
    normalized(input.customer.email),
  ];
  if (profile.every(Boolean)) {
    return {
      matchKey: `profile:${profile.join("|")}`,
      confidence: "EXACT_PROFILE",
      reviewRequired: input.customer.kind !== "EU",
      primaryTaxId: null,
    };
  }
  return {
    matchKey: `order:${input.provider}:${input.externalAccountId}:${input.externalOrderId}`,
    confidence: "AMBIGUOUS",
    reviewRequired: true,
    primaryTaxId: null,
  };
}

export function triggerStatus(
  order: Pick<OrderInput, "cancelledAt" | "paymentStatus" | "fulfillmentStatus">,
  trigger: DraftTrigger,
): "CANCELLED_NO_DOCUMENT" | "REFUNDED_BEFORE_ISSUE" | "ELIGIBLE" | "WAITING_FOR_TRIGGER" {
  if (order.cancelledAt) return "CANCELLED_NO_DOCUMENT";
  if (order.paymentStatus === "REFUNDED") return "REFUNDED_BEFORE_ISSUE";
  if (
    trigger === "PAID" ? order.paymentStatus === "PAID" : order.fulfillmentStatus === "FULFILLED"
  ) {
    return "ELIGIBLE";
  }
  return "WAITING_FOR_TRIGGER";
}
