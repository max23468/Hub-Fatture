export interface ArubaInboundParityDocument {
  documentType: string;
  fiscalYear: number;
  series: string | null;
  fiscalNumber: string | null;
  documentDate: string;
  totalAmount: number;
  remoteStatus: string;
  fileHashes: string[];
}

export interface ArubaInboundParityResult {
  status: "MATCHED" | "DIVERGENT";
  apiDocuments: number;
  browserDocuments: number;
  matchedDocuments: number;
  missingInApi: number;
  missingInBrowser: number;
  statusMismatches: number;
  fileMismatches: number;
}

function normalized(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toUpperCase();
}

function fiscalIdentity(document: ArubaInboundParityDocument): string | null {
  if (!document.series || !document.fiscalNumber) return null;
  return [
    document.documentType,
    document.fiscalYear,
    normalized(document.series),
    normalized(document.fiscalNumber),
  ].join(":");
}

function immutableInvariantsAgree(
  api: ArubaInboundParityDocument,
  browser: ArubaInboundParityDocument,
): boolean {
  const apiFiscalIdentity = fiscalIdentity(api);
  const browserFiscalIdentity = fiscalIdentity(browser);
  return (
    api.documentType === browser.documentType &&
    api.fiscalYear === browser.fiscalYear &&
    api.documentDate === browser.documentDate &&
    api.totalAmount === browser.totalAmount &&
    (!apiFiscalIdentity || !browserFiscalIdentity || apiFiscalIdentity === browserFiscalIdentity)
  );
}

function correlates(api: ArubaInboundParityDocument, browser: ArubaInboundParityDocument): boolean {
  const apiFiscalIdentity = fiscalIdentity(api);
  const browserFiscalIdentity = fiscalIdentity(browser);
  const browserHashes = new Set(browser.fileHashes);
  return Boolean(
    (apiFiscalIdentity && apiFiscalIdentity === browserFiscalIdentity) ||
    api.fileHashes.some((hash) => browserHashes.has(hash)),
  );
}

export function compareArubaInboundParity(input: {
  api: ArubaInboundParityDocument[];
  browser: ArubaInboundParityDocument[];
}): ArubaInboundParityResult {
  const candidatesByApi = input.api.map(() => new Set<number>());
  const candidatesByBrowser = input.browser.map(() => new Set<number>());
  for (const [apiIndex, apiDocument] of input.api.entries()) {
    for (const [browserIndex, browserDocument] of input.browser.entries()) {
      if (
        !correlates(apiDocument, browserDocument) ||
        !immutableInvariantsAgree(apiDocument, browserDocument)
      ) {
        continue;
      }
      candidatesByApi[apiIndex]!.add(browserIndex);
      candidatesByBrowser[browserIndex]!.add(apiIndex);
    }
  }

  let matchedDocuments = 0;
  let statusMismatches = 0;
  let fileMismatches = 0;
  const matchedApi = new Set<number>();
  const matchedBrowser = new Set<number>();
  for (const [apiIndex, candidates] of candidatesByApi.entries()) {
    if (candidates.size !== 1) continue;
    const browserIndex = candidates.values().next().value as number;
    if (candidatesByBrowser[browserIndex]!.size !== 1) continue;
    const apiDocument = input.api[apiIndex]!;
    const browserDocument = input.browser[browserIndex]!;
    matchedApi.add(apiIndex);
    matchedBrowser.add(browserIndex);
    matchedDocuments += 1;
    if (apiDocument.remoteStatus !== browserDocument.remoteStatus) statusMismatches += 1;
    const apiHashes = [...new Set(apiDocument.fileHashes)].toSorted();
    const browserHashes = [...new Set(browserDocument.fileHashes)].toSorted();
    if (
      apiHashes.length !== browserHashes.length ||
      apiHashes.some((hash, index) => hash !== browserHashes[index])
    ) {
      fileMismatches += 1;
    }
  }

  const missingInApi = input.browser.length - matchedBrowser.size;
  const missingInBrowser = input.api.length - matchedApi.size;
  return {
    status:
      missingInApi || missingInBrowser || statusMismatches || fileMismatches
        ? "DIVERGENT"
        : "MATCHED",
    apiDocuments: input.api.length,
    browserDocuments: input.browser.length,
    matchedDocuments,
    missingInApi,
    missingInBrowser,
    statusMismatches,
    fileMismatches,
  };
}
