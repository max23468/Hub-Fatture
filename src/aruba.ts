import { createHash } from "node:crypto";

import { create } from "xmlbuilder2";
import { z } from "zod";

export const ARUBA_UPLOAD_MAX_BYTES = 4_900_000;
export const ARUBA_IMPORT_MAX_BYTES = 10 * 1024 * 1024;
export const ARUBA_PANEL_ORIGIN = "https://fatturazioneelettronica.aruba.it";

export const arubaModeSchema = z.enum(["ASSISTED", "AUTOMATIC"]);
export const arubaEnvironmentSchema = z.enum(["MOCK", "PRODUCTION"]);
export const arubaAuthProtectionSchema = z.enum(["UNKNOWN", "TWO_FACTOR", "SMS_PER_UPLOAD"]);

export const arubaManifestDocumentSchema = z.object({
  id: z.string().regex(/^\d+$/),
  revision: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  filename: z.string().regex(/^[A-Za-z0-9._-]+\.xml$/),
  sizeBytes: z.number().int().positive().max(ARUBA_UPLOAD_MAX_BYTES),
  fiscalNumber: z.string().min(1).max(64),
  documentDate: z.iso.date(),
  totalAmount: z.number().int().nonnegative(),
});

export const arubaManifestSchema = z.object({
  batchId: z.uuid(),
  environment: arubaEnvironmentSchema,
  mode: arubaModeSchema,
  operation: z.enum(["UPLOAD", "READBACK"]),
  accountReference: z.string().trim().min(1).max(200),
  manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
  attemptNumber: z.number().int().positive(),
  panelUrl: z.url(),
  documents: z.array(arubaManifestDocumentSchema).min(1).max(300),
});

export type ArubaMode = z.infer<typeof arubaModeSchema>;
export type ArubaEnvironment = z.infer<typeof arubaEnvironmentSchema>;
export type ArubaManifest = z.infer<typeof arubaManifestSchema>;
export type ArubaManifestDocument = z.infer<typeof arubaManifestDocumentSchema>;

export function manifestSha256(
  value: Pick<
    ArubaManifest,
    "batchId" | "environment" | "mode" | "accountReference" | "attemptNumber" | "documents"
  >,
): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function assertAllowedArubaTarget(url: string, environment: ArubaEnvironment): URL {
  const target = new URL(url);
  if (target.username || target.password || target.searchParams.size) throw new Error("target");
  if (environment === "PRODUCTION") {
    if (target.origin !== ARUBA_PANEL_ORIGIN || target.protocol !== "https:") {
      throw new Error("target");
    }
    return target;
  }
  if (
    target.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "::1"].includes(target.hostname) ||
    target.pathname !== "/aruba-sintetica"
  ) {
    throw new Error("target");
  }
  return target;
}

export function assertAllowedHubUrl(url: string): URL {
  const target = new URL(url);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(target.hostname);
  if (
    target.username ||
    target.password ||
    target.search ||
    (target.protocol !== "https:" && !(loopback && target.protocol === "http:"))
  ) {
    throw new Error("hub");
  }
  return target;
}

export const helperEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("HELPER_STARTED"),
    browser: z.enum(["chrome", "msedge", "chromium"]),
  }),
  z.object({
    type: z.literal("VALIDATION"),
    documents: z
      .array(
        z.object({
          id: z.string().regex(/^\d+$/),
          status: z.enum(["VALID", "INVALID"]),
          message: z.string().trim().max(500).optional(),
        }),
      )
      .min(1)
      .max(300),
  }),
  z.object({ type: z.literal("ASSISTED_STOP") }),
  z.object({ type: z.literal("SUBMITTED"), remoteIds: z.record(z.string(), z.string().max(200)) }),
  z.object({
    type: z.literal("RECONCILIATION_REQUIRED"),
    reason: z.enum(["BROWSER_CLOSED", "NAVIGATION", "UNKNOWN_RESULT", "DOM_UNRECOGNIZED"]),
  }),
  z.object({
    type: z.literal("READBACK"),
    documents: z
      .array(
        z.object({
          id: z.string().regex(/^\d+$/),
          status: z.enum([
            "UPLOADED",
            "SUBMITTED",
            "DELIVERED",
            "NOT_DELIVERED",
            "REJECTED",
            "REMOVED",
            "NOT_FOUND",
          ]),
          remoteId: z.string().trim().max(200).optional(),
        }),
      )
      .min(1)
      .max(300),
  }),
]);

export type HelperEvent = z.infer<typeof helperEventSchema>;

export const arubaFileKindSchema = z.enum([
  "ARUBA_XML",
  "ARUBA_P7M",
  "ARUBA_PDF",
  "SDI_NOTIFICATION",
]);
export type ArubaFileKind = z.infer<typeof arubaFileKindSchema>;

export function validateOfficialFile(kind: ArubaFileKind, bytes: Buffer): void {
  if (!bytes.byteLength || bytes.byteLength > ARUBA_IMPORT_MAX_BYTES) throw new Error("size");
  if (kind === "ARUBA_PDF") {
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("pdf");
    return;
  }
  if (kind === "ARUBA_P7M") {
    if (bytes[0] !== 0x30) throw new Error("p7m");
    return;
  }
  validateUntrustedXml(bytes);
}

export function validateUntrustedXml(bytes: Buffer): string {
  if (bytes.byteLength > ARUBA_UPLOAD_MAX_BYTES) throw new Error("size");
  const xml = bytes.toString("utf8");
  if (xml.includes("\u0000") || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("xml");
  let depth = 0;
  let elements = 0;
  for (const match of xml.matchAll(/<\/?([A-Za-z_][\w:.-]*)(?:\s[^<>]*?)?\s*\/?>/g)) {
    const tag = match[0];
    if (tag.startsWith("</")) depth -= 1;
    else {
      elements += 1;
      if (!tag.endsWith("/>")) depth += 1;
    }
    if (depth < 0 || depth > 64 || elements > 20_000) throw new Error("xml");
  }
  if (depth !== 0 || elements === 0) throw new Error("xml");
  create(xml).end({ format: "object" });
  return xml;
}

export function notificationStatus(
  xml: string,
): "SDI_PROCESSING" | "DELIVERED" | "NOT_DELIVERED" | "REJECTED" {
  if (/<(?:\w+:)?NotificaScarto\b/i.test(xml) || /<Esito\b[^>]*status="REJECTED"/i.test(xml)) {
    return "REJECTED";
  }
  if (
    /<(?:\w+:)?NotificaMancataConsegna\b/i.test(xml) ||
    /<Esito\b[^>]*status="NOT_DELIVERED"/i.test(xml)
  ) {
    return "NOT_DELIVERED";
  }
  if (/<(?:\w+:)?RicevutaConsegna\b/i.test(xml) || /<Esito\b[^>]*status="DELIVERED"/i.test(xml)) {
    return "DELIVERED";
  }
  return "SDI_PROCESSING";
}

// Contratto candidato: la prova Aruba finale sostituisce questi nomi con il DOM osservato.
export const candidateArubaLocators = {
  upload: ["Seleziona documenti", "Carica fattura", "Carica fatture"],
  validationErrors: ["Dettagli errori", "errori"],
  finalSend: ["Invia", "Invia tutte"],
  remove: ["Rimuovi", "Elimina"],
  forbiddenDraft: ["Salva in bozze"],
} as const;
