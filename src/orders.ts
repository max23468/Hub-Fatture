import { z } from "zod";

export const POSTGRES_INTEGER_MAX = 2_147_483_647;

export const draftTriggerSchema = z.enum(["PAID", "FULFILLED"]);
export type DraftTrigger = z.infer<typeof draftTriggerSchema>;

const optionalTextSchema = z
  .string()
  .trim()
  .transform((value) => value || undefined)
  .optional();

const optionalEmailSchema = optionalTextSchema.pipe(z.email().optional());
const optionalCountryCodeSchema = optionalTextSchema.pipe(
  z
    .string()
    .length(2)
    .regex(/^[A-Za-z]{2}$/)
    .transform((value) => value.toUpperCase())
    .optional(),
);
const postgresTimestampSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => !value.startsWith("0000-"), "Timestamp fuori dal dominio PostgreSQL");
export const postgresDateSchema = z.iso
  .date()
  .refine((value) => !value.startsWith("0000-"), "Data fuori dal dominio PostgreSQL");

export function containsNullByte(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\0");
  if (Array.isArray(value)) return value.some(containsNullByte);
  return Boolean(
    value &&
    typeof value === "object" &&
    Object.values(value as Record<string, unknown>).some(containsNullByte),
  );
}

const addressSchema = z.object({
  line1: optionalTextSchema,
  line2: optionalTextSchema,
  postalCode: optionalTextSchema,
  city: optionalTextSchema,
  province: optionalTextSchema,
  countryCode: optionalCountryCodeSchema,
});

const taxIdentifierSchema = z.object({
  type: z.enum(["CODICE_FISCALE", "PARTITA_IVA", "ALTRO"]),
  value: z.string().trim().min(1),
  countryCode: optionalCountryCodeSchema,
  sourceField: z.string().trim().min(1),
});

export const orderInputSchema = z
  .object({
    provider: z.enum(["SHOPIFY", "EBAY"]),
    externalAccountId: z.string().trim().min(1),
    externalOrderId: z.string().trim().min(1),
    externalCustomerId: optionalTextSchema,
    displayNumber: z.string().trim().min(1),
    createdAt: postgresTimestampSchema,
    updatedAt: postgresTimestampSchema,
    currency: z
      .string()
      .trim()
      .length(3)
      .transform((value) => value.toUpperCase()),
    total: z.string().trim().min(1),
    shippingAmount: z.string().trim().min(1).default("0.00"),
    paymentStatus: z.enum(["PAID", "PENDING", "REFUNDED"]),
    fulfillmentStatus: z.enum(["UNFULFILLED", "PARTIAL", "FULFILLED"]),
    cancelledAt: postgresTimestampSchema.nullable().default(null),
    customer: z.object({
      kind: z.enum(["PRIVATE_IT", "BUSINESS_IT", "EU", "UNKNOWN"]),
      displayName: optionalTextSchema,
      firstName: optionalTextSchema,
      lastName: optionalTextSchema,
      companyName: optionalTextSchema,
      email: optionalEmailSchema,
      phone: optionalTextSchema,
      billingAddress: addressSchema.default({}),
      taxIdentifiers: z.array(taxIdentifierSchema).default([]),
    }),
    lines: z
      .array(
        z.object({
          externalLineId: z.string().trim().min(1),
          description: z.string().trim().min(1),
          quantity: z.number().int().positive().max(POSTGRES_INTEGER_MAX),
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
        paidAt: postgresTimestampSchema.nullable().default(null),
      }),
    ),
  })
  .superRefine((order, context) => {
    if (containsNullByte(order)) {
      context.addIssue({ code: "custom", message: "I testi non possono contenere byte NUL" });
    }
    const collections = [
      ["lines", order.lines.map((line) => line.externalLineId)],
      ["payments", order.payments.map((payment) => payment.externalPaymentId)],
    ] as const;
    for (const [path, identifiers] of collections) {
      const seen = new Set<string>();
      identifiers.forEach((identifier, index) => {
        if (seen.has(identifier)) {
          context.addIssue({
            code: "custom",
            path: [path, index],
            message: "Identificativo duplicato",
          });
        }
        seen.add(identifier);
      });
    }
  });

export type OrderInput = z.infer<typeof orderInputSchema>;

export function customerDisplayName(customer: OrderInput["customer"]): string {
  return (
    customer.displayName ||
    customer.companyName ||
    [customer.firstName, customer.lastName].filter(Boolean).join(" ")
  );
}

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
  return `${part("year")?.padStart(4, "0")}-${part("month")}-${part("day")}`;
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

function requiresItalianTaxFormat(
  input: OrderInput,
  identifier: OrderInput["customer"]["taxIdentifiers"][number],
) {
  const countryCode = identifier.countryCode ?? input.customer.billingAddress.countryCode;
  if (["PRIVATE_IT", "BUSINESS_IT"].includes(input.customer.kind)) return true;
  if (countryCode) return countryCode === "IT";
  return input.customer.kind === "UNKNOWN";
}

function isItalianTaxIdentifier(
  input: OrderInput,
  identifier: OrderInput["customer"]["taxIdentifiers"][number],
) {
  if (!requiresItalianTaxFormat(input, identifier)) return false;
  const value = normalizedTaxId(identifier.value);
  if (identifier.type === "CODICE_FISCALE") return /^[A-Z0-9]{16}$/.test(value);
  if (identifier.type !== "PARTITA_IVA") return false;
  return /^\d{11}$/.test(value.startsWith("IT") ? value.slice(2) : value);
}

export function canonicalTaxIdentifier(
  input: OrderInput,
  identifier: OrderInput["customer"]["taxIdentifiers"][number],
) {
  const italianIdentifier = isItalianTaxIdentifier(input, identifier);
  const needsCountry = identifier.type === "ALTRO" || !italianIdentifier;
  const sourceCountryCode =
    identifier.countryCode ??
    input.customer.billingAddress.countryCode ??
    (italianIdentifier ? "IT" : undefined);
  const countryCode = needsCountry ? sourceCountryCode : undefined;
  const rawValue = normalizedTaxId(identifier.value);
  const valuePrefix = italianIdentifier ? "IT" : sourceCountryCode;
  const value =
    identifier.type === "PARTITA_IVA" && valuePrefix && rawValue.startsWith(valuePrefix)
      ? rawValue.slice(valuePrefix.length)
      : rawValue;
  return { ...identifier, rawValue: identifier.value, value, countryCode };
}

export function canonicalTaxIdentifiers(input: OrderInput) {
  const unique = new Map<string, ReturnType<typeof canonicalTaxIdentifier>>();
  for (const identifier of input.customer.taxIdentifiers) {
    const canonical = canonicalTaxIdentifier(input, identifier);
    const key = JSON.stringify([canonical.type, canonical.countryCode ?? "", canonical.value]);
    const existing = unique.get(key);
    if (!existing || JSON.stringify(canonical) < JSON.stringify(existing)) {
      unique.set(key, canonical);
    }
  }
  return [...unique.values()].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

export function canonicalCustomerProfile(input: OrderInput) {
  const address = input.customer.billingAddress;
  const taxIdentifiers = canonicalTaxIdentifiers(input)
    .map((identifier) => {
      const { sourceField: _, rawValue: __, ...canonical } = identifier;
      return canonical;
    })
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return {
    kind: input.customer.kind,
    displayName: normalized(customerDisplayName(input.customer)),
    firstName: normalized(input.customer.firstName),
    lastName: normalized(input.customer.lastName),
    companyName: normalized(input.customer.companyName),
    email: normalized(input.customer.email),
    phone: normalized(input.customer.phone),
    billingAddress: {
      line1: normalized(address.line1),
      line2: normalized(address.line2),
      postalCode: normalized(address.postalCode),
      city: normalized(address.city),
      province: normalized(address.province),
      countryCode: normalized(address.countryCode),
    },
    taxIdentifiers,
  };
}

function validTaxId(
  type: OrderInput["customer"]["taxIdentifiers"][number]["type"],
  value: string,
  italianFormat: boolean,
) {
  if (type === "CODICE_FISCALE") {
    return italianFormat ? /^[A-Z0-9]{16}$/.test(value) : value.length >= 2;
  }
  if (type === "PARTITA_IVA") return italianFormat ? /^\d{11}$/.test(value) : value.length >= 2;
  return value.length >= 2;
}

export function customerIdentity(input: OrderInput): {
  matchKey: string;
  confidence: "TAX_ID" | "EXACT_PROFILE" | "AMBIGUOUS";
  reviewRequired: boolean;
  primaryTaxId: { type: string; value: string; countryCode?: string } | null;
} {
  const address = input.customer.billingAddress;
  const canonicalProfile = canonicalCustomerProfile(input);
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
  const identifierOrder = ["CODICE_FISCALE", "PARTITA_IVA", "ALTRO"];
  const identifiers = canonicalTaxIdentifiers(input).sort(
    (left, right) =>
      identifierOrder.indexOf(left.type) - identifierOrder.indexOf(right.type) ||
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
  const customerKind = input.customer.kind;
  for (const identifier of identifiers) {
    const italianIdentifier = isItalianTaxIdentifier(input, identifier);
    const needsCountry = identifier.type === "ALTRO" || !italianIdentifier;
    const countryCode = identifier.countryCode;
    if (needsCountry && !countryCode) continue;
    const value = identifier.value;
    if (validTaxId(identifier.type, value, requiresItalianTaxFormat(input, identifier))) {
      const expectedIdentifier =
        customerKind === "PRIVATE_IT"
          ? identifier.type === "CODICE_FISCALE"
          : customerKind === "BUSINESS_IT"
            ? ["CODICE_FISCALE", "PARTITA_IVA"].includes(identifier.type)
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
    canonicalProfile.kind,
    canonicalProfile.displayName,
    canonicalProfile.billingAddress.line1,
    canonicalProfile.billingAddress.postalCode,
    canonicalProfile.billingAddress.city,
    canonicalProfile.billingAddress.countryCode,
    canonicalProfile.email,
  ];
  if (profile.every(Boolean)) {
    return {
      matchKey: `profile:${JSON.stringify(profile)}`,
      confidence: "EXACT_PROFILE",
      reviewRequired: input.customer.kind !== "EU",
      primaryTaxId: null,
    };
  }
  return {
    matchKey: `order:${JSON.stringify([
      input.provider,
      input.externalAccountId,
      input.externalOrderId,
    ])}`,
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
