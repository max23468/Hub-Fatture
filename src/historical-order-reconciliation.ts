import type { acceptedInvoiceFromXml, FiscalProfile } from "./documents.ts";
import { isForeignCustomerKind } from "./orders.ts";
import {
  compactAddressPart,
  customerContainsStructuredStreetNumber,
  customerHasConflictingStructuredStreetNumber,
  normalizedAddressTokens,
  streetKindTokens,
  structuredStreetNumberCandidates,
  withoutAddressPart,
  withoutAddressUnits,
} from "./postal-address.ts";

export type ImportedHistoricalInvoice = ReturnType<typeof acceptedInvoiceFromXml>;

export interface HistoricalInvoiceCandidate {
  id: string;
  provider: "SHOPIFY" | "EBAY";
  customer_snapshot: Record<string, unknown>;
  local_order_date: string;
  gross_amount: number;
  billable_amount: number;
  tax_identifiers: Array<{
    type: string;
    value: string;
    countryCode: string | null;
  }>;
  refunds: Array<{
    status: string;
    amount: number | null;
    completed_date: string | null;
  }>;
}

export function fiscalContract(profile: FiscalProfile) {
  const { phone: _phone, email: _email, ...seller } = profile.seller;
  const { invoiceMethod: _invoiceMethod, ...payment } = profile.payment;
  const {
    lastObservedYear: _year,
    lastObservedNumber: _number,
    sourceXmlSha256: _sha256,
    approvedAt: _approvedAt,
    ...numbering
  } = profile.numbering;
  return { ...profile, seller, numbering, payment };
}

export function hasOrderReference(references: string[], provider: string, displayNumber: string) {
  const expectedProvider = provider.toLowerCase();
  const expectedNumber = displayNumber.toLowerCase();
  return references.some((reference) => {
    const value = reference.toLowerCase();
    if (!value.includes(expectedProvider)) return false;
    const boundary = /[\p{L}\p{N}]/u;
    for (let index = value.indexOf(expectedNumber); index >= 0;) {
      if (
        !boundary.test(value[index - 1] ?? "") &&
        !boundary.test(value[index + expectedNumber.length] ?? "")
      ) {
        return true;
      }
      index = value.indexOf(expectedNumber, index + expectedNumber.length);
    }
    return false;
  });
}

export function hasBareOrderReference(references: string[], displayNumber: string) {
  const expectedNumber = displayNumber.toLowerCase();
  const boundary = /[\p{L}\p{N}]/u;
  return references.some((reference) => {
    const value = reference.toLowerCase();
    for (let index = value.indexOf(expectedNumber); index >= 0;) {
      const prefix = value.slice(Math.max(0, index - 32), index);
      if (
        !boundary.test(value[index - 1] ?? "") &&
        !boundary.test(value[index + expectedNumber.length] ?? "") &&
        /(?:^|[^\p{L}\p{N}])ordine(?:\s+n(?:umero)?\.?)?\s*$/u.test(prefix)
      ) {
        return true;
      }
      index = value.indexOf(expectedNumber, index + expectedNumber.length);
    }
    return false;
  });
}

function hasGenericOrderReference(references: string[]) {
  return references.some((reference) => {
    if (/(?:^|[^\p{L}\p{N}])\d{2}-\d{5}-\d{5}(?=$|[^\p{L}\p{N}])/u.test(reference)) {
      return true;
    }
    const orderReferences = Array.from(
      reference.matchAll(
        /(?:^|[^\p{L}\p{N}])ordine(?:\s+n(?:umero)?\.?)?\s*#?\s*([\p{L}\p{N}][\p{L}\p{N}-]{0,63})/giu,
      ),
      (match) => match[1]!,
    );
    const hashReferences = Array.from(
      reference.matchAll(
        /(?:^|[^\p{L}\p{N}])#([\p{L}\p{N}][\p{L}\p{N}-]{0,63})(?=$|[^\p{L}\p{N}-])/giu,
      ),
      (match) => match[1]!,
    );
    return [...orderReferences, ...hashReferences].some((candidate) => /\d/u.test(candidate));
  });
}

function hasIncompatibleMarketplaceMarker(references: string[], provider: "SHOPIFY" | "EBAY") {
  const expected = provider.toLowerCase();
  return references.some((reference) =>
    Array.from(
      reference.matchAll(/(^|[^\p{L}\p{N}])(ebay|shopify)(?=$|[^\p{L}\p{N}])/giu),
      (match) => match[2]!.toLowerCase(),
    ).some((marker) => marker !== expected),
  );
}

export function hasConflictingMarketplaceReference(
  references: string[],
  provider: "SHOPIFY" | "EBAY",
) {
  if (hasIncompatibleMarketplaceMarker(references, provider)) return true;
  if (hasGenericOrderReference(references)) return true;
  const providerPattern = provider === "SHOPIFY" ? "shopify" : "ebay";
  const providerMarker = new RegExp(
    `(^|[^\\p{L}\\p{N}])${providerPattern}(?=$|[^\\p{L}\\p{N}])`,
    "iu",
  );
  return (
    references.some((reference) => providerMarker.test(reference)) &&
    references.some((reference) => /\d/u.test(reference))
  );
}

export function attributedInvoiceAmount(
  invoice: ImportedHistoricalInvoice,
  provider: string,
  displayNumber: string,
) {
  const matchingLines = invoice.input.lines.filter((line) =>
    hasOrderReference([line.description], provider, displayNumber),
  );
  if (matchingLines.length > 0) {
    return matchingLines.reduce((sum, line) => sum + line.unitAmount * line.quantity, 0);
  }
  return invoice.input.lines.length === 1 &&
    hasOrderReference(invoice.references, provider, displayNumber)
    ? invoice.totalAmount
    : null;
}

const bulgarianTransliteration = new Map(
  Object.entries({
    а: "a",
    б: "b",
    в: "v",
    г: "g",
    д: "d",
    е: "e",
    ж: "zh",
    з: "z",
    и: "i",
    й: "y",
    к: "k",
    л: "l",
    м: "m",
    н: "n",
    о: "o",
    п: "p",
    р: "r",
    с: "s",
    т: "t",
    у: "u",
    ф: "f",
    х: "h",
    ц: "ts",
    ч: "ch",
    ш: "sh",
    щ: "sht",
    ъ: "a",
    ь: "y",
    ю: "yu",
    я: "ya",
  }),
);

function normalizedIdentityPart(value: unknown) {
  return typeof value === "string"
    ? value
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toLocaleLowerCase("it")
        .replace(/[а-я]/gu, (letter) => bulgarianTransliteration.get(letter) ?? letter)
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .replace(/\s+/g, " ")
    : "";
}

function identityTokens(value: unknown) {
  return new Set(normalizedIdentityPart(value).split(" ").filter(Boolean));
}

function containsPersonalIdentityTokens(value: unknown, personalIdentity: unknown) {
  const valueTokens = identityTokens(value);
  const personalTokens = identityTokens(personalIdentity);
  return personalTokens.size >= 2 && [...personalTokens].every((token) => valueTokens.has(token));
}

function sameTokenSet(left: unknown, right: unknown) {
  const leftTokens = identityTokens(left);
  const rightTokens = identityTokens(right);
  return (
    leftTokens.size > 0 &&
    leftTokens.size === rightTokens.size &&
    [...leftTokens].every((token) => rightTokens.has(token))
  );
}

function sameOrSingleAdditionalPersonalNameToken(left: unknown, right: unknown) {
  const leftTokens = identityTokens(left);
  const rightTokens = identityTokens(right);
  if (leftTokens.size < 2 || rightTokens.size < 2) return false;
  const [smaller, larger] =
    leftTokens.size <= rightTokens.size ? [leftTokens, rightTokens] : [rightTokens, leftTokens];
  return larger.size - smaller.size <= 1 && [...smaller].every((token) => larger.has(token));
}

function sameNonEmptyIdentityPart(left: unknown, right: unknown) {
  const normalizedLeft = normalizedIdentityPart(left);
  return Boolean(normalizedLeft && normalizedLeft === normalizedIdentityPart(right));
}

const streetConnectorTokens = new Set([
  "d",
  "l",
  "au",
  "aux",
  "de",
  "des",
  "du",
  "der",
  "die",
  "dem",
  "den",
  "del",
  "della",
  "delle",
  "dei",
  "degli",
  "di",
  "da",
  "dal",
  "dalla",
  "das",
  "do",
  "dos",
  "la",
  "le",
  "les",
  "el",
  "los",
  "las",
  "the",
  "zu",
  "zum",
  "zur",
  "am",
  "im",
  "an",
  "auf",
]);

function distinctiveStreetTokens(
  address: unknown,
  streetNumber: unknown,
  postalCode: unknown,
  keepNumeric: boolean,
) {
  const tokens = withoutAddressUnits(
    withoutAddressPart(
      withoutAddressPart(normalizedAddressTokens(address), streetNumber),
      postalCode,
    ),
  );
  const kindIndex = tokens.findIndex((token) => streetKindTokens.has(token));
  return tokens.filter(
    (token, index) =>
      index !== kindIndex &&
      !streetConnectorTokens.has(token) &&
      token !== "civico" &&
      token !== "snc" &&
      (keepNumeric || !/^\d/u.test(token)),
  );
}

function orderedCommonTokenCount(left: string[], right: string[]) {
  const counts = Array.from({ length: left.length + 1 }, () =>
    Array<number>(right.length + 1).fill(0),
  );
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      counts[leftIndex]![rightIndex] =
        left[leftIndex - 1] === right[rightIndex - 1]
          ? counts[leftIndex - 1]![rightIndex - 1]! + 1
          : Math.max(counts[leftIndex - 1]![rightIndex]!, counts[leftIndex]![rightIndex - 1]!);
    }
  }
  return counts[left.length]![right.length]!;
}

function streetKind(address: unknown, streetNumber: unknown, postalCode: unknown) {
  return withoutAddressPart(
    withoutAddressPart(normalizedAddressTokens(address), streetNumber),
    postalCode,
  ).find((token) => streetKindTokens.has(token));
}

function hasConflictingStructuredStreetNumber(
  address: unknown,
  streetNumber: unknown,
  postalCode: unknown,
) {
  const expected = compactAddressPart(streetNumber);
  const candidates = structuredStreetNumberCandidates(address, postalCode);
  return Boolean(expected && [...candidates].some((candidate) => candidate !== expected));
}

function canonicalItalianStreetToken(token: string) {
  return ["san", "santo", "santa", "sant"].includes(token) ? "san" : token;
}

function hasSupportingAddressEvidence(
  customerAddress: Record<string, unknown>,
  recipientAddress: ImportedHistoricalInvoice["input"]["recipient"]["address"],
) {
  const samePostalCode = sameNonEmptyIdentityPart(
    customerAddress.postalCode,
    recipientAddress.postalCode,
  );
  const sameCity = sameNonEmptyIdentityPart(customerAddress.city, recipientAddress.city);
  const sameAddressLine = sameNonEmptyIdentityPart(customerAddress.line1, recipientAddress.line1);
  if (recipientAddress.streetNumber) {
    const customerCountry = normalizedIdentityPart(customerAddress.countryCode);
    const recipientCountry = normalizedIdentityPart(recipientAddress.countryCode);
    const customerStreetTokens = distinctiveStreetTokens(
      customerAddress.line1,
      recipientAddress.streetNumber,
      customerAddress.postalCode,
      customerCountry === "it",
    );
    const recipientStreetTokens = distinctiveStreetTokens(
      recipientAddress.line1,
      recipientAddress.streetNumber,
      recipientAddress.postalCode,
      customerCountry === "it",
    );
    if (
      !customerCountry ||
      customerCountry !== recipientCountry ||
      !customerContainsStructuredStreetNumber(customerAddress, recipientAddress.streetNumber) ||
      customerHasConflictingStructuredStreetNumber(
        customerAddress,
        recipientAddress.streetNumber,
      ) ||
      hasConflictingStructuredStreetNumber(
        recipientAddress.line1,
        recipientAddress.streetNumber,
        recipientAddress.postalCode,
      )
    ) {
      return false;
    }
    const sharedStreetTokens = orderedCommonTokenCount(customerStreetTokens, recipientStreetTokens);
    if (customerCountry === "it") {
      const sameStreetTokens =
        customerStreetTokens.length > 0 &&
        customerStreetTokens.length === recipientStreetTokens.length &&
        customerStreetTokens.every((token, index) => token === recipientStreetTokens[index]);
      const sameKnownShortStreetVariant =
        customerStreetTokens.length > 0 &&
        customerStreetTokens.length <= 2 &&
        customerStreetTokens.length === recipientStreetTokens.length &&
        customerStreetTokens.every((token) => !/^\d/u.test(token)) &&
        recipientStreetTokens.every((token) => !/^\d/u.test(token)) &&
        customerStreetTokens.every(
          (token, index) =>
            canonicalItalianStreetToken(token) ===
            canonicalItalianStreetToken(recipientStreetTokens[index]!),
        );
      return (
        samePostalCode &&
        sameCity &&
        streetKind(
          customerAddress.line1,
          recipientAddress.streetNumber,
          customerAddress.postalCode,
        ) ===
          streetKind(
            recipientAddress.line1,
            recipientAddress.streetNumber,
            recipientAddress.postalCode,
          ) &&
        (sameStreetTokens || sameKnownShortStreetVariant)
      );
    }
    return sharedStreetTokens >= 2;
  }
  return sameAddressLine && samePostalCode && sameCity;
}

function customerIdentityNames(customer: Record<string, unknown>, business: boolean) {
  const canonical =
    customer.canonicalProfile && typeof customer.canonicalProfile === "object"
      ? (customer.canonicalProfile as Record<string, unknown>)
      : {};
  const businessNames = [customer.companyName, canonical.companyName].filter((value) =>
    normalizedIdentityPart(value),
  );
  const personalNames = [
    [customer.firstName, customer.lastName].filter(Boolean).join(" "),
    [canonical.firstName, canonical.lastName].filter(Boolean).join(" "),
  ].filter((value) => normalizedIdentityPart(value));
  const typedNames = business ? businessNames : personalNames;
  if (typedNames.length > 0) return typedNames;
  if ((business ? personalNames : businessNames).length > 0) return [];
  return [customer.displayName, canonical.displayName].filter((value) =>
    normalizedIdentityPart(value),
  );
}

function hasExplicitBusinessName(customer: Record<string, unknown>) {
  const canonical =
    customer.canonicalProfile && typeof customer.canonicalProfile === "object"
      ? (customer.canonicalProfile as Record<string, unknown>)
      : {};
  return [customer.companyName, canonical.companyName].some((value) =>
    Boolean(normalizedIdentityPart(value)),
  );
}

function matchesRecipientWithoutTaxId(
  customer: Record<string, unknown>,
  recipient: ImportedHistoricalInvoice["input"]["recipient"],
) {
  const billingAddress =
    customer.billingAddress && typeof customer.billingAddress === "object"
      ? (customer.billingAddress as Record<string, unknown>)
      : {};
  const recipientBusinessName = normalizedIdentityPart(recipient.businessName);
  const recipientName =
    recipientBusinessName ||
    normalizedIdentityPart([recipient.firstName, recipient.lastName].filter(Boolean).join(" "));
  const customerKind = typeof customer.kind === "string" ? customer.kind.trim().toUpperCase() : "";
  const hasCustomerBusinessName = hasExplicitBusinessName(customer);
  const customerIsBusiness =
    customerKind === "BUSINESS_IT" ||
    (isForeignCustomerKind(customerKind) && hasCustomerBusinessName);
  const customerIsPersonal =
    customerKind === "PRIVATE_IT" ||
    (isForeignCustomerKind(customerKind) && !hasCustomerBusinessName);
  if (
    (customerIsBusiness && !recipientBusinessName) ||
    (customerIsPersonal && recipientBusinessName)
  ) {
    return false;
  }
  const business = customerIsBusiness || (!customerIsPersonal && Boolean(recipientBusinessName));
  const customerCountry = normalizedIdentityPart(billingAddress.countryCode);
  const recipientCountry = normalizedIdentityPart(recipient.address.countryCode);
  if (!recipientName || !customerCountry || customerCountry !== recipientCountry) return false;
  return customerIdentityNames(customer, business).some(
    (customerName) =>
      (business
        ? sameNonEmptyIdentityPart(customerName, recipientName)
        : sameTokenSet(customerName, recipientName)) &&
      hasSupportingAddressEvidence(billingAddress, recipient.address),
  );
}

function matchesManuallyReviewedRecipient(
  customer: Record<string, unknown>,
  recipient: ImportedHistoricalInvoice["input"]["recipient"],
) {
  const recipientBusinessName = normalizedIdentityPart(recipient.businessName);
  const recipientName =
    recipientBusinessName ||
    normalizedIdentityPart([recipient.firstName, recipient.lastName].filter(Boolean).join(" "));
  const customerKind = typeof customer.kind === "string" ? customer.kind.trim().toUpperCase() : "";
  const hasCustomerBusinessName = hasExplicitBusinessName(customer);
  const personalBusinessAlias =
    isForeignCustomerKind(customerKind) &&
    !recipientBusinessName &&
    Boolean(recipientName) &&
    customerIdentityNames(customer, false).some(
      (personalName) =>
        sameOrSingleAdditionalPersonalNameToken(personalName, recipientName) &&
        customerIdentityNames(customer, true).some((businessName) =>
          containsPersonalIdentityTokens(businessName, personalName),
        ),
    );
  const customerIsPersonal =
    customerKind === "PRIVATE_IT" ||
    (isForeignCustomerKind(customerKind) && (!hasCustomerBusinessName || personalBusinessAlias));
  if (!customerIsPersonal || (customerKind === "PRIVATE_IT" && recipientBusinessName)) return false;
  if (matchesRecipientWithoutTaxId(customer, recipient)) return true;
  const billingAddress =
    customer.billingAddress && typeof customer.billingAddress === "object"
      ? (customer.billingAddress as Record<string, unknown>)
      : {};
  const recipientPostalCodeForStreetNumber =
    normalizedIdentityPart(recipient.address.countryCode) !== "it" &&
    compactAddressPart(recipient.address.postalCode) === "00000"
      ? billingAddress.postalCode
      : recipient.address.postalCode;
  if (
    !recipient.address.streetNumber ||
    !recipientName ||
    !sameNonEmptyIdentityPart(billingAddress.countryCode, recipient.address.countryCode) ||
    !customerContainsStructuredStreetNumber(billingAddress, recipient.address.streetNumber) ||
    customerHasConflictingStructuredStreetNumber(billingAddress, recipient.address.streetNumber) ||
    hasConflictingStructuredStreetNumber(
      recipient.address.line1,
      recipient.address.streetNumber,
      recipientPostalCodeForStreetNumber,
    )
  ) {
    return false;
  }
  return customerIdentityNames(customer, false).some((customerName) =>
    sameOrSingleAdditionalPersonalNameToken(customerName, recipientName),
  );
}

export function referenceIdentifiesInvoice(reference: string, documentNumber: string) {
  const expected = documentNumber
    .normalize("NFKC")
    .toUpperCase()
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*");
  return new RegExp(`(^|[^A-Z0-9])${expected}(?=$|[^A-Z0-9])`, "u").test(
    reference.normalize("NFKC").toUpperCase(),
  );
}

export function historicalDocumentDateAllowed(orderDate: string, documentDate: string) {
  const difference = Date.parse(`${documentDate}T00:00:00Z`) - Date.parse(`${orderDate}T00:00:00Z`);
  return difference >= 0 && difference <= 7 * 24 * 60 * 60 * 1000;
}

export function taxIdentifierKey(identifier: {
  type: string;
  value: string;
  countryCode?: string | null;
}) {
  const value = identifier.value
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const countryCode = (
    identifier.countryCode ??
    (identifier.type === "CODICE_FISCALE" ||
    (identifier.type === "PARTITA_IVA" && /^\d{11}$/.test(value))
      ? "IT"
      : "")
  ).toUpperCase();
  return JSON.stringify([identifier.type, countryCode, value]);
}

export function matchesHistoricalRecipient(
  candidate: HistoricalInvoiceCandidate,
  invoice: ImportedHistoricalInvoice,
  invoiceTaxIdentifiers: Set<string>,
  manualReviewApproved = false,
) {
  const strictMatch =
    candidate.tax_identifiers.length > 0
      ? candidate.tax_identifiers.some((identifier) =>
          invoiceTaxIdentifiers.has(taxIdentifierKey(identifier)),
        )
      : matchesRecipientWithoutTaxId(candidate.customer_snapshot, invoice.input.recipient);
  return (
    strictMatch ||
    (manualReviewApproved &&
      matchesManuallyReviewedRecipient(candidate.customer_snapshot, invoice.input.recipient))
  );
}

export function expectedHistoricalInvoiceAmount(
  candidate: HistoricalInvoiceCandidate,
  documentDate: string,
) {
  if (
    candidate.refunds.some(
      (refund) =>
        refund.status === "AMBIGUOUS" ||
        (refund.status === "COMPLETED" &&
          (refund.amount === null ||
            !refund.completed_date ||
            refund.completed_date === documentDate)),
    )
  ) {
    return null;
  }
  const amount =
    (candidate.provider === "SHOPIFY" ? candidate.billable_amount : candidate.gross_amount) -
    candidate.refunds
      .filter((refund) => refund.status === "COMPLETED" && refund.completed_date! < documentDate)
      .reduce((sum, refund) => sum + refund.amount!, 0);
  return amount >= 0 ? amount : null;
}
