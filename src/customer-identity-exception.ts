import { createHash } from "node:crypto";

import { proposeItalianPrivateNameException } from "./italian-fiscal-code.ts";
import type { OrderInput } from "./orders.ts";

export interface CustomerIdentityExceptionProposal {
  provider: "EBAY";
  externalCustomerId: string;
  sourceIdentitySha256: string;
  firstName: string;
  lastName: string;
  basis: "FISCAL_CODE" | "SOURCE_ORDER";
}

export function customerIdentityExceptionProposal(
  input: OrderInput,
): CustomerIdentityExceptionProposal | null {
  if (
    input.provider !== "EBAY" ||
    !input.externalCustomerId ||
    input.customer.kind !== "PRIVATE_IT" ||
    input.customer.companyName ||
    !input.customer.displayName
  ) {
    return null;
  }
  const fiscalCodes = input.customer.taxIdentifiers.filter(
    (identifier) => identifier.type === "CODICE_FISCALE" && identifier.countryCode === "IT",
  );
  if (fiscalCodes.length !== 1) return null;
  const fiscalCode = fiscalCodes[0]!.value;
  const name = proposeItalianPrivateNameException(input.customer.displayName, fiscalCode);
  if (!name) return null;
  const sourceIdentitySha256 = createHash("sha256")
    .update(
      JSON.stringify({
        provider: input.provider,
        externalCustomerId: input.externalCustomerId,
        displayName: input.customer.displayName.normalize("NFKC").trim(),
        fiscalCode: fiscalCode
          .normalize("NFKC")
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, ""),
      }),
    )
    .digest("hex");
  return {
    provider: "EBAY",
    externalCustomerId: input.externalCustomerId,
    sourceIdentitySha256,
    ...name,
  };
}

export function applyCustomerIdentityException(
  input: OrderInput,
  exception: {
    sourceIdentitySha256: string;
    firstName: string;
    lastName: string;
  } | null,
): OrderInput {
  if (!exception) return input;
  const proposal = customerIdentityExceptionProposal(input);
  if (!proposal || proposal.sourceIdentitySha256 !== exception.sourceIdentitySha256) return input;
  return {
    ...input,
    customer: {
      ...input.customer,
      firstName: exception.firstName,
      lastName: exception.lastName,
    },
  };
}

export function automaticCustomerIdentityException(input: OrderInput): {
  input: OrderInput;
  proposal: CustomerIdentityExceptionProposal | null;
} {
  const proposal = customerIdentityExceptionProposal(input);
  if (!proposal) return { input, proposal: null };
  const aligned = applyCustomerIdentityException(input, proposal);
  return { input: aligned, proposal };
}
