const ODD_FISCAL_CODE_VALUES: Record<string, number> = {
  0: 1,
  1: 0,
  2: 5,
  3: 7,
  4: 9,
  5: 13,
  6: 15,
  7: 17,
  8: 19,
  9: 21,
  A: 1,
  B: 0,
  C: 5,
  D: 7,
  E: 9,
  F: 13,
  G: 15,
  H: 17,
  I: 19,
  J: 21,
  K: 2,
  L: 4,
  M: 18,
  N: 20,
  O: 11,
  P: 3,
  Q: 6,
  R: 8,
  S: 12,
  T: 14,
  U: 16,
  V: 10,
  W: 22,
  X: 25,
  Y: 24,
  Z: 23,
};

function normalizedFiscalCode(value: string): string {
  return value
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function hasValidItalianFiscalCodeChecksum(value: string): boolean {
  const fiscalCode = normalizedFiscalCode(value);
  if (!/^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]$/.test(fiscalCode)) return false;
  let total = 0;
  for (let index = 0; index < 15; index += 1) {
    const character = fiscalCode[index]!;
    total +=
      index % 2 === 0
        ? ODD_FISCAL_CODE_VALUES[character]!
        : /^\d$/.test(character)
          ? Number(character)
          : character.charCodeAt(0) - 65;
  }
  return String.fromCharCode(65 + (total % 26)) === fiscalCode[15];
}

function normalizedNameLetters(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
}

function surnameCode(value: string): string {
  const letters = normalizedNameLetters(value);
  const consonants = [...letters].filter((letter) => !"AEIOU".includes(letter));
  const vowels = [...letters].filter((letter) => "AEIOU".includes(letter));
  return [...consonants, ...vowels, "X", "X", "X"].slice(0, 3).join("");
}

function firstNameCode(value: string): string {
  const letters = normalizedNameLetters(value);
  const consonants = [...letters].filter((letter) => !"AEIOU".includes(letter));
  if (consonants.length >= 4) {
    return [consonants[0], consonants[2], consonants[3]].join("");
  }
  const vowels = [...letters].filter((letter) => "AEIOU".includes(letter));
  return [...consonants, ...vowels, "X", "X", "X"].slice(0, 3).join("");
}

function uniqueNameCandidates(
  parts: string[],
  fiscalCode: string,
): Array<{ firstName: string; lastName: string }> {
  const candidates = new Map<string, { firstName: string; lastName: string }>();
  for (let start = 0; start < parts.length - 1; start += 1) {
    for (let end = start + 2; end <= parts.length; end += 1) {
      const candidateParts = parts.slice(start, end);
      for (let split = 1; split < candidateParts.length; split += 1) {
        const left = candidateParts.slice(0, split).join(" ");
        const right = candidateParts.slice(split).join(" ");
        const orientations = [
          { firstName: right, lastName: left },
          { firstName: left, lastName: right },
        ];
        for (const candidate of orientations) {
          if (
            `${surnameCode(candidate.lastName)}${firstNameCode(candidate.firstName)}` ===
            fiscalCode.slice(0, 6)
          ) {
            candidates.set(
              `${normalizedNameLetters(candidate.firstName)}:${normalizedNameLetters(candidate.lastName)}`,
              candidate,
            );
          }
        }
      }
    }
  }
  return [...candidates.values()];
}

export function splitTwoPartNameUsingFiscalCode(
  fullName: string,
  fiscalCodeValue: string,
): { firstName: string; lastName: string } | null {
  const parts = fullName.normalize("NFKC").trim().split(/\s+/u).filter(Boolean);
  const fiscalCode = normalizedFiscalCode(fiscalCodeValue);
  if (parts.length !== 2 || !hasValidItalianFiscalCodeChecksum(fiscalCode)) return null;

  const [left, right] = parts as [string, string];
  const leftIsSurname = `${surnameCode(left)}${firstNameCode(right)}` === fiscalCode.slice(0, 6);
  const rightIsSurname = `${surnameCode(right)}${firstNameCode(left)}` === fiscalCode.slice(0, 6);
  if (leftIsSurname === rightIsSurname) return null;
  return leftIsSurname
    ? { firstName: right, lastName: left }
    : { firstName: left, lastName: right };
}

export interface ItalianPrivateNameExceptionProposal {
  firstName: string;
  lastName: string;
  basis: "FISCAL_CODE" | "SOURCE_ORDER";
}

/**
 * Prepara l’intestazione dichiarata dal cliente. Prima cerca una sola porzione del nome
 * controverificata dal CF, così può ignorare etichette del marketplace. Se il CF e il nome
 * restano discordanti conserva l’ordine naturale nome-cognome della sorgente.
 */
export function proposeItalianPrivateNameException(
  fullName: string,
  fiscalCodeValue: string,
): ItalianPrivateNameExceptionProposal | null {
  const parts = fullName.normalize("NFKC").trim().split(/\s+/u).filter(Boolean);
  const fiscalCode = normalizedFiscalCode(fiscalCodeValue);
  if (parts.length < 2 || !hasValidItalianFiscalCodeChecksum(fiscalCode)) return null;

  const fiscalCandidates = uniqueNameCandidates(parts, fiscalCode);
  if (fiscalCandidates.length === 1) {
    return { ...fiscalCandidates[0]!, basis: "FISCAL_CODE" };
  }
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts.at(-1)!,
    basis: "SOURCE_ORDER",
  };
}
