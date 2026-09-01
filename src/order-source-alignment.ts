import { isDeepStrictEqual } from "node:util";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function canonicalEmail(snapshot: Record<string, unknown>): unknown {
  const customerSnapshot = record(snapshot.customerSnapshot);
  return customerEmail(customerSnapshot);
}

function customerEmail(snapshot: Record<string, unknown> | null): unknown {
  const canonicalProfile = record(snapshot?.canonicalProfile);
  return canonicalProfile?.email ?? snapshot?.email;
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
  return isDeepStrictEqual(withoutEmailEvidence(previous), withoutEmailEvidence(current));
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
    Object.fromEntries(Object.entries(snapshot).filter(([key]) => !ignored.has(key))),
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

function withoutEbayRefundMapperEvidence(snapshot: Record<string, unknown>): unknown {
  const ignored = new Set(["orderReviewRequired", "reviewFingerprint", "sourceConflictRequired"]);
  return JSON.parse(
    JSON.stringify(
      Object.fromEntries(Object.entries(snapshot).filter(([key]) => !ignored.has(key))),
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
    withoutEbayRefundMapperEvidence({ ...current, refunds: normalizedCurrentRefunds }),
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
  return JSON.parse(
    JSON.stringify(
      Object.fromEntries(Object.entries(snapshot).filter(([key]) => !ignored.has(key))),
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
