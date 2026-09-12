import { proposeItalianPrivateNameException } from "./italian-fiscal-code.ts";

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Separa un riferimento di consegna `c/o` dal nome eBay senza perdere Indirizzo 2. */
export function splitEbayCareOfRecipient(fullNameValue: unknown, addressLine2Value: unknown) {
  const fullName = text(fullNameValue);
  const existingLine2 = text(addressLine2Value);
  if (!fullName) return { fullName, addressLine2: existingLine2, careOf: null };

  const match = /^(.*?)\s+(c\s*\/\s*o(?:\s+.+))$/iu.exec(fullName);
  if (!match?.[1]?.trim() || !match[2]) {
    return { fullName, addressLine2: existingLine2, careOf: null };
  }

  const careOfLine = match[2]
    .replace(/^c\s*\/\s*o/iu, "c/o")
    .replace(/\s+/g, " ")
    .trim();
  const recipientName = match[1].trim();
  return {
    fullName: recipientName,
    addressLine2: [existingLine2, careOfLine].filter(Boolean).join(" · "),
    careOf: {
      originalName: fullName,
      recipientName,
      previousLine2: existingLine2,
      currentLine2: [existingLine2, careOfLine].filter(Boolean).join(" · "),
    },
  };
}

/**
 * Il nome di spedizione eBay può essere un'etichetta commerciale o di consegna. Per un privato
 * italiano il nome registrato dall'acquirente diventa l'intestazione soltanto quando il codice
 * fiscale lo conferma e non riconosce alcuna porzione del nome di spedizione.
 */
export function ebayFiscalRegistrationName(
  shippingName: string | undefined,
  registrationNameValue: unknown,
  fiscalCode: string,
): { displayName: string; firstName: string; lastName: string } | null {
  const registrationName = text(registrationNameValue);
  if (!shippingName || !registrationName) return null;
  if (proposeItalianPrivateNameException(shippingName, fiscalCode)?.basis === "FISCAL_CODE") {
    return null;
  }
  const registered = proposeItalianPrivateNameException(registrationName, fiscalCode);
  if (registered?.basis !== "FISCAL_CODE") return null;
  return {
    displayName: `${registered.firstName} ${registered.lastName}`,
    firstName: registered.firstName,
    lastName: registered.lastName,
  };
}
