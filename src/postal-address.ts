export const streetKindTokens = new Set([
  "via",
  "viale",
  "vicolo",
  "piazza",
  "piazzale",
  "corso",
  "strada",
  "largo",
  "lungomare",
  "localita",
  "frazione",
  "contrada",
  "rue",
  "avenue",
  "boulevard",
  "chemin",
  "route",
  "street",
  "road",
  "lane",
  "drive",
  "place",
  "ul",
  "ulica",
  "aleja",
  "strasse",
  "straße",
  "platz",
  "weg",
  "allee",
  "gasse",
]);

export const addressUnitMarkers = new Set([
  "bl",
  "bloc",
  "block",
  "sc",
  "scara",
  "staircase",
  "et",
  "etaj",
  "floor",
  "ap",
  "apt",
  "apartment",
  "apartament",
  "unit",
  "corp",
  "building",
  "camera",
]);

const secondAddressLineUnitMarkers = new Set([
  ...addressUnitMarkers,
  "edificio",
  "dg",
  "eg",
  "etage",
  "etages",
  "emelet",
  "geschoss",
  "geschosse",
  "interno",
  "localita",
  "palazzina",
  "piano",
  "pietro",
  "piso",
  "pisos",
  "planta",
  "plantas",
  "og",
  "orofos",
  "patro",
  "poschodie",
  "scala",
  "stock",
  "stockwerk",
  "stockwerke",
  "kat",
  "kerros",
  "ug",
  "vaning",
  "verdieping",
  "verdiepingen",
]);

const postposedFloorMarkers = new Set([
  "et",
  "dg",
  "eg",
  "etage",
  "etages",
  "etaj",
  "emelet",
  "floor",
  "geschoss",
  "geschosse",
  "kat",
  "kerros",
  "piano",
  "pietro",
  "piso",
  "pisos",
  "planta",
  "plantas",
  "og",
  "orofos",
  "patro",
  "poschodie",
  "stock",
  "stockwerk",
  "stockwerke",
  "ug",
  "vaning",
  "verdieping",
  "verdiepingen",
]);

const numberedStreetQualifiers = new Set([
  "comunale",
  "provinciale",
  "regionale",
  "statale",
  "national",
  "nationale",
  "nacional",
  "krajowa",
]);
const numberedStreetAbbreviations = new Set(["sc", "sp", "sr", "ss"]);

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

export function normalizedAddressTokens(value: unknown) {
  return normalizedAddressPart(value).split(" ").filter(Boolean);
}

export function compactAddressPart(value: unknown) {
  return normalizedAddressPart(value).replaceAll(" ", "");
}

function normalizedAddressPart(value: unknown) {
  return typeof value === "string"
    ? value
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toLocaleLowerCase("it")
        .replace(/[а-я]/gu, (letter) => bulgarianTransliteration.get(letter) ?? letter)
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .replace(/\s+/gu, " ")
    : "";
}

function isCivicSuffixToken(value: string) {
  return /^\p{L}$/u.test(value) || ["bis", "ter", "quater"].includes(value);
}

export function withoutAddressPart(tokens: string[], value: unknown) {
  const expected = compactAddressPart(value);
  if (!expected) return tokens;
  return tokens.filter((_, index) => {
    if (tokens[index] === expected) return false;
    if (`${tokens[index]}${tokens[index + 1] ?? ""}` === expected) return false;
    if (`${tokens[index - 1] ?? ""}${tokens[index]}` === expected) return false;
    return true;
  });
}

export function withoutAddressUnits(tokens: string[], markers = addressUnitMarkers) {
  const unitTailIndex = tokens.findIndex((token, index) => {
    if (!markers.has(token)) return false;
    const followsStructuredCivic =
      /^\d/u.test(tokens[index - 1] ?? "") ||
      (/^\d/u.test(tokens[index - 2] ?? "") && /^\p{L}+$/u.test(tokens[index - 1] ?? ""));
    const startsStructuredIdentifier = /^[\p{L}\p{N}]*\d[\p{L}\p{N}]*$/u.test(
      tokens[index + 1] ?? "",
    );
    return followsStructuredCivic || startsStructuredIdentifier;
  });
  return unitTailIndex === -1 ? tokens : tokens.slice(0, unitTailIndex);
}

export function structuredStreetNumberCandidates(
  address: unknown,
  postalCode: unknown,
  unitMarkers = addressUnitMarkers,
  classifySecondAddressLine = false,
) {
  const normalizedParts = withoutAddressPart(normalizedAddressTokens(address), postalCode);
  const hasExplicitCivicSeparator =
    typeof address === "string" && /^\s*\d+[\p{L}]?\s*[,;/]/u.test(address);
  if (
    classifySecondAddressLine &&
    (unitMarkers.has(normalizedParts[0] ?? "") ||
      (!/^\d/u.test(normalizedParts[0] ?? "") && normalizedParts[0] !== "civico") ||
      (/^\d/u.test(normalizedParts[0] ?? "") &&
        postposedFloorMarkers.has(normalizedParts[1] ?? "") &&
        !hasExplicitCivicSeparator) ||
      (/^\d/u.test(normalizedParts[0] ?? "") &&
        Boolean(normalizedParts[1]) &&
        !isCivicSuffixToken(normalizedParts[1]!) &&
        !hasExplicitCivicSeparator) ||
      (typeof address === "string" && /^\s*\d+\s*[°ºª]/u.test(address)))
  ) {
    return new Set<string>();
  }
  if (classifySecondAddressLine && normalizedParts[0] === "civico") {
    const declaredCivic = normalizedParts[1] ?? "";
    if (!/^\d/u.test(declaredCivic)) return new Set<string>();
    const suffix = normalizedParts[2] ?? "";
    return new Set([isCivicSuffixToken(suffix) ? `${declaredCivic}${suffix}` : declaredCivic]);
  }
  let addressParts = withoutAddressUnits(normalizedParts, unitMarkers);
  const floorAfterExplicitCivic =
    typeof address === "string"
      ? address.match(/^\s*(?:civico\s+)?\d+[\p{L}]?\s*[,;/]\s*(\d+)\s*[°ºª]?\s*(\p{L}+)/iu)
      : null;
  if (
    floorAfterExplicitCivic &&
    unitMarkers.has(normalizedAddressPart(floorAfterExplicitCivic[2])) &&
    addressParts.at(-1) === floorAfterExplicitCivic[1]
  ) {
    addressParts = addressParts.slice(0, -1);
  }
  const candidates = new Set<string>();
  const first = addressParts[0] ?? "";
  const second = addressParts[1] ?? "";
  const leadingForeignPostalCode =
    /^\d{4,6}$/u.test(first) &&
    /^\p{L}/u.test(second) &&
    addressParts.slice(2).some((part) => /^\d/u.test(part));
  if (/^\d/u.test(first) && !leadingForeignPostalCode) {
    candidates.add(isCivicSuffixToken(second) ? `${first}${second}` : first);
    return candidates;
  }
  const last = addressParts.at(-1) ?? "";
  const penultimate = addressParts.at(-2) ?? "";
  const trailingUnmarkedUnit = /^\d+[\p{L}]$/u.test(last) && /^\d+$/u.test(penultimate);
  if (trailingUnmarkedUnit) {
    candidates.add(penultimate);
  } else if (/^\d/u.test(last)) {
    candidates.add(last);
  } else if (/^\d/u.test(penultimate) && isCivicSuffixToken(last)) {
    candidates.add(`${penultimate}${last}`);
  }
  return candidates;
}

function addressNumberEvidence(address: Record<string, unknown>) {
  const primary = structuredStreetNumberCandidates(address.line1, address.postalCode);
  const secondary = structuredStreetNumberCandidates(
    address.line2,
    address.postalCode,
    secondAddressLineUnitMarkers,
    true,
  );
  const primaryTokens = withoutAddressPart(
    normalizedAddressTokens(address.line1),
    address.postalCode,
  );
  const secondaryTokens = normalizedAddressTokens(address.line2);
  const primaryIsNumberedStreetName =
    (streetKindTokens.has(primaryTokens[0] ?? "") &&
      numberedStreetQualifiers.has(primaryTokens[1] ?? "")) ||
    (numberedStreetQualifiers.has(primaryTokens[0] ?? "") &&
      streetKindTokens.has(primaryTokens[1] ?? "")) ||
    numberedStreetAbbreviations.has(primaryTokens[0] ?? "");
  const primaryNumericTokens = primaryTokens.filter((token) => /^\d/u.test(token));
  const terminalYear = Number(primaryNumericTokens.at(-1));
  const primaryIsCommemorativeStreetName =
    streetKindTokens.has(primaryTokens[0] ?? "") &&
    primaryNumericTokens.length >= 2 &&
    /^\d{4}$/u.test(primaryNumericTokens.at(-1) ?? "") &&
    terminalYear >= 1800 &&
    terminalYear <= 2099;
  const primaryContainsOnlyStreetNumber =
    (primaryIsNumberedStreetName && primaryNumericTokens.length === 1) ||
    primaryIsCommemorativeStreetName;
  if (secondaryTokens[0] === "civico" && primary.size > 0 && !primaryContainsOnlyStreetNumber) {
    return {
      candidates: new Set([...primary, ...secondary]),
      source: "conflict" as const,
      primaryContainsOnlyStreetNumber,
    };
  }
  if (
    secondary.size > 0 &&
    (primary.size === 0 || secondaryTokens[0] === "civico" || primaryContainsOnlyStreetNumber)
  ) {
    return { candidates: secondary, source: "line2" as const, primaryContainsOnlyStreetNumber };
  }
  return {
    candidates: primary,
    source: primary.size > 0 ? ("line1" as const) : ("none" as const),
    primaryContainsOnlyStreetNumber,
  };
}

export function customerStreetNumberCandidates(address: Record<string, unknown>) {
  return addressNumberEvidence(address).candidates;
}

export function customerContainsStructuredStreetNumber(
  address: Record<string, unknown>,
  streetNumber: unknown,
) {
  const expected = compactAddressPart(streetNumber);
  return Boolean(expected && customerStreetNumberCandidates(address).has(expected));
}

export function customerHasConflictingStructuredStreetNumber(
  address: Record<string, unknown>,
  streetNumber: unknown,
) {
  const expected = compactAddressPart(streetNumber);
  return Boolean(
    expected &&
    [...customerStreetNumberCandidates(address)].some((candidate) => candidate !== expected),
  );
}

function civicPattern(candidate: string) {
  const escaped = candidate
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .split("")
    .join("[\\s/-]*");
  return new RegExp(`(?:^|(?<=\\s))${escaped}(?=$|[\\s,;/])`, "iu");
}

/** Separa il civico soltanto quando l'indirizzo contiene una prova strutturata univoca. */
export function splitPostalAddress(value: {
  line1: string;
  line2?: string;
  streetNumber?: string;
  postalCode: string;
}) {
  const explicitStreetNumber = value.streetNumber?.trim();
  const evidence = explicitStreetNumber
    ? {
        candidates: new Set([compactAddressPart(explicitStreetNumber)]),
        source: "line1" as const,
        primaryContainsOnlyStreetNumber: false,
      }
    : addressNumberEvidence(value);
  if (
    evidence.candidates.size !== 1 ||
    (evidence.source === "line1" && evidence.primaryContainsOnlyStreetNumber)
  ) {
    return { line1: value.line1, line2: value.line2 };
  }
  const candidate = [...evidence.candidates][0]!;
  const pattern = civicPattern(candidate);
  if (evidence.source === "line2") {
    const line2 = value.line2?.replace(/^\s*civico\s+/iu, "").trim();
    if (!line2 || compactAddressPart(line2) !== candidate) {
      return { line1: value.line1, line2: value.line2 };
    }
    return { line1: value.line1, streetNumber: line2 };
  }
  const match = pattern.exec(value.line1);
  if (!match) return { line1: value.line1, line2: value.line2 };
  const matchedStreetNumber = match[0].trim();
  const line1 =
    `${value.line1.slice(0, match.index)} ${value.line1.slice(match.index + match[0].length)}`
      .replace(/\s+([,;/])/gu, "$1")
      .replace(/([,;/])\s*$/gu, "")
      .replace(/^\s*([,;/])\s*/gu, "")
      .replace(/\s+/gu, " ")
      .trim();
  return line1
    ? { line1, line2: value.line2, streetNumber: explicitStreetNumber ?? matchedStreetNumber }
    : { line1: value.line1, line2: value.line2 };
}
