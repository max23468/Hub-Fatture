const NUMISMATIC_CONDITION =
  /\b(?:q?fdc|spl|qspl|bb|mb|proof|bu|unc)(?:\s*[/+-]\s*(?:q?fdc|spl|qspl|bb|mb))?\b/giu;
const PRODUCT_DETAIL =
  /\b(?:argento|oro|bronzo|rame|nichel|acciaio|bimetallic[ao]|rara?|magnetic[ao]|antimagnetic[ao]|set|zecca|folder|coincard|astuccio|capsula|blister|rotolino|lotto|lustro|superb[oa]|originale|nuov[oa]|usat[oaie]|vintage)\b|\bd['’]epoca\b/giu;

function boundedDescription(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  const truncated = value.slice(0, maxLength);
  return truncated.replace(/\s+\S*$/u, "").trimEnd() || truncated;
}

function normalizedTitle(title: string) {
  return title
    .normalize("NFKC")
    .replace(/^\s*(?:NL\s*\*\s*)+/iu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function currency(title: string) {
  if (/\beuro\b/iu.test(title)) return "Euro";
  if (/\b(?:lira|lire|centesim[oi])\b/iu.test(title)) return "Lire";
  return null;
}

function sovereign(title: string) {
  if (/\b(?:ve\s*iii|vittorio\s+emanuele\s+iii)\b/iu.test(title)) return "VEIII";
  if (/\b(?:ve\s*ii|vittorio\s+emanuele\s+ii)\b/iu.test(title)) return "VEII";
  if (/\bumberto\s+i\b/iu.test(title)) return "Umberto I";
  return null;
}

function generalizedNumismaticTitle(title: string) {
  const hasCoins = /\b(?:monet[ae]|lira|lire|euro|centesim[oi])\b/iu.test(title);
  const hasBanknotes = /\bbanconot[ae]\b/iu.test(title);
  const hasBooks = /\b(?:libr[oi]|catalogo|manuale)\b/iu.test(title);
  const isDivisional = /\bdivisional[ei]\b/iu.test(title);
  if (!hasCoins && !hasBanknotes && !hasBooks && !isDivisional) return null;

  const ruler = sovereign(title);
  if (ruler) return `Monete del Regno d'Italia - ${ruler}`;

  const place = /\bvaticano\b/iu.test(title)
    ? "Città del Vaticano"
    : /\bsan\s+marino\b/iu.test(title)
      ? "San Marino"
      : /\b(?:italia|italian[aei])\b/iu.test(title)
        ? "Italia Repubblica"
        : /\b(?:usa|stati\s+uniti)\b/iu.test(title)
          ? "Monete Estere USA"
          : /\bester[ae]\b/iu.test(title)
            ? "Monete Estere"
            : null;
  const kind = isDivisional
    ? "Divisionali"
    : hasCoins && hasBanknotes
      ? "Monete / Banconote"
      : hasBooks && hasCoins
        ? "Monete / Libri"
        : hasBooks
          ? "Manuale del Collezionista"
          : hasBanknotes
            ? "Banconote"
            : "Monete Commemorative";
  const unit = currency(title);
  return [place, kind, unit ? `in ${unit}` : null].filter(Boolean).join(" ");
}

function sanitizedResidual(title: string) {
  const withoutAppraisal = title.replace(/\b(?:perizia|periziat[ao]|certificat[ao])\b.*$/iu, "");
  const beforeFirstSpecificNumber = withoutAppraisal.split(/\s+\d/gu, 1)[0] ?? withoutAppraisal;
  const residual = beforeFirstSpecificNumber
    .replace(NUMISMATIC_CONDITION, " ")
    .replace(PRODUCT_DETAIL, " ")
    .replace(/[*/_|]+/gu, " ")
    .replace(/\s*[-–—]\s*$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return residual || withoutAppraisal.replace(/\d+/gu, " ").replace(/\s+/gu, " ").trim();
}

export function generalizedProductDescription(titles: readonly string[]) {
  const descriptions = titles.map(normalizedTitle).map((title) => {
    return generalizedNumismaticTitle(title) ?? sanitizedResidual(title);
  });
  return [...new Set(descriptions.filter(Boolean))].join(" / ");
}

export function invoiceDescription(
  titles: readonly string[],
  provider: "SHOPIFY" | "EBAY",
  displayNumber: string,
) {
  const label = provider === "SHOPIFY" ? "Shopify" : "eBay";
  const suffix = ` - Ordine ${label} ${displayNumber}`;
  return `${boundedDescription(generalizedProductDescription(titles), 1000 - suffix.length)}${suffix}`;
}

export function isLegacyInvoiceDescription(
  description: string,
  provider: "SHOPIFY" | "EBAY",
  displayNumber: string,
) {
  const label = provider === "SHOPIFY" ? "Shopify" : "eBay";
  return ["beni", "prodotti"].some(
    (noun) => description === `Vendita ${noun} usati - Ordine ${label} ${displayNumber}`,
  );
}

export function creditDescription(invoiceLineDescription: string) {
  const prefix = "Rimborso ";
  return `${prefix}${boundedDescription(invoiceLineDescription, 1000 - prefix.length)}`;
}
