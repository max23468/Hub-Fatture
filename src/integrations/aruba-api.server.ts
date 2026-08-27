import { z } from "zod";

import {
  arubaRemoteStatusSchema,
  normalizeArubaRemoteStatusLabel,
  type ArubaRemoteStatus,
} from "../aruba-inbound.ts";
import { ARUBA_IMPORT_MAX_BYTES } from "../aruba-browser-constants.ts";
import { AppError } from "../errors.ts";
import type { ArubaShadowDocument } from "../aruba-shadow-comparison.ts";
import { providerJson } from "./provider-http.server.ts";

export type ArubaApiEnvironment = "DEMO" | "PRODUCTION";

const endpoints: Record<ArubaApiEnvironment, { auth: string; services: string }> = {
  DEMO: {
    auth: "https://demoauth.fatturazioneelettronica.aruba.it",
    services: "https://demows.fatturazioneelettronica.aruba.it",
  },
  PRODUCTION: {
    auth: "https://auth.fatturazioneelettronica.aruba.it",
    services: "https://ws.fatturazioneelettronica.aruba.it",
  },
};

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.coerce.number().int().positive(),
});

const userInfoSchema = z.object({
  username: z.string().min(1),
  vatCode: z.string().nullish(),
  fiscalCode: z.string().nullish(),
  accountStatus: z.object({
    expired: z.boolean(),
    expirationDate: z.string().nullish(),
  }),
});

const PROBE_PAGE_SIZE = 10;
const PROBE_MAX_PAGES = 2;
const MAX_BASE64_FILE_CHARS = Math.ceil(ARUBA_IMPORT_MAX_BYTES / 3) * 4;
const base64FileSchema = z
  .string()
  .min(1)
  .max(MAX_BASE64_FILE_CHARS)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const providerDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/);

export const ARUBA_API_V2_CONTRACT = {
  authenticationRequestsPerMinutePerIp: 1,
  sentInvoiceSearchRequestsPerMinutePerIp: 12,
  sentNotificationSearchRequestsPerMinutePerIp: 12,
  maximumSearchWindowHours: 48,
  maximumPageSize: 100,
  documentedInvoiceStatuses: [
    "Presa in carico",
    "Errore elaborazione",
    "Inviata",
    "Scartata",
    "Non consegnata",
    "Recapito impossibile",
    "Consegnata",
    "Accettata",
    "Rifiutata",
    "Decorrenza termini",
  ],
  officialFiles: {
    invoiceDetail: ["ARUBA_XML_OR_P7M", "ARUBA_PDF"],
    invoiceZip: ["ARUBA_INVOICE_WITH_NOTIFICATIONS_ZIP"],
    preservationPackage: ["ARUBA_PDD_ZIP"],
    notifications: ["SDI_NOTIFICATION"],
  },
} as const;

const arubaApiInvoiceStatusSchema = z.enum(ARUBA_API_V2_CONTRACT.documentedInvoiceStatuses);

const invoiceSummarySchema = z.object({
  invoiceDate: z.iso.datetime({ offset: true }),
  number: z.string().trim().min(1).max(100),
  documentType: z
    .string()
    .trim()
    .regex(/^TD\d{2}$/),
  status: arubaApiInvoiceStatusSchema,
  statusDescription: z.string().max(2_000).nullish(),
});

const invoiceGroupSchema = z.object({
  id: z.string().trim().min(1).max(200),
  invoices: z.array(invoiceSummarySchema).max(100),
  invoiceType: z.string().trim().min(1).max(32),
  docType: z.literal("out"),
  filename: z.string().trim().min(1).max(255),
  idSdi: z.string().trim().min(1).max(200).nullish(),
  pddAvailable: z.boolean(),
  file: z.null().optional(),
});

const providerDecimalSchema = z.union([
  z.number().finite(),
  z
    .string()
    .trim()
    .regex(/^-?\d+(?:[.,]\d+)?$/),
]);

const detailedInvoiceSummarySchema = invoiceSummarySchema.extend({
  totalDocument: providerDecimalSchema,
  totalVat: providerDecimalSchema,
  netPayable: providerDecimalSchema,
});

const companySchema = z.object({
  description: z.string().trim().min(1).max(300),
  countryCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/),
  vatCode: z.string().trim().max(64).nullish(),
  fiscalCode: z.string().trim().max(64).nullish(),
});

export const arubaApiInvoiceDetailSchema = z.object({
  channelGroup: z.number().int().nonnegative(),
  shopName: z.string().trim().max(300).nullish(),
  invoices: z.array(detailedInvoiceSummarySchema).min(1).max(100),
  sdiErrors: z.array(z.unknown()).max(100),
  id: z.string().trim().min(1).max(200),
  sender: companySchema,
  receiver: companySchema,
  invoiceType: z.string().trim().min(1).max(32),
  docType: z.literal("out"),
  file: base64FileSchema,
  filename: z.string().trim().min(1).max(255),
  username: z.string().trim().min(1).max(200),
  creationDate: providerDateTimeSchema,
  lastUpdate: providerDateTimeSchema,
  idSdi: z.string().trim().min(1).max(200).nullish(),
  pdfFile: base64FileSchema.nullish(),
  pddAvailable: z.boolean(),
});

export function arubaApiGroupsToShadowDocuments(value: unknown): ArubaShadowDocument[] {
  const result = z.array(invoiceGroupSchema).max(100).safeParse(value);
  if (!result.success) throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  return result.data.flatMap((group) =>
    group.invoices.flatMap((invoice) => {
      if (invoice.documentType !== "TD01" && invoice.documentType !== "TD04") return [];
      const documentDate = invoice.invoiceDate.slice(0, 10);
      return [
        {
          remoteId: group.id,
          documentType: invoice.documentType,
          fiscalYear: Number(documentDate.slice(0, 4)),
          series: null,
          fiscalNumber: null,
          documentDate,
          status: normalizeArubaRemoteStatusLabel(invoice.status),
        },
      ];
    }),
  );
}

export const arubaApiNotificationListSchema = z
  .object({
    count: z.number().int().nonnegative(),
    notifications: z
      .array(
        z.object({
          date: z.string().trim().min(1).max(64),
          docType: z.string().trim().min(1).max(32),
          filename: z.string().trim().min(1).max(255),
          invoiceId: z.string().trim().min(1).max(200),
          notificationDate: z.string().trim().min(1).max(64),
          number: z.string().trim().max(100).nullish(),
          result: z.enum(["EC01", "EC02"]).nullish(),
          file: base64FileSchema,
        }),
      )
      .max(100),
  })
  .superRefine((value, context) => {
    if (value.count !== value.notifications.length) {
      context.addIssue({
        code: "custom",
        path: ["count"],
        message: "Il conteggio notifiche Aruba non coincide con gli elementi restituiti",
      });
    }
  });

const invoiceSearchSchema = z.object({
  content: z.array(invoiceGroupSchema).max(PROBE_PAGE_SIZE),
  first: z.boolean(),
  last: z.boolean(),
  number: z.number().int().positive(),
  numberOfElements: z.number().int().nonnegative(),
  size: z.number().int().positive(),
  totalElements: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
});

export type ArubaApiInvoiceGroup = z.infer<typeof invoiceGroupSchema>;
export type ArubaApiInvoiceDetail = z.infer<typeof arubaApiInvoiceDetailSchema>;
export type ArubaApiNotificationList = z.infer<typeof arubaApiNotificationListSchema>;

export interface ArubaApiCredentials {
  username: string;
  password: string;
  expectedTaxId: string;
}

export interface ArubaApiSession {
  environment: ArubaApiEnvironment;
  accessToken: string;
  expiresAt: number;
}

export interface ArubaApiInvoicePage {
  groups: ArubaApiInvoiceGroup[];
  page: number;
  size: number;
  totalGroups: number;
  totalPages: number;
  terminal: boolean;
}

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  return result.data;
}

function taxIdentity(value: string | null | undefined): string | null {
  const normalized = (value ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const withoutCountry = /^IT\d{11}$/.test(normalized) ? normalized.slice(2) : normalized;
  return /^\d{11}$/.test(withoutCountry) || /^[A-Z0-9]{16}$/.test(withoutCountry)
    ? withoutCountry
    : null;
}

function bearer(token: string): HeadersInit {
  return { Accept: "application/json", Authorization: `Bearer ${token}` };
}

export async function authenticateArubaApi(input: {
  environment: ArubaApiEnvironment;
  credentials: ArubaApiCredentials;
  now?: number;
}): Promise<ArubaApiSession> {
  const target = endpoints[input.environment];
  const credentials = z
    .object({
      username: z.string().trim().min(1).max(200),
      password: z.string().min(1).max(500),
      expectedTaxId: z.string().trim().min(1).max(64),
    })
    .safeParse(input.credentials);
  if (!credentials.success) throw new AppError("AUTH_INVALID_CREDENTIALS", 422);
  const token = parsed(
    tokenSchema,
    await providerJson(`${target.auth}/auth/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({
        grant_type: "password",
        username: credentials.data.username,
        password: credentials.data.password,
      }),
    }),
  );
  const userInfo = parsed(
    userInfoSchema,
    await providerJson(`${target.auth}/auth/userInfo`, { headers: bearer(token.access_token) }),
  );
  const expectedTaxId = taxIdentity(credentials.data.expectedTaxId);
  const observedTaxIds = new Set([taxIdentity(userInfo.vatCode), taxIdentity(userInfo.fiscalCode)]);
  if (!expectedTaxId || !observedTaxIds.has(expectedTaxId)) {
    throw new AppError("AUTH_PROVIDER_ACCOUNT_MISMATCH", 409);
  }
  if (userInfo.accountStatus.expired) throw new AppError("AUTH_PROVIDER_EXPIRED", 401);
  return {
    environment: input.environment,
    accessToken: token.access_token,
    expiresAt: (input.now ?? Date.now()) + token.expires_in * 1_000,
  };
}

export async function readArubaApiInvoicePage(input: {
  session: ArubaApiSession;
  page: number;
  windowStart: Date;
  windowEnd: Date;
  documentType?: "TD01" | "TD04";
}): Promise<ArubaApiInvoicePage> {
  const page = z.number().int().positive().safeParse(input.page);
  const windowHours = (input.windowEnd.getTime() - input.windowStart.getTime()) / 3_600_000;
  if (!page.success || windowHours <= 0 || windowHours > 48) {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 422);
  }
  const target = endpoints[input.session.environment];
  const url = new URL("/api/v2/invoices-out", target.services);
  url.search = new URLSearchParams({
    page: String(page.data),
    size: String(PROBE_PAGE_SIZE),
    creationStartDate: input.windowStart.toISOString(),
    creationEndDate: input.windowEnd.toISOString(),
    ...(input.documentType ? { documentType: input.documentType } : {}),
  }).toString();
  const result = parsed(
    invoiceSearchSchema,
    await providerJson(url.toString(), { headers: bearer(input.session.accessToken) }),
  );
  const expectedElements = Math.min(
    PROBE_PAGE_SIZE,
    Math.max(0, result.totalElements - (page.data - 1) * PROBE_PAGE_SIZE),
  );
  const groupIds = result.content.map((group) => group.id);
  if (
    result.number !== page.data ||
    result.size !== PROBE_PAGE_SIZE ||
    result.first !== (page.data === 1) ||
    result.last !== (result.totalPages === 0 || page.data === result.totalPages) ||
    result.numberOfElements !== result.content.length ||
    result.numberOfElements !== expectedElements ||
    result.totalPages !== Math.ceil(result.totalElements / PROBE_PAGE_SIZE) ||
    new Set(groupIds).size !== groupIds.length
  ) {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  }
  return {
    groups: result.content,
    page: result.number,
    size: result.size,
    totalGroups: result.totalElements,
    totalPages: result.totalPages,
    terminal: result.last,
  };
}

export async function readArubaApiInvoiceDetail(
  session: ArubaApiSession,
  groupId: string,
): Promise<ArubaApiInvoiceDetail> {
  const id = z.string().trim().min(1).max(200).safeParse(groupId);
  if (!id.success) throw new AppError("PROVIDER_RESPONSE_INVALID", 422);
  const url = new URL("/api/v2/invoices-out/detail", endpoints[session.environment].services);
  url.search = new URLSearchParams({
    id: id.data,
    includePdf: "true",
    includeFile: "true",
  }).toString();
  const detail = parsed(
    arubaApiInvoiceDetailSchema,
    await providerJson(
      url.toString(),
      { headers: bearer(session.accessToken) },
      { maxBytes: 32 * 1024 * 1024, timeoutMs: 20_000 },
    ),
  );
  if (detail.id !== id.data) throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  return detail;
}

export async function readArubaApiNotifications(
  session: ArubaApiSession,
  groupId: string,
): Promise<ArubaApiNotificationList> {
  const id = z.string().trim().min(1).max(200).safeParse(groupId);
  if (!id.success) throw new AppError("PROVIDER_RESPONSE_INVALID", 422);
  const url = new URL(
    "/api/v2/invoices-out/notifications",
    endpoints[session.environment].services,
  );
  url.search = new URLSearchParams({ id: id.data }).toString();
  const notifications = parsed(
    arubaApiNotificationListSchema,
    await providerJson(
      url.toString(),
      { headers: bearer(session.accessToken) },
      { maxBytes: 16 * 1024 * 1024, timeoutMs: 20_000 },
    ),
  );
  if (notifications.notifications.some((notification) => notification.invoiceId !== id.data)) {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  }
  return notifications;
}

export interface ArubaApiReadProbeInput {
  environment: ArubaApiEnvironment;
  username: string;
  password: string;
  expectedTaxId: string;
  now?: Date;
}

export interface ArubaApiReadProbeResult {
  status: "ok";
  environment: ArubaApiEnvironment;
  accountVerified: true;
  accountExpired: false;
  outboundReadAuthorized: true;
  requestedPages: number;
  returnedInvoiceGroups: number;
  returnedDocuments: number;
  totalInvoiceGroups: number;
  groupCardinality: { empty: number; single: number; multiple: number };
  documentTypes: { TD01: number; TD04: number; other: number };
  canonicalStatuses: Record<ArubaRemoteStatus, number>;
  completeWindowRead: boolean;
  windowStart: string;
  windowEnd: string;
}

interface SanitizedInventorySummary {
  returnedDocuments: number;
  groupCardinality: ArubaApiReadProbeResult["groupCardinality"];
  documentTypes: ArubaApiReadProbeResult["documentTypes"];
  canonicalStatuses: ArubaApiReadProbeResult["canonicalStatuses"];
}

function emptyInventorySummary(): SanitizedInventorySummary {
  return {
    returnedDocuments: 0,
    groupCardinality: { empty: 0, single: 0, multiple: 0 },
    documentTypes: { TD01: 0, TD04: 0, other: 0 },
    canonicalStatuses: Object.fromEntries(
      arubaRemoteStatusSchema.options.map((status) => [status, 0]),
    ) as Record<ArubaRemoteStatus, number>,
  };
}

function addGroupsToSummary(
  summary: SanitizedInventorySummary,
  groups: z.infer<typeof invoiceGroupSchema>[],
): void {
  for (const group of groups) {
    const cardinality =
      group.invoices.length === 0 ? "empty" : group.invoices.length === 1 ? "single" : "multiple";
    summary.groupCardinality[cardinality] += 1;
    summary.returnedDocuments += group.invoices.length;
    for (const invoice of group.invoices) {
      const type =
        invoice.documentType === "TD01" || invoice.documentType === "TD04"
          ? invoice.documentType
          : "other";
      summary.documentTypes[type] += 1;
      summary.canonicalStatuses[normalizeArubaRemoteStatusLabel(invoice.status)] += 1;
    }
  }
}

function invoiceSearchUrl(input: {
  services: string;
  page: number;
  windowStart: Date;
  windowEnd: Date;
}): string {
  const searchUrl = new URL("/api/v2/invoices-out", input.services);
  searchUrl.search = new URLSearchParams({
    page: String(input.page),
    size: String(PROBE_PAGE_SIZE),
    creationStartDate: input.windowStart.toISOString(),
    creationEndDate: input.windowEnd.toISOString(),
  }).toString();
  return searchUrl.toString();
}

async function readAdditionalPages(input: {
  target: (typeof endpoints)[ArubaApiEnvironment];
  token: string;
  firstPage: z.infer<typeof invoiceSearchSchema>;
  page: number;
  requestedPages: number;
  returnedInvoiceGroups: number;
  seenGroupIds: Set<string>;
  summary: SanitizedInventorySummary;
  windowStart: Date;
  windowEnd: Date;
}): Promise<number> {
  if (input.page > input.requestedPages) return input.returnedInvoiceGroups;
  const nextPage = parsed(
    invoiceSearchSchema,
    await providerJson(
      invoiceSearchUrl({
        services: input.target.services,
        page: input.page,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
      }),
      { headers: bearer(input.token) },
    ),
  );
  const expectedElements = Math.min(
    PROBE_PAGE_SIZE,
    Math.max(0, nextPage.totalElements - (input.page - 1) * PROBE_PAGE_SIZE),
  );
  const pageIds = nextPage.content.map((group) => group.id);
  if (
    nextPage.number !== input.page ||
    nextPage.size !== PROBE_PAGE_SIZE ||
    nextPage.first ||
    nextPage.last !== (input.page === nextPage.totalPages) ||
    nextPage.numberOfElements !== nextPage.content.length ||
    nextPage.numberOfElements !== expectedElements ||
    nextPage.totalElements !== input.firstPage.totalElements ||
    nextPage.totalPages !== input.firstPage.totalPages ||
    new Set(pageIds).size !== pageIds.length ||
    pageIds.some((id) => input.seenGroupIds.has(id)) ||
    input.returnedInvoiceGroups + nextPage.numberOfElements > nextPage.totalElements
  ) {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  }
  for (const id of pageIds) input.seenGroupIds.add(id);
  addGroupsToSummary(input.summary, nextPage.content);
  return readAdditionalPages({
    ...input,
    page: input.page + 1,
    returnedInvoiceGroups: input.returnedInvoiceGroups + nextPage.numberOfElements,
  });
}

export async function runArubaApiReadProbe(
  input: ArubaApiReadProbeInput,
): Promise<ArubaApiReadProbeResult> {
  const target = endpoints[input.environment];
  const session = await authenticateArubaApi({
    environment: input.environment,
    credentials: {
      username: input.username,
      password: input.password,
      expectedTaxId: input.expectedTaxId,
    },
    now: input.now?.getTime(),
  });

  const windowEnd = input.now ?? new Date();
  const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);
  const firstPage = parsed(
    invoiceSearchSchema,
    await providerJson(
      invoiceSearchUrl({ services: target.services, page: 1, windowStart, windowEnd }),
      { headers: bearer(session.accessToken) },
    ),
  );
  const firstPageIds = firstPage.content.map((group) => group.id);
  const expectedFirstPageElements = Math.min(PROBE_PAGE_SIZE, firstPage.totalElements);
  if (
    firstPage.number !== 1 ||
    firstPage.size !== PROBE_PAGE_SIZE ||
    !firstPage.first ||
    firstPage.last !== firstPage.totalPages <= 1 ||
    firstPage.numberOfElements !== firstPage.content.length ||
    firstPage.numberOfElements !== expectedFirstPageElements ||
    firstPage.totalPages !== Math.ceil(firstPage.totalElements / PROBE_PAGE_SIZE) ||
    new Set(firstPageIds).size !== firstPageIds.length
  ) {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  }

  const requestedPages = Math.max(1, Math.min(firstPage.totalPages, PROBE_MAX_PAGES));
  const summary = emptyInventorySummary();
  addGroupsToSummary(summary, firstPage.content);
  const returnedInvoiceGroups = await readAdditionalPages({
    target,
    token: session.accessToken,
    firstPage,
    page: 2,
    requestedPages,
    returnedInvoiceGroups: firstPage.content.length,
    seenGroupIds: new Set(firstPageIds),
    summary,
    windowStart,
    windowEnd,
  });

  const completeWindowRead = firstPage.totalPages <= PROBE_MAX_PAGES;
  if (completeWindowRead && returnedInvoiceGroups !== firstPage.totalElements) {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  }

  return {
    status: "ok",
    environment: input.environment,
    accountVerified: true,
    accountExpired: false,
    outboundReadAuthorized: true,
    requestedPages,
    returnedInvoiceGroups,
    returnedDocuments: summary.returnedDocuments,
    totalInvoiceGroups: firstPage.totalElements,
    groupCardinality: summary.groupCardinality,
    documentTypes: summary.documentTypes,
    canonicalStatuses: summary.canonicalStatuses,
    completeWindowRead,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
  };
}
