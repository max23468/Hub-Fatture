import { isDeepStrictEqual } from "node:util";

import { splitEbayCareOfRecipient } from "./ebay-recipient.ts";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function ebayCareOfSource(snapshot: Record<string, unknown>) {
  const source = record(snapshot.sourceSnapshot);
  const instructions = Array.isArray(source?.fulfillmentStartInstructions)
    ? source.fulfillmentStartInstructions
    : [];
  const instruction = record(instructions[0]);
  const shippingStep = record(instruction?.shippingStep);
  const shipTo = record(shippingStep?.shipTo);
  const address = record(shipTo?.contactAddress);
  return splitEbayCareOfRecipient(shipTo?.fullName, address?.addressLine2).careOf;
}

function customerWithoutCareOfProjection(value: unknown): unknown {
  const customer = record(value);
  if (!customer) return value;
  const addressWithoutLine2 = (candidate: unknown) => {
    const address = record(candidate);
    if (!address) return candidate;
    return Object.fromEntries(Object.entries(address).filter(([key]) => key !== "line2"));
  };
  return normalizeJsonValue({
    ...Object.fromEntries(
      Object.entries(customer).filter(
        ([key]) => !["displayName", "firstName", "lastName", "canonicalProfile"].includes(key),
      ),
    ),
    billingAddress: addressWithoutLine2(customer.billingAddress),
    shippingAddress: addressWithoutLine2(customer.shippingAddress),
  });
}

function customerLine2(value: unknown, addressKey: "billingAddress" | "shippingAddress") {
  const customer = record(value);
  const address = record(customer?.[addressKey]);
  return address?.line2;
}

function samePresentationText(value: unknown, expected: string) {
  return (
    typeof value === "string" &&
    value.normalize("NFKC").toLocaleLowerCase("it-IT").replace(/\s+/g, " ").trim() ===
      expected.normalize("NFKC").toLocaleLowerCase("it-IT").replace(/\s+/g, " ").trim()
  );
}

/**
 * Riconosce esclusivamente la nuova interpretazione del medesimo destinatario eBay:
 * la parte che segue `c/o` lascia il nome e diventa la seconda riga dell'indirizzo.
 */
export function isEbayCareOfAddressMapperOnlyChange(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
): boolean {
  if (previous.provider !== "EBAY" || current.provider !== "EBAY") return false;
  if (!isDeepStrictEqual(previous.sourceSnapshot, current.sourceSnapshot)) return false;
  const careOf = ebayCareOfSource(current);
  if (!careOf) return false;
  const previousCustomer = record(previous.customer);
  const currentCustomer = record(current.customer);
  const previousSnapshot = record(previous.customerSnapshot);
  const currentSnapshot = record(current.customerSnapshot);
  if (!previousCustomer || !currentCustomer || !previousSnapshot || !currentSnapshot) return false;

  const companyName =
    typeof currentCustomer.companyName === "string" && currentCustomer.companyName.trim()
      ? currentCustomer.companyName
      : undefined;
  if (
    previousCustomer.displayName !== (companyName ?? careOf.originalName) ||
    currentCustomer.displayName !== (companyName ?? careOf.recipientName) ||
    !samePresentationText(previousSnapshot.displayName, companyName ?? careOf.originalName) ||
    !samePresentationText(currentSnapshot.displayName, companyName ?? careOf.recipientName)
  ) {
    return false;
  }
  for (const addressKey of ["billingAddress", "shippingAddress"] as const) {
    if (
      customerLine2(previousCustomer, addressKey) !== careOf.previousLine2 ||
      customerLine2(currentCustomer, addressKey) !== careOf.currentLine2 ||
      customerLine2(previousSnapshot, addressKey) !== careOf.previousLine2 ||
      customerLine2(currentSnapshot, addressKey) !== careOf.currentLine2
    ) {
      return false;
    }
  }
  if (
    !isDeepStrictEqual(
      customerWithoutCareOfProjection(previousCustomer),
      customerWithoutCareOfProjection(currentCustomer),
    ) ||
    !isDeepStrictEqual(
      customerWithoutCareOfProjection(previousSnapshot),
      customerWithoutCareOfProjection(currentSnapshot),
    )
  ) {
    return false;
  }
  return isDeepStrictEqual(
    withoutProviderAndMapperEvidence(previous),
    withoutProviderAndMapperEvidence(current),
  );
}

function canonicalEmail(snapshot: Record<string, unknown>): unknown {
  const customerSnapshot = record(snapshot.customerSnapshot);
  return customerEmail(customerSnapshot);
}

function customerEmail(snapshot: Record<string, unknown> | null): unknown {
  const canonicalProfile = record(snapshot?.canonicalProfile);
  return canonicalProfile?.email ?? snapshot?.email;
}

/**
 * I default stabili dell'input valgono anche per gli snapshot persistiti prima che il campo
 * esistesse. La normalizzazione è condivisa dagli allineamenti automatici: il valore di default
 * non apre un conflitto, mentre qualunque valore effettivo continua a essere confrontato.
 */
function snapshotWithStableDefaults(snapshot: Record<string, unknown>) {
  return { sourceIdentityIds: [], ...snapshot };
}

function canonicalProfileWithoutEmail(snapshot: Record<string, unknown>): unknown {
  const customerSnapshot = record(snapshot.customerSnapshot);
  return withoutEmailEvidence(record(customerSnapshot?.canonicalProfile));
}

function withoutEmailEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutEmailEvidence);
  const source = record(value);
  if (!source) return value;
  return Object.fromEntries(
    Object.entries(source).flatMap(([key, item]) =>
      key === "email" || key === "reviewFingerprint" || item === undefined
        ? []
        : [[key, withoutEmailEvidence(item)]],
    ),
  );
}

/**
 * L'e-mail eBay è un recapito operativo, non un'identità fiscale. La modifica è sicura
 * soltanto se i due snapshot normalizzati sono identici dopo aver rimosso esclusivamente
 * le e-mail e il fingerprint che da esse deriva.
 */
export function isEbayEmailOnlyChange(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
): boolean {
  if (previous.provider !== "EBAY" || current.provider !== "EBAY") return false;
  if (isDeepStrictEqual(canonicalEmail(previous), canonicalEmail(current))) return false;
  return isDeepStrictEqual(
    withoutEmailEvidence(snapshotWithStableDefaults(previous)),
    withoutEmailEvidence(snapshotWithStableDefaults(current)),
  );
}

function withoutProviderAndMapperEvidence(snapshot: Record<string, unknown>): unknown {
  const ignored = new Set([
    "customer",
    "customerIdentity",
    "customerReviewRequired",
    "customerSnapshot",
    "reviewFingerprint",
    "sourceSnapshot",
  ]);
  return withoutEmailEvidence(
    Object.fromEntries(
      Object.entries(snapshotWithStableDefaults(snapshot)).filter(([key]) => !ignored.has(key)),
    ),
  );
}

/**
 * Un replay può correggere anche l'interpretazione del medesimo profilo. La variante
 * semantica ignora payload grezzo e segnali derivati, ma pretende che il profilo canonico
 * senza e-mail e tutti i dati economici dell'ordine siano identici.
 */
export function isEbayEmailAndMapperOnlyChange(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
): boolean {
  if (previous.provider !== "EBAY" || current.provider !== "EBAY") return false;
  if (isDeepStrictEqual(canonicalEmail(previous), canonicalEmail(current))) return false;
  return (
    isDeepStrictEqual(
      canonicalProfileWithoutEmail(previous),
      canonicalProfileWithoutEmail(current),
    ) &&
    isDeepStrictEqual(
      withoutProviderAndMapperEvidence(previous),
      withoutProviderAndMapperEvidence(current),
    )
  );
}

/**
 * Riconosce una preparazione eBay rimasta indietro rispetto all'ordine corrente. Il
 * confronto ignora ricorsivamente soltanto le evidenze e-mail; ogni altro campo del
 * destinatario deve coincidere e una correzione manuale viene esclusa dal chiamante.
 */
export function isEbayCustomerEmailOnlyMismatch(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
): boolean {
  if (isDeepStrictEqual(previous, current)) return false;
  return isDeepStrictEqual(withoutEmailEvidence(previous), withoutEmailEvidence(current));
}

function refundRecord(value: unknown) {
  const candidate = record(value);
  if (!candidate || typeof candidate.externalRefundId !== "string") return null;
  return candidate;
}

function normalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : normalizeJsonValue(item)));
  }
  const source = record(value);
  if (!source) return value;
  return Object.fromEntries(
    Object.entries(source).flatMap(([key, item]) =>
      item === undefined ? [] : [[key, normalizeJsonValue(item)]],
    ),
  );
}

function sameInstant(left: unknown, right: unknown) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime;
}

const romeCalendarDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Rome",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function romeCalendarDate(value: unknown) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return romeCalendarDateFormatter.format(new Date(value));
}

function bankTransferMethod(value: unknown) {
  return typeof value === "string" && /bonifico|bank\s*transfer/i.test(value);
}

function withoutPaymentTimestamps(snapshot: Record<string, unknown>) {
  const payments = Array.isArray(snapshot.payments) ? snapshot.payments : [];
  return normalizeJsonValue({
    ...Object.fromEntries(
      Object.entries(snapshotWithStableDefaults(snapshot)).filter(
        ([key]) =>
          ![
            "payments",
            "reviewFingerprint",
            "sourceConflictRequired",
            "sourceSnapshot",
            "updatedAt",
          ].includes(key),
      ),
    ),
    payments: payments.map((value) => {
      const payment = record(value);
      return payment
        ? Object.fromEntries(Object.entries(payment).filter(([key]) => key !== "paidAt"))
        : value;
    }),
  });
}

function ebaySourceWithoutPaymentTimestamps(value: unknown) {
  const source = record(value);
  if (!source) return value;
  const summary = record(source.paymentSummary);
  const payments = Array.isArray(summary?.payments) ? summary.payments : [];
  return normalizeJsonValue({
    ...Object.fromEntries(Object.entries(source).filter(([key]) => key !== "lastModifiedDate")),
    ...(summary
      ? {
          paymentSummary: {
            ...summary,
            payments: payments.map((value) => {
              const payment = record(value);
              return payment
                ? Object.fromEntries(
                    Object.entries(payment).filter(([key]) => key !== "paymentDate"),
                  )
                : value;
            }),
          },
        }
      : {}),
  });
}

/**
 * eBay può rettificare `paymentDate` lasciando invariato il pagamento.
 * La variazione non è fiscale soltanto se resta nello stesso giorno di Roma, non riguarda
 * un bonifico e ogni altro dato normalizzato e grezzo coincide esattamente.
 */
export function isEbayPaymentTimestampOnlyChange(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
): boolean {
  if (previous.provider !== "EBAY" || current.provider !== "EBAY") return false;
  const previousPayments = Array.isArray(previous.payments) ? previous.payments : [];
  const currentPayments = Array.isArray(current.payments) ? current.payments : [];
  if (!previousPayments.length || previousPayments.length !== currentPayments.length) return false;

  let timestampChanged = false;
  for (let index = 0; index < previousPayments.length; index += 1) {
    const before = record(previousPayments[index]);
    const after = record(currentPayments[index]);
    if (!before || !after || bankTransferMethod(after.method)) return false;
    if (isDeepStrictEqual(before.paidAt, after.paidAt)) continue;
    const beforeDate = romeCalendarDate(before.paidAt);
    const afterDate = romeCalendarDate(after.paidAt);
    if (!beforeDate || beforeDate !== afterDate) return false;
    timestampChanged = true;
  }
  if (!timestampChanged) return false;

  const previousSource = record(previous.sourceSnapshot);
  const currentSource = record(current.sourceSnapshot);
  const previousSourcePayments = Array.isArray(record(previousSource?.paymentSummary)?.payments)
    ? (record(previousSource?.paymentSummary)!.payments as unknown[])
    : [];
  const currentSourcePayments = Array.isArray(record(currentSource?.paymentSummary)?.payments)
    ? (record(currentSource?.paymentSummary)!.payments as unknown[])
    : [];
  if (
    previousSourcePayments.length !== previousPayments.length ||
    currentSourcePayments.length !== currentPayments.length
  ) {
    return false;
  }
  for (let index = 0; index < previousPayments.length; index += 1) {
    const beforeSourcePayment = record(previousSourcePayments[index]);
    const afterSourcePayment = record(currentSourcePayments[index]);
    const beforePayment = record(previousPayments[index]);
    const afterPayment = record(currentPayments[index]);
    if (
      !beforeSourcePayment ||
      !afterSourcePayment ||
      !beforePayment ||
      !afterPayment ||
      !sameInstant(beforeSourcePayment.paymentDate, beforePayment.paidAt) ||
      !sameInstant(afterSourcePayment.paymentDate, afterPayment.paidAt)
    ) {
      return false;
    }
  }

  return (
    isDeepStrictEqual(withoutPaymentTimestamps(previous), withoutPaymentTimestamps(current)) &&
    isDeepStrictEqual(
      ebaySourceWithoutPaymentTimestamps(previous.sourceSnapshot),
      ebaySourceWithoutPaymentTimestamps(current.sourceSnapshot),
    ) &&
    sameInstant(previous.updatedAt, previousSource?.lastModifiedDate) &&
    sameInstant(current.updatedAt, currentSource?.lastModifiedDate)
  );
}

function withoutEbayRefundMapperEvidence(snapshot: Record<string, unknown>): unknown {
  const ignored = new Set(["orderReviewRequired", "reviewFingerprint", "sourceConflictRequired"]);
  return normalizeJsonValue(
    Object.fromEntries(
      Object.entries(snapshotWithStableDefaults(snapshot)).filter(([key]) => !ignored.has(key)),
    ),
  );
}

/**
 * Riconosce il replay eBay che completa un rimborso prima ambiguo usando lo stesso
 * payload provider. L'unica variazione ammessa è `AMBIGUOUS/null -> COMPLETED/importo`;
 * identificativo, dato grezzo e istante del rimborso devono restare identici.
 */
export function isEbayRefundMapperOnlyChange(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
): boolean {
  if (previous.provider !== "EBAY" || current.provider !== "EBAY") return false;
  if (!isDeepStrictEqual(previous.sourceSnapshot, current.sourceSnapshot)) return false;
  const previousRefunds = Array.isArray(previous.refunds) ? previous.refunds : [];
  const currentRefunds = Array.isArray(current.refunds) ? current.refunds : [];
  if (previousRefunds.length === 0 || previousRefunds.length !== currentRefunds.length)
    return false;

  let completedAmbiguousRefund = false;
  const normalizedCurrentRefunds = currentRefunds.map((value, index) => {
    const before = refundRecord(previousRefunds[index]);
    const after = refundRecord(value);
    if (!before || !after || before.externalRefundId !== after.externalRefundId) return value;
    if (isDeepStrictEqual(before, after)) return value;
    if (
      before.status !== "AMBIGUOUS" ||
      before.amount !== null ||
      after.status !== "COMPLETED" ||
      typeof after.amount !== "string" ||
      !/^\d+(?:\.\d{2})$/.test(after.amount) ||
      !isDeepStrictEqual(before.raw, after.raw) ||
      before.completedAt !== after.completedAt
    ) {
      return value;
    }
    completedAmbiguousRefund = true;
    return before;
  });
  if (!completedAmbiguousRefund) return false;

  return isDeepStrictEqual(
    withoutEbayRefundMapperEvidence(previous),
    withoutEbayRefundMapperEvidence({
      ...current,
      refunds: normalizedCurrentRefunds,
    }),
  );
}

function withoutShopifyFulfillmentEvidence(snapshot: Record<string, unknown>): unknown {
  const ignored = new Set([
    "fulfillmentStatus",
    "reviewFingerprint",
    "sourceConflictRequired",
    "sourceSnapshot",
    "updatedAt",
  ]);
  return normalizeJsonValue(
    Object.fromEntries(
      Object.entries(snapshotWithStableDefaults(snapshot)).filter(([key]) => !ignored.has(key)),
    ),
  );
}

/**
 * L'evasione Shopify è un avanzamento operativo e non fiscale. Il riallineamento è
 * automatico solo in avanti e solo quando ogni altro dato normalizzato coincide.
 */
export function isShopifyFulfillmentOnlyChange(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
): boolean {
  if (previous.provider !== "SHOPIFY" || current.provider !== "SHOPIFY") return false;
  const rank: Record<string, number> = { UNFULFILLED: 0, PARTIAL: 1, FULFILLED: 2 };
  const previousRank = rank[String(previous.fulfillmentStatus)] ?? -1;
  const currentRank = rank[String(current.fulfillmentStatus)] ?? -1;
  return (
    currentRank > previousRank &&
    isDeepStrictEqual(
      withoutShopifyFulfillmentEvidence(previous),
      withoutShopifyFulfillmentEvidence(current),
    )
  );
}
