import { createHash } from "node:crypto";

import { z } from "zod";

export const arubaRemoteStatusSchema = z.enum([
  "SUBMITTED",
  "SDI_PROCESSING",
  "DELIVERED",
  "NOT_DELIVERED",
  "REJECTED",
  "UNKNOWN",
]);

export const arubaMatchStatusSchema = z.enum([
  "MATCHED",
  "UNMATCHED",
  "AMBIGUOUS",
  "PROFILE_CONFLICT",
  "ERROR",
  "UNKNOWN_REMOTE_STATE",
]);

export const remoteInventoryDocumentSchema = z.object({
  remoteId: z.string().trim().min(1).max(200),
  documentType: z.enum(["TD01", "TD04"]),
  fiscalYear: z.number().int().min(2000).max(9999),
  series: z.string().trim().min(1).max(64).nullable().default(null),
  fiscalNumber: z.string().trim().min(1).max(64).nullable().default(null),
  documentDate: z.iso.date(),
  recipientName: z.string().trim().max(300).nullable().default(null),
  recipientTaxId: z.string().trim().max(64).nullable().default(null),
  recipientCountryCode: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable()
    .default(null),
  recipientAddress: z.string().trim().max(500).nullable().default(null),
  totalAmount: z.number().int().nonnegative(),
  currency: z.literal("EUR").default("EUR"),
  status: arubaRemoteStatusSchema,
  providerObservedAt: z.iso.datetime({ offset: true }).nullable().default(null),
  xmlSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .default(null),
  orderReferences: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
});

export const inventoryPageSchema = z.object({
  stream: z.string().regex(/^[a-z0-9:_-]{1,100}$/),
  scanOrdinal: z.number().int().positive().max(100_000),
  pageOrdinal: z.number().int().positive().max(100_000),
  cursor: z.string().max(2_000).nullable(),
  terminal: z.boolean(),
  fullScan: z.boolean(),
  documents: z.array(remoteInventoryDocumentSchema).max(300),
});

export type ArubaRemoteStatus = z.infer<typeof arubaRemoteStatusSchema>;
export type RemoteInventoryDocument = z.infer<typeof remoteInventoryDocumentSchema>;

const progressing = new Map<ArubaRemoteStatus, number>([
  ["SUBMITTED", 1],
  ["SDI_PROCESSING", 2],
]);
const terminal = new Set<ArubaRemoteStatus>(["DELIVERED", "NOT_DELIVERED", "REJECTED"]);

export function remoteStatusTransition(
  current: ArubaRemoteStatus | null,
  observed: ArubaRemoteStatus,
): "APPLY" | "IGNORE_STALE" | "CONFLICT" {
  if (!current || current === observed) return "APPLY";
  if (current === "UNKNOWN" || observed === "UNKNOWN") return "CONFLICT";
  if (terminal.has(current)) return terminal.has(observed) ? "CONFLICT" : "IGNORE_STALE";
  if (terminal.has(observed)) return "APPLY";
  return (progressing.get(observed) ?? 0) >= (progressing.get(current) ?? 0)
    ? "APPLY"
    : "IGNORE_STALE";
}

export function normalizedMatchText(value: string | null | undefined): string | null {
  const normalized = value
    ?.normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
  return normalized || null;
}

export function remoteMetadataDigest(document: RemoteInventoryDocument): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...document,
        recipientName: normalizedMatchText(document.recipientName),
        recipientTaxId: normalizedMatchText(document.recipientTaxId),
        recipientAddress: normalizedMatchText(document.recipientAddress),
        orderReferences: document.orderReferences.toSorted(),
      }),
    )
    .digest("hex");
}

export interface ArubaOrderCandidate {
  id: string;
  provider: "SHOPIFY" | "EBAY";
  displayNumber: string;
  localOrderDate: string;
  billableAmount: number;
  recipientName: string | null;
  recipientTaxIds: string[];
  recipientAddress: string | null;
}

export interface CandidateEvaluation {
  candidateId: string;
  compatible: boolean;
  signals: {
    provider: boolean;
    explicitReference: boolean;
    date: boolean;
    total: boolean;
    recipient: boolean;
    taxId: boolean;
    address: boolean;
  };
}

function daysBetween(left: string, right: string): number {
  return Math.abs(Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) / 86_400_000;
}

export function evaluateOrderCandidate(
  remote: RemoteInventoryDocument,
  candidate: ArubaOrderCandidate,
): CandidateEvaluation {
  const references = new Set(remote.orderReferences.map(normalizedMatchText));
  const declaredProviders = new Set(
    [...references].flatMap((reference) =>
      reference?.includes("SHOPIFY") ? ["SHOPIFY"] : reference?.includes("EBAY") ? ["EBAY"] : [],
    ),
  );
  const provider = declaredProviders.size === 0 || declaredProviders.has(candidate.provider);
  const displayNumber = normalizedMatchText(candidate.displayNumber);
  const explicitReference = Boolean(displayNumber && references.has(displayNumber));
  const date = daysBetween(remote.documentDate, candidate.localOrderDate) <= 31;
  const total = remote.totalAmount === candidate.billableAmount;
  const remoteName = normalizedMatchText(remote.recipientName);
  const recipient = Boolean(
    remoteName && remoteName === normalizedMatchText(candidate.recipientName),
  );
  const remoteTaxId = normalizedMatchText(remote.recipientTaxId);
  const taxId = Boolean(
    remoteTaxId && candidate.recipientTaxIds.map(normalizedMatchText).includes(remoteTaxId),
  );
  const remoteAddress = normalizedMatchText(remote.recipientAddress);
  const candidateAddress = normalizedMatchText(candidate.recipientAddress);
  const address = Boolean(
    remoteAddress &&
    candidateAddress &&
    (remoteAddress === candidateAddress ||
      remoteAddress.includes(candidateAddress) ||
      candidateAddress.includes(remoteAddress)),
  );
  const identitySignals = [recipient, taxId, address].filter(Boolean).length;
  return {
    candidateId: candidate.id,
    compatible: provider && date && total && (explicitReference || identitySignals >= 2),
    signals: { provider, explicitReference, date, total, recipient, taxId, address },
  };
}

export function selectOrderMatch(
  remote: RemoteInventoryDocument,
  candidates: ArubaOrderCandidate[],
): { status: "MATCHED" | "UNMATCHED" | "AMBIGUOUS"; evaluations: CandidateEvaluation[] } {
  const evaluations = candidates.map((candidate) => evaluateOrderCandidate(remote, candidate));
  const compatible = evaluations.filter((candidate) => candidate.compatible);
  return {
    status: compatible.length === 1 ? "MATCHED" : compatible.length ? "AMBIGUOUS" : "UNMATCHED",
    evaluations,
  };
}

export function isEmissionConfirmed(status: ArubaRemoteStatus): boolean {
  return status === "DELIVERED" || status === "NOT_DELIVERED";
}
