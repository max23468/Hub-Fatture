import {
  fatturaPaText,
  fatturaPaUpperAddress,
  fatturaPaUpperText,
  foreignCustomerFallbackTaxCode,
  type DocumentInput,
} from "./documents.ts";
import { isForeignCustomerKind } from "./orders.ts";
import { splitPostalAddress } from "./postal-address.ts";

function joined(values: Array<string | undefined>): string {
  return values.filter(Boolean).join(" · ") || "—";
}

export function recipientIdentity(value: DocumentInput["recipient"]): string {
  return (
    value.businessName ??
    ([value.firstName, value.lastName].filter(Boolean).join(" ") || value.displayName || "—")
  );
}

export function projectedRecipientIdentity(value: DocumentInput["recipient"]): string {
  if (value.businessName) {
    return fatturaPaUpperText(value.businessName, 80);
  }
  if (!value.firstName || !value.lastName) {
    return fatturaPaUpperText(value.displayName!, 80);
  }
  return joined([
    value.firstName ? fatturaPaUpperText(value.firstName, 60) : undefined,
    value.lastName ? fatturaPaUpperText(value.lastName, 60) : undefined,
  ]).replaceAll(" · ", " ");
}

export function recipientAddress(value: DocumentInput["recipient"], projected = false): string {
  const projectedAddress = projected ? splitPostalAddress(value.address) : undefined;
  const street = projectedAddress
    ? joined([
        fatturaPaUpperAddress(projectedAddress.line1, projectedAddress.line2),
        projectedAddress.streetNumber
          ? fatturaPaUpperText(projectedAddress.streetNumber, 8)
          : undefined,
      ])
    : joined([value.address.line1, value.address.line2]);
  return joined([
    street,
    joined([
      projected && value.address.countryCode !== "IT" ? "00000" : value.address.postalCode,
      projected ? fatturaPaText(value.address.city, 60) : value.address.city,
    ]),
    value.address.countryCode === "IT"
      ? projected
        ? value.address.province?.toUpperCase()
        : value.address.province
      : undefined,
    value.address.countryCode,
  ]);
}

export function recipientTaxes(value: DocumentInput["recipient"]): string {
  return joined(
    value.taxIdentifiers.map((identifier) =>
      joined([identifier.type, identifier.countryCode, identifier.value]),
    ),
  );
}

export function projectedRecipientTaxes(value: DocumentInput["recipient"]): string {
  const vat =
    value.taxIdentifiers.find((identifier) => identifier.type === "PARTITA_IVA") ??
    (isForeignCustomerKind(value.kind)
      ? {
          countryCode: value.address.countryCode,
          type: "PARTITA_IVA" as const,
          value: foreignCustomerFallbackTaxCode,
        }
      : undefined);
  const fiscalCode = value.taxIdentifiers.find(
    (identifier) => identifier.type === "CODICE_FISCALE",
  );
  return joined([
    vat
      ? joined(["PARTITA_IVA", vat.countryCode ?? value.address.countryCode, vat.value])
      : undefined,
    fiscalCode ? joined(["CODICE_FISCALE", fiscalCode.value]) : undefined,
  ]);
}

export function recipientComparison(value: DocumentInput["recipient"]) {
  const destinationCode = isForeignCustomerKind(value.kind)
    ? "XXXXXXX"
    : (value.recipientCode ?? "0000000");
  return [
    {
      field: "identity" as const,
      source: recipientIdentity(value),
      draft: recipientIdentity(value),
      projected: projectedRecipientIdentity(value),
    },
    {
      field: "taxes" as const,
      source: recipientTaxes(value),
      draft: recipientTaxes(value),
      projected: projectedRecipientTaxes(value),
    },
    {
      field: "address" as const,
      source: recipientAddress(value),
      draft: recipientAddress(value),
      projected: recipientAddress(value, true),
    },
    {
      field: "delivery" as const,
      source: joined([value.recipientCode, value.certifiedEmail]),
      draft: joined([value.recipientCode, value.certifiedEmail]),
      projected: joined([
        `SdI ${destinationCode}`,
        destinationCode === "0000000" ? value.certifiedEmail : undefined,
      ]),
    },
  ];
}
