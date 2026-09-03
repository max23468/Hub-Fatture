import { createHash } from "node:crypto";

import { activateFiscalProfile } from "../db/documents.server.ts";
import { fiscalProfileFromAcceptedInvoiceXml } from "../documents.ts";
import { AppError } from "../errors.ts";
import { validateFatturaXml } from "../fatturapa.server.ts";

export const FISCAL_PROFILE_XML_MAX_BYTES = 4_900_000;

interface FiscalProfileActor {
  id: number;
  canApprove: boolean;
  requestId: string;
}

function acceptedXml(value: Uint8Array): string {
  if (value.byteLength === 0) throw new AppError("FISCAL_PROFILE_SOURCE_INVALID", 422);
  if (value.byteLength > FISCAL_PROFILE_XML_MAX_BYTES) {
    throw new AppError("REQUEST_BODY_TOO_LARGE", 413);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new AppError("FISCAL_PROFILE_SOURCE_INVALID", 422);
  }
}

function isValidatorUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === "Validatore FatturaPA non disponibile" ||
      error.message === "Validazione FatturaPA scaduta")
  );
}

export async function activateFiscalProfileFromAcceptedXml(
  input: {
    profileXml: Uint8Array;
    latestDocumentXml?: Uint8Array;
    expectedVersion: number;
  },
  actor: FiscalProfileActor,
) {
  const profileXml = acceptedXml(input.profileXml);
  const latestDocumentXml = input.latestDocumentXml
    ? acceptedXml(input.latestDocumentXml)
    : profileXml;

  try {
    await validateFatturaXml(profileXml);
    if (latestDocumentXml !== profileXml) await validateFatturaXml(latestDocumentXml);
    const profile = fiscalProfileFromAcceptedInvoiceXml(
      profileXml,
      new Date().toISOString(),
      latestDocumentXml,
    );
    return await activateFiscalProfile(
      profile,
      createHash("sha256").update(profileXml).digest("hex"),
      input.expectedVersion,
      actor,
    );
  } catch (error) {
    if (error instanceof AppError || isValidatorUnavailable(error)) throw error;
    throw new AppError("FISCAL_PROFILE_SOURCE_INVALID", 422);
  }
}
