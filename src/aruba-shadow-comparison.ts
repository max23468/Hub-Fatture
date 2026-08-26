import { z } from "zod";

import { arubaRemoteStatusSchema, remoteInventoryDocumentSchema } from "./aruba-inbound.ts";
import { AppError } from "./errors.ts";

export const arubaShadowDocumentSchema = z
  .object({
    remoteId: z.string().trim().min(1).max(200).nullable().default(null),
    documentType: z.enum(["TD01", "TD04"]),
    fiscalYear: z.number().int().min(2000).max(9999),
    series: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/[\p{L}\p{N}]/u)
      .nullable()
      .default(null),
    fiscalNumber: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/[\p{L}\p{N}]/u)
      .nullable()
      .default(null),
    documentDate: z.iso.date(),
    status: arubaRemoteStatusSchema,
  })
  .superRefine((document, context) => {
    const completeFiscalIdentity = document.series !== null && document.fiscalNumber !== null;
    const partialFiscalIdentity = (document.series === null) !== (document.fiscalNumber === null);
    if (partialFiscalIdentity) {
      context.addIssue({
        code: "custom",
        path: [document.series === null ? "series" : "fiscalNumber"],
        message: "L’identità fiscale shadow deve essere completa",
      });
    }
    if (!document.remoteId && !completeFiscalIdentity) {
      context.addIssue({
        code: "custom",
        path: ["remoteId"],
        message: "Il documento shadow non ha una chiave di correlazione",
      });
    }
  });

export type ArubaShadowDocument = z.infer<typeof arubaShadowDocumentSchema>;

const arubaShadowSnapshotSchema = z.object({
  environment: z.enum(["DEMO", "PRODUCTION"]),
  accountReference: z.string().trim().min(1).max(200),
  populationKey: z.string().trim().min(1).max(200),
  remoteIdNamespace: z.string().trim().min(1).max(100).nullable(),
  documents: z.array(arubaShadowDocumentSchema).max(300),
});

export type ArubaShadowSnapshot = z.infer<typeof arubaShadowSnapshotSchema>;

export function fallbackInventoryToShadowDocuments(value: unknown): ArubaShadowDocument[] {
  const result = z.array(remoteInventoryDocumentSchema).max(300).safeParse(value);
  if (!result.success) throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  return result.data.map((document) => ({
    remoteId: document.remoteId,
    documentType: document.documentType,
    fiscalYear: document.fiscalYear,
    series: document.series,
    fiscalNumber: document.fiscalNumber,
    documentDate: document.documentDate,
    status: document.status,
  }));
}

export interface ArubaShadowComparisonResult {
  status: "PARITY" | "DIVERGED" | "AMBIGUOUS";
  apiDocuments: number;
  fallbackDocuments: number;
  matchedDocuments: number;
  matchedByRemoteId: number;
  matchedByFiscalIdentity: number;
  alignedStatuses: number;
  divergentStatuses: number;
  apiOnly: number;
  fallbackOnly: number;
  ambiguousApiDocuments: number;
  ambiguousFallbackDocuments: number;
  invariantConflicts: number;
}

function normalizedIdentityPart(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toUpperCase();
}

function fiscalIdentity(document: ArubaShadowDocument): string | null {
  if (document.series === null || document.fiscalNumber === null) return null;
  return [
    document.documentType,
    document.fiscalYear,
    normalizedIdentityPart(document.series),
    normalizedIdentityPart(document.fiscalNumber),
  ].join(":");
}

function immutableIdentityAgrees(left: ArubaShadowDocument, right: ArubaShadowDocument): boolean {
  const leftFiscalIdentity = fiscalIdentity(left);
  const rightFiscalIdentity = fiscalIdentity(right);
  return (
    left.documentType === right.documentType &&
    left.fiscalYear === right.fiscalYear &&
    left.documentDate === right.documentDate &&
    (!leftFiscalIdentity || !rightFiscalIdentity || leftFiscalIdentity === rightFiscalIdentity)
  );
}

function parsedSnapshot(value: unknown): ArubaShadowSnapshot {
  const result = arubaShadowSnapshotSchema.safeParse(value);
  if (!result.success) throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  return result.data;
}

export function compareArubaShadowInventories(input: {
  api: unknown;
  fallback: unknown;
}): ArubaShadowComparisonResult {
  const apiSnapshot = parsedSnapshot(input.api);
  const fallbackSnapshot = parsedSnapshot(input.fallback);
  if (
    apiSnapshot.environment !== fallbackSnapshot.environment ||
    apiSnapshot.accountReference !== fallbackSnapshot.accountReference ||
    apiSnapshot.populationKey !== fallbackSnapshot.populationKey
  ) {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  }
  const sharedRemoteIdNamespace = Boolean(
    apiSnapshot.remoteIdNamespace &&
    apiSnapshot.remoteIdNamespace === fallbackSnapshot.remoteIdNamespace,
  );
  const api = apiSnapshot.documents;
  const fallback = fallbackSnapshot.documents;
  const candidatesByApi = api.map(() => new Set<number>());
  const candidatesByFallback = fallback.map(() => new Set<number>());
  const invariantConflicts = new Set<string>();

  for (const [apiIndex, apiDocument] of api.entries()) {
    const apiFiscalIdentity = fiscalIdentity(apiDocument);
    for (const [fallbackIndex, fallbackDocument] of fallback.entries()) {
      const sameRemoteId = Boolean(
        sharedRemoteIdNamespace &&
        apiDocument.remoteId &&
        apiDocument.remoteId === fallbackDocument.remoteId,
      );
      const sameFiscalIdentity = Boolean(
        apiFiscalIdentity && apiFiscalIdentity === fiscalIdentity(fallbackDocument),
      );
      if (!sameRemoteId && !sameFiscalIdentity) continue;
      if (!immutableIdentityAgrees(apiDocument, fallbackDocument)) {
        invariantConflicts.add(`${apiIndex}:${fallbackIndex}`);
        continue;
      }
      candidatesByApi[apiIndex]!.add(fallbackIndex);
      candidatesByFallback[fallbackIndex]!.add(apiIndex);
    }
  }

  let matchedDocuments = 0;
  let matchedByRemoteId = 0;
  let matchedByFiscalIdentity = 0;
  let alignedStatuses = 0;
  let divergentStatuses = 0;
  const matchedApi = new Set<number>();
  const matchedFallback = new Set<number>();

  for (const [apiIndex, candidates] of candidatesByApi.entries()) {
    if (candidates.size !== 1) continue;
    const fallbackIndex = [...candidates][0]!;
    if (candidatesByFallback[fallbackIndex]!.size !== 1) continue;
    const apiDocument = api[apiIndex]!;
    const fallbackDocument = fallback[fallbackIndex]!;
    matchedApi.add(apiIndex);
    matchedFallback.add(fallbackIndex);
    matchedDocuments += 1;
    if (
      sharedRemoteIdNamespace &&
      apiDocument.remoteId &&
      apiDocument.remoteId === fallbackDocument.remoteId
    ) {
      matchedByRemoteId += 1;
    } else {
      matchedByFiscalIdentity += 1;
    }
    if (apiDocument.status === fallbackDocument.status) alignedStatuses += 1;
    else divergentStatuses += 1;
  }

  const ambiguousApiDocuments = candidatesByApi.filter(
    (candidates, index) =>
      !matchedApi.has(index) &&
      (candidates.size > 1 ||
        [...candidates].some((fallbackIndex) => candidatesByFallback[fallbackIndex]!.size > 1)),
  ).length;
  const ambiguousFallbackDocuments = candidatesByFallback.filter(
    (candidates, index) =>
      !matchedFallback.has(index) &&
      (candidates.size > 1 ||
        [...candidates].some((apiIndex) => candidatesByApi[apiIndex]!.size > 1)),
  ).length;
  const apiOnly = candidatesByApi.filter(
    (candidates, index) => !matchedApi.has(index) && candidates.size === 0,
  ).length;
  const fallbackOnly = candidatesByFallback.filter(
    (candidates, index) => !matchedFallback.has(index) && candidates.size === 0,
  ).length;
  const status =
    ambiguousApiDocuments > 0 || ambiguousFallbackDocuments > 0
      ? "AMBIGUOUS"
      : matchedDocuments === api.length &&
          matchedDocuments === fallback.length &&
          divergentStatuses === 0 &&
          invariantConflicts.size === 0
        ? "PARITY"
        : "DIVERGED";

  return {
    status,
    apiDocuments: api.length,
    fallbackDocuments: fallback.length,
    matchedDocuments,
    matchedByRemoteId,
    matchedByFiscalIdentity,
    alignedStatuses,
    divergentStatuses,
    apiOnly,
    fallbackOnly,
    ambiguousApiDocuments,
    ambiguousFallbackDocuments,
    invariantConflicts: invariantConflicts.size,
  };
}
