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

export const fiscalIdentitySchema = z.object({
  type: z.enum(["CODICE_FISCALE", "PARTITA_IVA", "ALTRO"]),
  countryCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/)
    .nullable(),
  value: z.string().trim().min(1).max(64),
});

export type FiscalIdentity = z.infer<typeof fiscalIdentitySchema>;

export const remoteInventoryDocumentSchema = z.object({
  remoteId: z.string().trim().min(1).max(200),
  documentType: z.enum(["TD01", "TD04"]),
  fiscalYear: z.number().int().min(2000).max(9999),
  series: z.string().trim().min(1).max(64).nullable().default(null),
  fiscalNumber: z.string().trim().min(1).max(64).nullable().default(null),
  documentDate: z.iso.date(),
  recipientName: z.string().trim().max(300).nullable().default(null),
  recipientTaxId: z.string().trim().max(64).nullable().default(null),
  recipientTaxIdentifiers: z.array(fiscalIdentitySchema).max(10).default([]),
  recipientCountryCode: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable()
    .default(null),
  recipientAddress: z.string().trim().max(500).nullable().default(null),
  totalAmount: z.number().int().nonnegative(),
  currency: z.literal("EUR").default("EUR"),
  status: arubaRemoteStatusSchema,
  providerStatusLabel: z.string().trim().min(1).max(300).nullable().optional(),
  providerObservedAt: z.iso.datetime({ offset: true }).nullable().default(null),
  xmlSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .default(null),
  orderReferences: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
});

export const inventoryPageSchema = z
  .object({
    stream: z.string().regex(/^[a-z0-9:_-]{1,100}$/),
    scanOrdinal: z.number().int().positive().max(100_000),
    pageOrdinal: z.number().int().positive().max(100_000),
    cursor: z.string().max(2_000).nullable(),
    terminal: z.boolean(),
    fullScan: z.boolean(),
    documents: z.array(remoteInventoryDocumentSchema).max(300),
  })
  .superRefine((page, context) => {
    const inventoryStream = /^(invoices|credit-notes):(\d{4})$/.exec(page.stream);
    if (!inventoryStream) return;
    const expectedDocumentType = inventoryStream[1] === "invoices" ? "TD01" : "TD04";
    const expectedFiscalYear = Number(inventoryStream[2]);
    for (const [index, document] of page.documents.entries()) {
      if (document.documentType !== expectedDocumentType) {
        context.addIssue({
          code: "custom",
          path: ["documents", index, "documentType"],
          message: "Il tipo documento non appartiene allo stream dichiarato",
        });
      }
      if (document.fiscalYear !== expectedFiscalYear) {
        context.addIssue({
          code: "custom",
          path: ["documents", index, "fiscalYear"],
          message: "L’anno fiscale non appartiene allo stream dichiarato",
        });
      }
    }
  });

export type ArubaRemoteStatus = z.infer<typeof arubaRemoteStatusSchema>;
export type RemoteInventoryDocument = z.infer<typeof remoteInventoryDocumentSchema>;

export const ARUBA_UNKNOWN_STATUS_PAGE_MIN_DOCUMENTS = 10;
export const ARUBA_UNKNOWN_STATUS_PAGE_MAX_RATIO = 0.5;

export function normalizeArubaRemoteStatusLabel(value: unknown): ArubaRemoteStatus {
  const label = normalizedMatchText(String(value ?? "")) ?? "";
  if (
    label.includes("EMESSAENONCONS") ||
    label.includes("NONCONSEGNAT") ||
    label.includes("MANCATACONSEGNA") ||
    label.includes("RECAPITOIMPOSSIBILE")
  ) {
    return "NOT_DELIVERED";
  }
  if (
    label.includes("EMESSAECONSEGNAT") ||
    label.includes("CONSEGNAT") ||
    label === "ACCETTATA" ||
    label.includes("DECORRENZATERMINI")
  ) {
    return "DELIVERED";
  }
  if (
    label.includes("SCARTAT") ||
    label.includes("RIFIUTAT") ||
    label.includes("ERROREELABORAZIONE")
  ) {
    return "REJECTED";
  }
  if (
    label.includes("PRESAINCARICO") ||
    label.includes("INLAVORAZIONE") ||
    label.includes("INOLTRATOASDI") ||
    label.includes("INOLTRATAASDI")
  ) {
    return "SDI_PROCESSING";
  }
  if (label === "EMESSA" || label === "EMESSAEDINVIATA" || label === "ANNULLATA") {
    return "UNKNOWN";
  }
  if (label.includes("INVIAT") || label.includes("TRASMESS")) return "SUBMITTED";
  return "UNKNOWN";
}

export function hasAnomalousUnknownArubaStatuses(
  documents: Array<Pick<RemoteInventoryDocument, "status">>,
): boolean {
  if (documents.length < ARUBA_UNKNOWN_STATUS_PAGE_MIN_DOCUMENTS) return false;
  const unknown = documents.filter((document) => document.status === "UNKNOWN").length;
  return unknown / documents.length >= ARUBA_UNKNOWN_STATUS_PAGE_MAX_RATIO;
}

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
  if (current === "UNKNOWN") return "APPLY";
  if (observed === "UNKNOWN") return "CONFLICT";
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

function canonicalFiscalIdentity(identifier: FiscalIdentity): string {
  const countryCode = identifier.countryCode ?? (identifier.type === "CODICE_FISCALE" ? "IT" : "");
  return `${identifier.type}:${countryCode}:${normalizedMatchText(identifier.value) ?? ""}`;
}

export function remoteMetadataDigest(document: RemoteInventoryDocument): string {
  const {
    recipientTaxIdentifiers: _officialRecipientTaxIdentifiers,
    providerStatusLabel: _providerStatusLabel,
    ...inventoryEvidence
  } = document;
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...inventoryEvidence,
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
  providers?: Array<"SHOPIFY" | "EBAY">;
  displayNumber: string;
  displayNumbers?: string[];
  orderIds?: string[];
  localOrderDate: string;
  billableAmount: number;
  recipientName: string | null;
  recipientTaxIdentifiers: FiscalIdentity[];
  recipientAddress: string | null;
}

export interface CandidateEvaluation {
  candidateId: string;
  orderIds: string[];
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

function daysAfter(documentDate: string, sourceDate: string): number {
  return (
    (Date.parse(`${documentDate}T00:00:00Z`) - Date.parse(`${sourceDate}T00:00:00Z`)) / 86_400_000
  );
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
  const providers = candidate.providers ?? [candidate.provider];
  const provider =
    declaredProviders.size === 0 || providers.some((item) => declaredProviders.has(item));
  const displayNumbers = candidate.displayNumbers ?? [candidate.displayNumber];
  const explicitReference = displayNumbers.some((item) => {
    const normalized = normalizedMatchText(item);
    return Boolean(normalized && references.has(normalized));
  });
  const elapsedDays = daysAfter(remote.documentDate, candidate.localOrderDate);
  const date = elapsedDays >= 0 && elapsedDays <= 31;
  const total = remote.totalAmount === candidate.billableAmount;
  const remoteName = normalizedMatchText(remote.recipientName);
  const recipient = Boolean(
    remoteName && remoteName === normalizedMatchText(candidate.recipientName),
  );
  const remoteTaxIds = remote.recipientTaxIdentifiers.map(canonicalFiscalIdentity);
  const candidateTaxIds = new Set(candidate.recipientTaxIdentifiers.map(canonicalFiscalIdentity));
  const taxId = Boolean(remoteTaxIds.some((remoteTaxId) => candidateTaxIds.has(remoteTaxId)));
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
  const declaredIdentitySignals = [remoteName, remoteTaxIds.length > 0, remoteAddress].filter(
    Boolean,
  ).length;
  const referencedRecipientIsCompatible = remoteTaxIds.length
    ? taxId
    : declaredIdentitySignals === 0 || identitySignals >= 1;
  const inferredRecipientIsCompatible = remoteTaxIds.length
    ? taxId && identitySignals >= 2
    : identitySignals >= 2;
  return {
    candidateId: candidate.id,
    orderIds: candidate.orderIds ?? [candidate.id],
    compatible:
      provider &&
      date &&
      total &&
      ((explicitReference && referencedRecipientIsCompatible) || inferredRecipientIsCompatible),
    signals: { provider, explicitReference, date, total, recipient, taxId, address },
  };
}

export function groupOrderCandidates<
  T extends ArubaOrderCandidate & { billingCaseId?: string | null },
>(candidates: T[]): ArubaOrderCandidate[] {
  const groups = new Map<string, T[]>();
  for (const candidate of candidates) {
    const key = candidate.billingCaseId
      ? `case:${candidate.billingCaseId}`
      : `order:${candidate.id}`;
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  return [...groups.values()].map((items) => {
    const recipientTaxIdentifiers = new Map<string, FiscalIdentity>();
    for (const item of items) {
      for (const identifier of item.recipientTaxIdentifiers) {
        recipientTaxIdentifiers.set(canonicalFiscalIdentity(identifier), identifier);
      }
    }
    return {
      ...items[0]!,
      providers: [...new Set(items.map((item) => item.provider))],
      displayNumbers: items.map((item) => item.displayNumber),
      orderIds: items.map((item) => item.id),
      billableAmount: items.reduce((sum, item) => sum + item.billableAmount, 0),
      localOrderDate: items.map((item) => item.localOrderDate).toSorted()[0]!,
      recipientTaxIdentifiers: [...recipientTaxIdentifiers.values()],
    };
  });
}

export function remoteMatchesPreflightSearches(
  remote: RemoteInventoryDocument,
  searches: Array<{ documentType: "TD01" | "TD04"; amount: number; displayNumber: string }>,
): boolean {
  if (
    remote.status === "REJECTED" ||
    !searches.length ||
    searches.some((search) => search.documentType !== remote.documentType)
  ) {
    return false;
  }
  const references = new Set(remote.orderReferences.map(normalizedMatchText));
  const hasReference = searches.some((search) => {
    const normalized = normalizedMatchText(search.displayNumber);
    return Boolean(normalized && references.has(normalized));
  });
  return hasReference;
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
