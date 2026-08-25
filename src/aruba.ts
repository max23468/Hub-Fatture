import { createHash } from "node:crypto";

import { create } from "xmlbuilder2";
import { z } from "zod";

export { ARUBA_IMPORT_MAX_BYTES, ARUBA_PANEL_ORIGIN } from "./aruba-browser-constants.ts";
import { ARUBA_IMPORT_MAX_BYTES, ARUBA_PANEL_ORIGIN } from "./aruba-browser-constants.ts";

export const ARUBA_UPLOAD_MAX_BYTES = 4_900_000;
export const ARUBA_UPLOAD_MAX_BATCH_BYTES = 30_000_000;
export const ARUBA_LOGIN_ORIGIN = "https://loginfatturazione.aruba.it";

export const arubaModeSchema = z.enum(["ASSISTED", "AUTOMATIC"]);
export const arubaEnvironmentSchema = z.enum(["MOCK", "PRODUCTION"]);

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

export const arubaManifestSchema = z
  .object({
    batchId: z.uuid(),
    environment: arubaEnvironmentSchema,
    mode: arubaModeSchema,
    operation: z.enum(["UPLOAD", "READBACK"]),
    accountReference: z.string().trim().min(1).max(200),
    manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
    attemptNumber: z.number().int().positive(),
    panelUrl: z.url(),
    documents: z.array(arubaManifestDocumentSchema).min(1).max(300),
  })
  .superRefine((value, context) => {
    if (
      value.operation === "UPLOAD" &&
      value.documents.reduce((total, document) => total + document.sizeBytes, 0) >
        ARUBA_UPLOAD_MAX_BATCH_BYTES
    ) {
      context.addIssue({
        code: "custom",
        message: "Il caricamento Aruba supera 30 MB",
        path: ["documents"],
      });
    }
  });

export type ArubaMode = z.infer<typeof arubaModeSchema>;
export type ArubaEnvironment = z.infer<typeof arubaEnvironmentSchema>;
export type ArubaManifest = z.infer<typeof arubaManifestSchema>;
export type ArubaManifestDocument = z.infer<typeof arubaManifestDocumentSchema>;

export function effectiveArubaMode(
  configured: ArubaMode,
  environment: ArubaEnvironment,
  submissionEnabled: boolean,
): ArubaMode {
  return environment === "PRODUCTION" && !submissionEnabled ? "ASSISTED" : configured;
}

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
  if (target.username || target.password) throw new Error("target");
  if (environment === "PRODUCTION") {
    if (
      target.origin !== ARUBA_PANEL_ORIGIN ||
      target.protocol !== "https:" ||
      target.searchParams.size
    ) {
      throw new Error("target");
    }
    return target;
  }
  if (
    target.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "::1"].includes(target.hostname) ||
    target.pathname !== "/aruba-sintetica" ||
    (target.search !== "" && target.search !== "?scenario=inventory")
  ) {
    throw new Error("target");
  }
  return target;
}

export function assertAllowedArubaNavigation(url: string, target: URL): URL {
  const candidate = new URL(url);
  if (candidate.username || candidate.password || candidate.origin !== target.origin) {
    throw new Error("target");
  }
  return candidate;
}

export function assertAllowedArubaAuthenticationNavigation(url: string, target: URL): URL {
  const candidate = new URL(url);
  if (candidate.username || candidate.password) throw new Error("target");
  if (candidate.origin === target.origin) return candidate;
  if (target.origin === ARUBA_PANEL_ORIGIN && candidate.origin === ARUBA_LOGIN_ORIGIN) {
    return candidate;
  }
  throw new Error("target");
}

export function assertAllowedArubaDownload(url: string, target: URL): URL {
  const candidate = new URL(url);
  if (candidate.protocol === "data:") return candidate;
  return assertAllowedArubaNavigation(url, target);
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
  z.object({ type: z.literal("HELPER_HEARTBEAT") }),
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
    const tail = bytes.subarray(Math.max(0, bytes.byteLength - 2048)).toString("latin1");
    if (
      !bytes.subarray(0, 5).equals(Buffer.from("%PDF-")) ||
      !tail.includes("startxref") ||
      !tail.includes("%%EOF")
    ) {
      throw new Error("pdf");
    }
    return;
  }
  if (kind === "ARUBA_P7M") {
    validateSignedDataDer(bytes);
    return;
  }
  validateUntrustedXml(bytes);
}

const SIGNED_DATA_OID = Buffer.from([
  0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02,
]);
const DATA_OID = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01]);

function derElement(bytes: Buffer, offset: number, limit: number, depth = 0) {
  if (depth > 64) throw new Error("p7m");
  if (offset + 2 > limit) throw new Error("p7m");
  const tag = bytes[offset]!;
  const firstLength = bytes[offset + 1]!;
  if ((tag & 0x1f) === 0x1f) throw new Error("p7m");
  if (firstLength === 0x80) {
    if (!(tag & 0x20)) throw new Error("p7m");
    const contentStart = offset + 2;
    let cursor = contentStart;
    let elements = 0;
    while (cursor + 2 <= limit && (bytes[cursor] !== 0 || bytes[cursor + 1] !== 0)) {
      const child = derElement(bytes, cursor, limit, depth + 1);
      cursor = child.end;
      elements += 1;
      if (elements > 20_000) throw new Error("p7m");
    }
    if (cursor + 2 > limit) throw new Error("p7m");
    return { tag, contentStart, contentEnd: cursor, end: cursor + 2 };
  }
  let headerBytes = 2;
  let length = firstLength;
  if (firstLength & 0x80) {
    const lengthBytes = firstLength & 0x7f;
    if (lengthBytes > 4 || offset + 2 + lengthBytes > limit) throw new Error("p7m");
    length = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      length = length * 256 + bytes[offset + 2 + index]!;
    }
    if (length < 128) throw new Error("p7m");
    headerBytes += lengthBytes;
  }
  const contentStart = offset + headerBytes;
  const end = contentStart + length;
  if (end > limit) throw new Error("p7m");
  return { tag, contentStart, contentEnd: end, end };
}

function validateSignedDataDer(bytes: Buffer): void {
  const root = derElement(bytes, 0, bytes.byteLength);
  if (root.tag !== 0x30 || root.end !== bytes.byteLength) throw new Error("p7m");
  const children = (start: number, end: number) => {
    const result: Array<ReturnType<typeof derElement> & { start: number }> = [];
    let offset = start;
    while (offset < end) {
      const element = derElement(bytes, offset, end);
      result.push({ ...element, start: offset });
      offset = element.end;
    }
    if (offset !== end) throw new Error("p7m");
    return result;
  };
  const contentInfo = children(root.contentStart, root.contentEnd);
  if (
    contentInfo.length !== 2 ||
    !bytes.subarray(contentInfo[0]!.start, contentInfo[0]!.end).equals(SIGNED_DATA_OID) ||
    contentInfo[1]!.tag !== 0xa0
  ) {
    throw new Error("p7m");
  }
  const explicitContent = children(contentInfo[1]!.contentStart, contentInfo[1]!.contentEnd);
  if (explicitContent.length !== 1 || explicitContent[0]!.tag !== 0x30) throw new Error("p7m");
  const signedDataFields = children(
    explicitContent[0]!.contentStart,
    explicitContent[0]!.contentEnd,
  );
  if (
    signedDataFields.length < 4 ||
    signedDataFields[0]!.tag !== 0x02 ||
    signedDataFields[1]!.tag !== 0x31 ||
    signedDataFields[2]!.tag !== 0x30 ||
    signedDataFields.at(-1)!.tag !== 0x31
  ) {
    throw new Error("p7m");
  }
  const encapsulatedContent = children(
    signedDataFields[2]!.contentStart,
    signedDataFields[2]!.contentEnd,
  );
  if (
    !encapsulatedContent.length ||
    !bytes.subarray(encapsulatedContent[0]!.start, encapsulatedContent[0]!.end).equals(DATA_OID)
  ) {
    throw new Error("p7m");
  }
  let elements = 0;
  const visit = (start: number, end: number, depth: number) => {
    if (depth > 64) throw new Error("p7m");
    let offset = start;
    while (offset < end) {
      const element = derElement(bytes, offset, end);
      elements += 1;
      if (elements > 20_000) throw new Error("p7m");
      if (element.tag & 0x20) visit(element.contentStart, element.contentEnd, depth + 1);
      offset = element.end;
    }
    if (offset !== end) throw new Error("p7m");
  };
  visit(root.contentStart, root.contentEnd, 1);
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

export function notificationBelongsToDocument(
  xml: string,
  expected: { filename?: string | null; remoteId?: string | null },
): boolean {
  const filenames = [...xml.matchAll(/<(?:\w+:)?NomeFile>([^<]{1,255})<\//gi)].map((match) =>
    match[1]!
      .trim()
      .replace(/\\/g, "/")
      .split("/")
      .at(-1)!
      .replace(/\.p7m$/i, "")
      .toLowerCase(),
  );
  const remoteIds = [
    ...xml.matchAll(/<(?:\w+:)?(?:IdentificativoSdI|IdSdI)>([^<]{1,200})<\//gi),
  ].map((match) => match[1]!.trim());
  const expectedFilename = expected.filename?.toLowerCase() ?? null;
  const filenameMatches = Boolean(expectedFilename && filenames.includes(expectedFilename));
  const remoteIdMatches = Boolean(expected.remoteId && remoteIds.includes(expected.remoteId));
  return (
    (filenameMatches || remoteIdMatches) &&
    (!expectedFilename || filenames.length === 0 || filenameMatches) &&
    (!expected.remoteId || remoteIds.length === 0 || remoteIdMatches)
  );
}

export const verifiedArubaPanelContract = {
  limits: {
    fileBytes: ARUBA_UPLOAD_MAX_BYTES,
    batchBytes: ARUBA_UPLOAD_MAX_BATCH_BYTES,
    files: 300,
  },
  upload: ["SELEZIONA DOCUMENTI", "Carica fattura"],
  validationErrors: ["DETTAGLI ERRORI", "errori"],
  finalSend: ["INVIA TUTTE", "INVIA"],
  remove: ["SVUOTA PAGINA", "ELIMINA"],
  forbiddenDraft: ["SALVA IN BOZZE"],
} as const;
