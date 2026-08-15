import { z } from "zod";

export const POSTGRES_INTEGER_MAX = 2_147_483_647;

export const draftTriggerSchema = z.enum(["PAID", "FULFILLED"]);
export type DraftTrigger = z.infer<typeof draftTriggerSchema>;
export const shopifyPaymentFeeModeSchema = z.enum(["DEDUCT", "INCLUDE"]);
export type ShopifyPaymentFeeMode = z.infer<typeof shopifyPaymentFeeModeSchema>;

const optionalTextSchema = z
  .string()
  .trim()
  .transform((value) => value || undefined)
  .optional();

const optionalEmailSchema = optionalTextSchema.pipe(z.email().optional());
const supportedCountryCodes = [
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
] as const;
const optionalCountryCodeSchema = optionalTextSchema.pipe(
  z
    .string()
    .transform((value) => value.toUpperCase())
    .refine(
      (value) => supportedCountryCodes.includes(value as (typeof supportedCountryCodes)[number]),
      "Paese non supportato",
    )
    .optional(),
);
const optionalRecipientCodeSchema = optionalTextSchema.pipe(
  z
    .string()
    .transform((value) => value.toUpperCase())
    .refine((value) => /^[A-Z0-9]{7}$/.test(value), "Codice destinatario non valido")
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

export const customerSchema = z.object({
  kind: z.enum(["PRIVATE_IT", "BUSINESS_IT", "EU", "UNKNOWN"]),
  displayName: optionalTextSchema,
  firstName: optionalTextSchema,
  lastName: optionalTextSchema,
  companyName: optionalTextSchema,
  email: optionalEmailSchema,
  certifiedEmail: optionalEmailSchema,
  recipientCode: optionalRecipientCodeSchema,
  phone: optionalTextSchema,
  billingAddress: addressSchema.default({}),
  shippingAddress: addressSchema.default({}),
  taxIdentifiers: z.array(taxIdentifierSchema).default([]),
});

const localizedFieldSchema = z.object({
  key: z.string().trim().min(1),
  countryCode: optionalTextSchema,
  purpose: optionalTextSchema,
  title: optionalTextSchema,
  value: z.string().trim(),
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
    historical: z.boolean().default(false),
    paymentStatus: z.enum(["PAID", "PENDING", "REFUNDED"]),
    fulfillmentStatus: z.enum(["UNFULFILLED", "PARTIAL", "FULFILLED"]),
    cancelledAt: postgresTimestampSchema.nullable().default(null),
    sourceReviewRequired: z.boolean().default(false),
    localizedFields: z.array(localizedFieldSchema).default([]),
    sourceSnapshot: z.record(z.string(), z.unknown()).default({}),
    customer: customerSchema,
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
        shopifyPaymentsFeeAmount: z.string().trim().min(1).default("0.00"),
        paidAt: postgresTimestampSchema.nullable().default(null),
      }),
    ),
    refunds: z
      .array(
        z.object({
          externalRefundId: z.string().trim().min(1),
          status: z.enum(["PENDING", "COMPLETED", "FAILED", "AMBIGUOUS"]),
          amount: z.string().trim().min(1).nullable(),
          completedAt: postgresTimestampSchema.nullable().default(null),
          raw: z.record(z.string(), z.unknown()).default({}),
        }),
      )
      .default([]),
  })
  .superRefine((order, context) => {
    if (containsNullByte(order)) {
      context.addIssue({ code: "custom", message: "I testi non possono contenere byte NUL" });
    }
    const collections = [
      ["lines", order.lines.map((line) => line.externalLineId)],
      ["payments", order.payments.map((payment) => payment.externalPaymentId)],
      ["refunds", order.refunds.map((refund) => refund.externalRefundId)],
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
export type CustomerInput = z.infer<typeof customerSchema>;

/**
 * Le funzioni di identità leggono soltanto il cliente e la chiave di fallback dell'ordine:
 * la stessa logica serve l'import e la correzione manuale senza duplicare le regole fiscali.
 */
export type CustomerContext = Pick<
  OrderInput,
  "provider" | "externalAccountId" | "externalOrderId" | "customer"
>;

export function customerDisplayName(customer: CustomerInput): string {
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
const DAY_MS = 86_400_000;

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

export function defaultHistoricalStartDate(now = Date.now()) {
  const today = localOrderDate(new Date(now).toISOString());
  return new Date(Date.parse(`${today}T00:00:00Z`) - 7 * DAY_MS).toISOString().slice(0, 10);
}

export function historicalOrderWindow(value: unknown, now = Date.now()) {
  const parsed = postgresDateSchema.safeParse(value);
  if (!parsed.success || parsed.data > localOrderDate(new Date(now).toISOString())) return null;
  return {
    startDate: parsed.data,
    // I provider ricevono un sovrainsieme UTC; il filtro sotto applica il giorno Europe/Rome.
    fetchFrom: new Date(Date.parse(`${parsed.data}T00:00:00Z`) - DAY_MS).toISOString(),
  };
}

export function markHistoricalOrders(orders: OrderInput[], startDate: string) {
  return orders.flatMap((order) =>
    localOrderDate(order.createdAt) >= startDate || localOrderDate(order.updatedAt) >= startDate
      ? [{ ...order, historical: true }]
      : [],
  );
}

function normalized(value: string | undefined): string {
  return value?.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("it") ?? "";
}

function presentationText(value: string | undefined): string | undefined {
  const cleaned = value?.normalize("NFKC").trim().replace(/\s+/gu, " ");
  return cleaned || undefined;
}

function presentationWord(value: string, preserveAddressToken = false): string {
  const lower = value.toLocaleLowerCase("it");
  const upper = value.toLocaleUpperCase("it");
  if (value !== lower && value !== upper) return value;
  if (
    preserveAddressToken &&
    (/^(?:SP|SS|SR|SC|KM|SNC)$/u.test(upper) || /^(?=[MDCLXVI]+$)[MDCLXVI]+$/u.test(upper))
  ) {
    return upper;
  }
  const [first, ...rest] = [...lower];
  return first ? `${first.toLocaleUpperCase("it")}${rest.join("")}` : value;
}

function presentationToken(value: string, preserveAddressToken = false): string {
  if (/[./]/u.test(value)) return value;
  const match = /^([^\p{L}]*)([\p{L}]+(?:['’-][\p{L}]+)*)([^\p{L}]*)$/u.exec(value);
  if (!match) return value;
  const core = match[2]!
    .split(/(['’-])/u)
    .map((part) => (/['’-]/u.test(part) ? part : presentationWord(part, preserveAddressToken)))
    .join("");
  return `${match[1]}${core}${match[3]}`;
}

function presentationTitle(value: string | undefined, preserveAddressToken = false) {
  return presentationText(value)
    ?.split(" ")
    .map((token) => presentationToken(token, preserveAddressToken))
    .join(" ");
}

const italianAddressPrefixes = new Set([
  "borgo",
  "contrada",
  "corso",
  "discesa",
  "frazione",
  "largo",
  "localita",
  "località",
  "lungomare",
  "piazza",
  "piazzale",
  "rione",
  "salita",
  "strada",
  "traversa",
  "viale",
  "via",
  "vicolo",
]);

const italianAddressComplements = new Set([
  "edificio",
  "interno",
  "localita",
  "località",
  "palazzina",
  "piano",
  "scala",
]);

function presentationAddressLine(
  value: string | undefined,
  countryCode: string | undefined,
  complements = false,
) {
  const cleaned = presentationText(value);
  if (!cleaned || countryCode !== "IT") return cleaned;
  const prefix = cleaned
    .split(" ", 1)[0]!
    .replace(/[^\p{L}]/gu, "")
    .toLocaleLowerCase("it");
  const allowedPrefixes = complements ? italianAddressComplements : italianAddressPrefixes;
  return allowedPrefixes.has(prefix) ? presentationTitle(cleaned, true) : cleaned;
}

function presentationAddress(address: CustomerInput["billingAddress"]) {
  const countryCode = presentationText(address.countryCode)?.toUpperCase();
  const province = presentationText(address.province);
  return {
    line1: presentationAddressLine(address.line1, countryCode),
    line2: presentationAddressLine(address.line2, countryCode, true),
    postalCode:
      countryCode === "IT"
        ? presentationText(address.postalCode)?.replace(/\s+/gu, "")
        : presentationText(address.postalCode),
    city: presentationTitle(address.city, true),
    province:
      province && /^\p{L}{2}$/u.test(province)
        ? province.toLocaleUpperCase("it")
        : presentationTitle(province, true),
    countryCode,
  };
}

/**
 * Forma leggibile usata da anagrafica, preparazione e documento. Il dato provider resta
 * immutabile nello snapshot sorgente e il profilo canonico continua a governare il matching.
 * Le parole già in casing misto e le ragioni sociali non vengono reinterpretate.
 */
export function presentationCustomer(customer: CustomerInput): CustomerInput {
  const companyName = presentationText(customer.companyName);
  const displayName = presentationText(customer.displayName);
  const companyDisplayName = Boolean(
    companyName && displayName && normalized(companyName) === normalized(displayName),
  );
  const sentenceDisplayName = Boolean(
    displayName && /^\p{Lu}[\p{Ll}'’-]*(?: [\p{Ll}'’-]+)+$/u.test(displayName),
  );
  return {
    ...customer,
    displayName:
      companyDisplayName || sentenceDisplayName ? displayName : presentationTitle(displayName),
    firstName: presentationTitle(customer.firstName),
    lastName: presentationTitle(customer.lastName),
    companyName,
    email: presentationText(customer.email)?.toLocaleLowerCase("it"),
    certifiedEmail: presentationText(customer.certifiedEmail)?.toLocaleLowerCase("it"),
    recipientCode: presentationText(customer.recipientCode)?.toUpperCase(),
    phone: presentationText(customer.phone),
    billingAddress: presentationAddress(customer.billingAddress),
    shippingAddress: presentationAddress(customer.shippingAddress),
  };
}

function normalizedTaxId(value: string): string {
  return value
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function requiresItalianTaxFormat(
  input: CustomerContext,
  identifier: CustomerInput["taxIdentifiers"][number],
) {
  const countryCode = identifier.countryCode ?? input.customer.billingAddress.countryCode;
  if (["PRIVATE_IT", "BUSINESS_IT"].includes(input.customer.kind)) return true;
  if (countryCode) return countryCode === "IT";
  return input.customer.kind === "UNKNOWN";
}

function isItalianTaxIdentifier(
  input: CustomerContext,
  identifier: CustomerInput["taxIdentifiers"][number],
) {
  if (!requiresItalianTaxFormat(input, identifier)) return false;
  const value = normalizedTaxId(identifier.value);
  if (identifier.type === "CODICE_FISCALE") return /^[A-Z0-9]{16}$/.test(value);
  if (identifier.type !== "PARTITA_IVA") return false;
  return /^\d{11}$/.test(value.startsWith("IT") ? value.slice(2) : value);
}

function canonicalTaxIdentifier(
  input: CustomerContext,
  identifier: CustomerInput["taxIdentifiers"][number],
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

export function canonicalTaxIdentifiers(input: CustomerContext) {
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

export function canonicalCustomerProfile(input: CustomerContext) {
  const address = input.customer.billingAddress;
  const shippingAddress = input.customer.shippingAddress;
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
    certifiedEmail: normalized(input.customer.certifiedEmail),
    recipientCode: normalized(input.customer.recipientCode).toUpperCase(),
    phone: normalized(input.customer.phone),
    billingAddress: {
      line1: normalized(address.line1),
      line2: normalized(address.line2),
      postalCode: normalized(address.postalCode),
      city: normalized(address.city),
      province: normalized(address.province),
      countryCode: normalized(address.countryCode),
    },
    shippingAddress: {
      line1: normalized(shippingAddress.line1),
      line2: normalized(shippingAddress.line2),
      postalCode: normalized(shippingAddress.postalCode),
      city: normalized(shippingAddress.city),
      province: normalized(shippingAddress.province),
      countryCode: normalized(shippingAddress.countryCode),
    },
    taxIdentifiers,
  };
}

function validTaxId(
  type: CustomerInput["taxIdentifiers"][number]["type"],
  value: string,
  italianFormat: boolean,
) {
  if (type === "CODICE_FISCALE") {
    return italianFormat ? /^[A-Z0-9]{16}$/.test(value) : value.length >= 2;
  }
  if (type === "PARTITA_IVA") return italianFormat ? /^\d{11}$/.test(value) : value.length >= 2;
  return value.length >= 2;
}

export function customerIdentity(input: CustomerContext): {
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
  const customerKind = input.customer.kind;
  const identifierOrder =
    customerKind === "BUSINESS_IT"
      ? ["PARTITA_IVA", "CODICE_FISCALE", "ALTRO"]
      : ["CODICE_FISCALE", "PARTITA_IVA", "ALTRO"];
  const identifiers = canonicalTaxIdentifiers(input).sort(
    (left, right) =>
      identifierOrder.indexOf(left.type) - identifierOrder.indexOf(right.type) ||
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
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
    canonicalProfile.kind,
    canonicalProfile.displayName,
    canonicalProfile.billingAddress.line1,
    canonicalProfile.billingAddress.line2,
    canonicalProfile.billingAddress.postalCode,
    canonicalProfile.billingAddress.city,
    canonicalProfile.billingAddress.province,
    canonicalProfile.billingAddress.countryCode,
    canonicalProfile.email,
  ];
  if (profileComplete && canonicalProfile.email) {
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

/**
 * Anomalie che appartengono all'ordine e che una correzione anagrafica non può risolvere.
 * Il difetto del cliente vive invece nello snapshot della preparazione, dove è correggibile.
 */
export function orderReviewRequired(
  order: Pick<OrderInput, "paymentStatus" | "payments" | "refunds" | "sourceReviewRequired">,
  totalsReconciled: boolean,
  grossAmount: number,
  trigger: DraftTrigger = "PAID",
): boolean {
  const paidAmount = order.payments
    .filter((payment) => payment.status === "PAID")
    .reduce((sum, payment) => sum + decimalToCents(payment.amount), 0);
  const paymentPending =
    (order.paymentStatus === "PENDING" ||
      order.payments.some((payment) => payment.status === "PENDING")) &&
    paidAmount < grossAmount;
  const confirmablePending = trigger === "FULFILLED" && paymentPending;
  return (
    order.sourceReviewRequired ||
    order.paymentStatus === "REFUNDED" ||
    (paymentPending && !confirmablePending) ||
    order.payments.some((payment) => payment.status === "REFUNDED") ||
    order.refunds.some(refundNeedsReview) ||
    !totalsReconciled
  );
}

export function refundNeedsReview(refund: { status: string; amount: unknown }): boolean {
  return refund.status === "AMBIGUOUS" || (refund.status === "COMPLETED" && refund.amount === null);
}

/** `%` e `_` digitati in una ricerca sono testo, non caratteri jolly. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export const PAGE_SIZE = 50;

/** Una pagina richiesta fuori dal dominio `integer` di PostgreSQL vale come prima pagina. */
export function pageNumber(value: unknown): number {
  const page = Number(value);
  if (!Number.isSafeInteger(page) || page < 1 || (page - 1) * PAGE_SIZE > POSTGRES_INTEGER_MAX) {
    return 1;
  }
  return page;
}

export function pageOffset(value: unknown): number {
  return (pageNumber(value) - 1) * PAGE_SIZE;
}

/** Le query chiedono una riga in più della pagina: basta a sapere se esiste la successiva. */
export function paginate<T>(rows: T[]) {
  return { rows: rows.slice(0, PAGE_SIZE), hasNext: rows.length > PAGE_SIZE };
}

export function triggerStatus(
  order: Pick<OrderInput, "cancelledAt" | "paymentStatus" | "fulfillmentStatus"> & {
    historical?: boolean;
  },
  trigger: DraftTrigger,
):
  | "CANCELLED_NO_DOCUMENT"
  | "REFUNDED_BEFORE_ISSUE"
  | "ELIGIBLE"
  | "WAITING_FOR_TRIGGER"
  | "LEGACY_BILLING_REVIEW" {
  if (order.historical) return "LEGACY_BILLING_REVIEW";
  if (order.cancelledAt) return "CANCELLED_NO_DOCUMENT";
  if (order.paymentStatus === "REFUNDED") return "REFUNDED_BEFORE_ISSUE";
  if (
    trigger === "PAID" ? order.paymentStatus === "PAID" : order.fulfillmentStatus === "FULFILLED"
  ) {
    return "ELIGIBLE";
  }
  return "WAITING_FOR_TRIGGER";
}
