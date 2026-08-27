import { createHash } from "node:crypto";

import { z } from "zod";

import { normalizeArubaRemoteStatusLabel, type RemoteInventoryDocument } from "./aruba-inbound.ts";
import { decimalToCents } from "./orders.ts";

const base64Schema = z
  .string()
  .min(1)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

export interface ArubaApiInboundGroup {
  id: string;
  filename: string;
  invoices: Array<{
    invoiceDate: string;
    number: string;
    documentType: string;
    status: string;
  }>;
}

export interface ArubaApiInboundDetail {
  id: string;
  filename: string;
  file: string;
  pdfFile?: string | null;
  lastUpdate: string;
  receiver: {
    description: string;
    countryCode: string;
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

export interface ArubaApiInboundNotification {
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
}

export interface ArubaApiInboundDocument {
  providerGroupId: string;
  remoteKey: string;
  remote: RemoteInventoryDocument;
  files: ArubaApiInboundFile[];
}

function file(input: {
  kind: ArubaApiInboundFile["kind"];
  filename: string;
  encoded: string;
  providerGroupId: string;
  notificationType?: string;
  notificationDate?: string;
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
  };
}

function cents(value: string | number): number {
  try {
    return decimalToCents((typeof value === "number" ? String(value) : value).replace(",", "."));
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
    const officialXml = sharedFiles.find((candidate) => candidate.kind === "ARUBA_XML");
    return [
      {
        providerGroupId: input.group.id,
        remoteKey: key,
        remote: {
          remoteId: key,
          documentType: invoice.documentType,
          fiscalYear: Number(documentDate.slice(0, 4)),
          series: null,
          fiscalNumber: null,
          documentDate,
          recipientName: input.detail.receiver.description,
          recipientTaxId: input.detail.receiver.fiscalCode ?? input.detail.receiver.vatCode ?? null,
          recipientTaxIdentifiers: taxIdentifiers,
          recipientCountryCode: input.detail.receiver.countryCode,
          recipientAddress: null,
          totalAmount: cents(invoice.totalDocument),
          currency: "EUR" as const,
          status: normalizeArubaRemoteStatusLabel(invoice.status),
          providerStatusLabel: invoice.status,
          providerObservedAt: input.detail.lastUpdate,
          xmlSha256: officialXml?.sha256 ?? null,
          orderReferences: [],
        },
        files: [
          ...sharedFiles,
          ...notificationFiles.reduce<ArubaApiInboundFile[]>((files, notification) => {
            if (notification.invoiceIndex === index) files.push(notification.file);
            return files;
          }, []),
        ],
      },
    ];
  });
}
