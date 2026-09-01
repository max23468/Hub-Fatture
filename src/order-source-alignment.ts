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
  if (isDeepStrictEqual(customerEmail(previous), customerEmail(current))) return false;
  return isDeepStrictEqual(withoutEmailEvidence(previous), withoutEmailEvidence(current));
}
