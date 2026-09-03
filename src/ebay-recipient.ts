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
