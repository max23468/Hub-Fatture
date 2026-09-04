import { createHash } from "node:crypto";

import { z } from "zod";

import { normalizeArubaRemoteStatusLabel, type RemoteInventoryDocument } from "./aruba-inbound.ts";
import { arubaFiscalPayload, arubaFiscalPayloadSha256, validateUntrustedXml } from "./aruba.ts";
import { fiscalDocumentEnvelopesFromXml } from "./documents.ts";
import { decimalToCents } from "./orders.ts";

const base64Schema = z
  .string()
  .min(1)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

interface ArubaApiInboundGroup {
  id: string;
  filename: string;
  invoices: Array<{
    invoiceDate: string;
    number: string;
    documentType: string;
    status: string;
  }>;
}

interface ArubaApiInboundDetail {
  id: string;
  filename: string;
  file: string;
  pdfFile?: string | null;
  lastUpdate: string;
  idSdi?: string | null;
  receiver: {
    description: string;
    countryCode: string | null;
    vatCode?: string | null;
    fiscalCode?: string | null;
  };
  invoices: Array<{
    invoiceDate: string;
    number: string;
    documentType: string;
    status: string;
    totalDocument: string | number;
  }>;
}

interface ArubaApiInboundNotification {
  filename: string;
  invoiceId: string;
  docType: string;
  notificationDate: string;
  number?: string | null;
  result?: "EC01" | "EC02" | null;
  file: string;
}

export interface ArubaApiInboundFile {
  kind: "ARUBA_XML" | "ARUBA_P7M" | "ARUBA_PDF" | "SDI_NOTIFICATION";
  filename: string;
  bytes: Buffer;
  sha256: string;
  providerGroupId: string;
  notificationType?: string;
  notificationDate?: string;
  notificationInvoiceNumber?: string;
}

export interface ArubaApiInboundDocument {
  providerGroupId: string;
  providerFilename: string;
  providerSdiId: string | null;
  remoteLastUpdate: string;
  remoteKey: string;
  remote: RemoteInventoryDocument;
  files: ArubaApiInboundFile[];
  groupFiles: ArubaApiInboundFile[];
}

export function hasRequiredArubaApiFiles(document: ArubaApiInboundDocument): boolean {
  return [...document.files, ...document.groupFiles].some(
    (candidate) => candidate.kind === "ARUBA_XML" || candidate.kind === "ARUBA_P7M",
  );
}

export function arubaApiParityFileHash(file: ArubaApiInboundFile): string {
  return file.kind === "ARUBA_P7M"
    ? arubaFiscalPayloadSha256("ARUBA_P7M", file.bytes)
    : file.sha256;
}

function file(input: {
  kind: ArubaApiInboundFile["kind"];
  filename: string;
  encoded: string;
  providerGroupId: string;
  notificationType?: string;
  notificationDate?: string;
  notificationInvoiceNumber?: string;
}): ArubaApiInboundFile {
  const encoded = base64Schema.safeParse(input.encoded);
  if (!encoded.success) throw new Error("ARUBA_API_FILE_INVALID");
  const bytes = Buffer.from(encoded.data, "base64");
  if (!bytes.byteLength) throw new Error("ARUBA_API_FILE_INVALID");
  return {
    kind: input.kind,
    filename: input.filename,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    providerGroupId: input.providerGroupId,
    notificationType: input.notificationType,
    notificationDate: input.notificationDate,
    notificationInvoiceNumber: input.notificationInvoiceNumber,
  };
}

function cents(value: string | number): number {
  try {
    return Math.abs(
      decimalToCents((typeof value === "number" ? String(value) : value).replace(",", ".")),
    );
  } catch {
    throw new Error("ARUBA_API_AMOUNT_INVALID");
  }
}

function remoteKey(groupId: string, invoice: ArubaApiInboundDetail["invoices"][number]) {
  const suffix = createHash("sha256")
    .update(
      JSON.stringify({
        documentType: invoice.documentType,
        invoiceDate: invoice.invoiceDate,
        number: invoice.number,
      }),
    )
    .digest("hex")
    .slice(0, 20);
  return `${groupId}:${suffix}`;
}

export function mapArubaApiInboundGroup(input: {
  group: ArubaApiInboundGroup;
  detail: ArubaApiInboundDetail;
  notifications: ArubaApiInboundNotification[];
}): ArubaApiInboundDocument[] {
  if (
    input.detail.id !== input.group.id ||
    input.detail.filename !== input.group.filename ||
    input.detail.invoices.length !== input.group.invoices.length ||
    input.notifications.some((notification) => notification.invoiceId !== input.group.id)
  ) {
    throw new Error("ARUBA_API_GROUP_MISMATCH");
  }

  const providerFileKind = input.detail.filename.toLowerCase().endsWith(".p7m")
    ? "ARUBA_P7M"
    : input.detail.filename.toLowerCase().endsWith(".xml")
      ? "ARUBA_XML"
      : null;
  if (!providerFileKind) throw new Error("ARUBA_API_FILE_INVALID");
  const sharedFiles: ArubaApiInboundFile[] = [
    file({
      kind: providerFileKind,
      filename: input.detail.filename,
      encoded: input.detail.file,
      providerGroupId: input.group.id,
    }),
    ...(input.detail.pdfFile
      ? [
          file({
            kind: "ARUBA_PDF" as const,
            filename: `${input.detail.filename}.pdf`,
            encoded: input.detail.pdfFile,
            providerGroupId: input.group.id,
          }),
        ]
      : []),
  ];
  const officialFile = sharedFiles.find(
    (candidate): candidate is ArubaApiInboundFile & { kind: "ARUBA_XML" | "ARUBA_P7M" } =>
      candidate.kind === "ARUBA_XML" || candidate.kind === "ARUBA_P7M",
  );
  if (!officialFile) throw new Error("ARUBA_API_FILE_INVALID");
  const fiscalIdentities = fiscalDocumentEnvelopesFromXml(
    validateUntrustedXml(arubaFiscalPayload(officialFile.kind, officialFile.bytes)),
    { allowUnknownNumber: true },
  );
  const notificationFiles = input.notifications.map((notification) => {
    const number = notification.number?.trim() || null;
    const matchingIndexes = input.detail.invoices.flatMap((invoice, index) =>
      number === null
        ? input.detail.invoices.length === 1
          ? [index]
          : []
        : invoice.number === number
          ? [index]
          : [],
    );
    if (matchingIndexes.length !== 1) throw new Error("ARUBA_API_GROUP_MISMATCH");
    return {
      invoiceIndex: matchingIndexes[0]!,
      file: file({
        kind: "SDI_NOTIFICATION",
        filename: notification.filename,
        encoded: notification.file,
        providerGroupId: input.group.id,
        notificationType: notification.docType,
        notificationDate: notification.notificationDate,
        notificationInvoiceNumber: number ?? undefined,
      }),
    };
  });

  return input.detail.invoices.flatMap((invoice, index) => {
    const summary = input.group.invoices[index];
    if (
      !summary ||
      invoice.invoiceDate !== summary.invoiceDate ||
      invoice.number !== summary.number ||
      invoice.documentType !== summary.documentType ||
      invoice.status !== summary.status
    ) {
      throw new Error("ARUBA_API_GROUP_MISMATCH");
    }
    if (invoice.documentType !== "TD01" && invoice.documentType !== "TD04") return [];
    const documentDate = invoice.invoiceDate.slice(0, 10);
    const totalAmount = cents(invoice.totalDocument);
    const matchingFiscalIdentities = fiscalIdentities.filter(
      (identity) =>
        identity.type === invoice.documentType &&
        identity.documentDate === documentDate &&
        identity.totalAmount === totalAmount,
    );
    if (matchingFiscalIdentities.length !== 1) throw new Error("ARUBA_API_GROUP_MISMATCH");
    const fiscalIdentity = matchingFiscalIdentities[0]!;
    const key = remoteKey(input.group.id, invoice);
    const taxIdentifiers = [
      ...(input.detail.receiver.vatCode
        ? [
            {
              type: "PARTITA_IVA" as const,
              countryCode: input.detail.receiver.countryCode,
              value: input.detail.receiver.vatCode,
            },
          ]
        : []),
      ...(input.detail.receiver.fiscalCode
        ? [
            {
              type: "CODICE_FISCALE" as const,
              countryCode: input.detail.receiver.countryCode,
              value: input.detail.receiver.fiscalCode,
            },
          ]
        : []),
    ];
    // Aruba restituisce i file principali a livello di gruppo. Nei gruppi multipli li conserviamo
    // come evidenza condivisa senza attribuirli arbitrariamente a una singola fattura.
    const singleDocumentGroup = input.detail.invoices.length === 1;
    const attributableSharedFiles = singleDocumentGroup ? sharedFiles : [];
    const officialPayload = attributableSharedFiles.find(
      (candidate) => candidate.kind === "ARUBA_XML" || candidate.kind === "ARUBA_P7M",
    );
    return [
      {
        providerGroupId: input.group.id,
        providerFilename: input.detail.filename,
        providerSdiId: input.detail.idSdi ?? null,
        remoteLastUpdate: input.detail.lastUpdate,
        remoteKey: key,
        remote: {
          remoteId: key,
          documentType: invoice.documentType,
          fiscalYear: Number(documentDate.slice(0, 4)),
          series: fiscalIdentity.series,
          fiscalNumber: fiscalIdentity.fiscalNumber,
          documentDate,
          recipientName: input.detail.receiver.description,
          recipientTaxId: input.detail.receiver.fiscalCode ?? input.detail.receiver.vatCode ?? null,
          recipientTaxIdentifiers: taxIdentifiers,
          recipientCountryCode: input.detail.receiver.countryCode,
          recipientAddress: null,
          totalAmount,
          currency: "EUR" as const,
          status: normalizeArubaRemoteStatusLabel(invoice.status),
          providerStatusLabel: invoice.status,
          providerInvoiceNumber: invoice.number,
          providerObservedAt: input.detail.lastUpdate,
          xmlSha256: officialPayload ? arubaApiParityFileHash(officialPayload) : null,
          orderReferences: [],
        },
        files: [
          ...attributableSharedFiles,
          ...notificationFiles.reduce<ArubaApiInboundFile[]>((files, notification) => {
            if (notification.invoiceIndex === index) files.push(notification.file);
            return files;
          }, []),
        ],
        groupFiles: singleDocumentGroup ? [] : sharedFiles,
      },
    ];
  });
}
