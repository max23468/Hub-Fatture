import { z } from "zod";

import {
  arubaRemoteStatusSchema,
  normalizeArubaRemoteStatusLabel,
  type ArubaRemoteStatus,
} from "../aruba-inbound.ts";
import { ARUBA_IMPORT_MAX_BYTES, ARUBA_UPLOAD_MAX_BYTES } from "../aruba.ts";
import { AppError } from "../errors.ts";
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
  refresh_token: z.string().min(1),
  token_type: z.literal("bearer"),
  expires_in: z.coerce.number().int().positive(),
  ".issued": z.string().min(1),
  ".expires": z.string().min(1),
});

export const arubaApiAccountInfoSchema = z.object({
  username: z.string().min(1),
  pec: z.email(),
  userDescription: z.string().trim().min(1).max(300),
  countryCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/),
  vatCode: z.string().trim().min(1).max(64),
  fiscalCode: z.string().trim().min(1).max(64),
  accountStatus: z.object({
    expired: z.boolean(),
    expirationDate: z.iso.date(),
  }),
  usageStatus: z.object({
    usedSpaceKB: z.number().int().nonnegative(),
    maxSpaceKB: z.number().int().positive(),
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
  invoiceUploadRequestsPerMinutePerIp: 30,
  maximumInvoiceUploadBytes: 5_000_000,
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

const invoiceUploadResponseSchema = z.object({
  errorCode: z.string().trim().max(20),
  errorDescription: z.string().trim().max(2_000),
  uploadFileName: z.string().trim().max(255).nullish(),
});

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
    .regex(/^[A-Z]{2}$/)
    .nullable(),
  vatCode: z.string().trim().max(64).nullish(),
  fiscalCode: z.string().trim().max(64).nullish(),
});

export const arubaApiInvoiceDetailSchema = z.object({
  channelGroup: z.number().int().nonnegative().nullable(),
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

export const arubaApiNotificationListSchema = z
  .object({
    count: z.number().int().nonnegative(),
    notifications: z
      .array(
        z
          .object({
            date: z.string().trim().min(1).max(64),
            docType: z.string().trim().min(1).max(32),
            filename: z.string().trim().min(1).max(255),
            invoiceId: z.string().trim().min(1).max(200),
            notificationDate: z.string().trim().max(64),
            number: z.string().trim().max(100).nullish(),
            result: z.enum(["EC01", "EC02"]).nullish(),
            file: base64FileSchema,
          })
          .transform((notification) => ({
            ...notification,
            notificationDate: notification.notificationDate || notification.date,
          })),
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
  content: z.array(invoiceGroupSchema).max(ARUBA_API_V2_CONTRACT.maximumPageSize),
  first: z.boolean(),
  last: z.boolean(),
  number: z.number().int().nonnegative(),
  numberOfElements: z.number().int().nonnegative(),
  size: z.number().int().positive(),
  totalElements: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
});

function isEmptySearchSentinel(
  result: z.infer<typeof invoiceSearchSchema>,
  requestedPage: number,
): boolean {
  return (
    requestedPage === 1 &&
    result.number === 0 &&
    !result.first &&
    result.last &&
    result.numberOfElements === 0 &&
    result.content.length === 0 &&
    result.totalElements === 0 &&
    result.totalPages === 0
  );
}

type ArubaApiInvoiceGroup = z.infer<typeof invoiceGroupSchema>;
export type ArubaApiInvoiceDetail = z.infer<typeof arubaApiInvoiceDetailSchema>;
export type ArubaApiNotificationList = z.infer<typeof arubaApiNotificationListSchema>;
export type ArubaApiAccountInfo = z.infer<typeof arubaApiAccountInfoSchema>;

export interface ArubaApiCredentials {
  username: string;
  password: string;
  expectedTaxId: string;
}

export interface ArubaApiSession {
  environment: ArubaApiEnvironment;
  accessToken: string;
  expiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
}

export interface ArubaApiInvoicePage {
  groups: ArubaApiInvoiceGroup[];
  page: number;
  size: number;
  totalGroups: number;
  totalPages: number;
  terminal: boolean;
}

interface ArubaApiUploadResult {
  accepted: boolean;
  errorCode: string;
  errorDescription: string;
  uploadFileName: string | null;
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

async function requestToken(
  environment: ArubaApiEnvironment,
  body: URLSearchParams,
  refresh: boolean,
) {
  let response: Response;
  try {
    response = await fetch(`${endpoints[environment].auth}/auth/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new AppError("PROVIDER_UNAVAILABLE", 503);
  }
  if (response.status === 400) {
    const error = z
      .object({ error: z.string(), error_description: z.string().optional() })
      .safeParse(await response.json().catch(() => null));
    if (error.success && error.data.error === "invalid_grant") {
      throw new AppError(
        refresh ? "AUTH_PROVIDER_REFRESH_INVALID" : "AUTH_INVALID_CREDENTIALS",
        401,
      );
    }
    throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  }
  if (response.status === 429) throw new AppError("PROVIDER_RATE_LIMITED", 429);
  if (response.status >= 500) throw new AppError("PROVIDER_UNAVAILABLE", 503);
  if (!response.ok) throw new AppError("AUTH_PROVIDER_EXPIRED", 401);
  return parsed(tokenSchema, await response.json().catch(() => null));
}

async function uploadArubaApiInvoice(
  session: ArubaApiSession,
  xml: Buffer,
  dryRun: boolean,
): Promise<ArubaApiUploadResult> {
  if (!xml.byteLength || xml.byteLength > ARUBA_UPLOAD_MAX_BYTES) {
    throw new AppError("ARUBA_BATCH_INVALID", 422);
  }
  const target = endpoints[session.environment];
  const result = parsed(
    invoiceUploadResponseSchema,
    await providerJson(`${target.services}/services/invoice/upload`, {
      method: "POST",
      headers: {
        ...bearer(session.accessToken),
        "Content-Type": "application/json;charset=UTF-8",
      },
      body: JSON.stringify({
        dataFile: xml.toString("base64"),
        skipExtraSchema: false,
        dryRun,
      }),
    }),
  );
  const accepted = result.errorCode === "0000" && Boolean(result.uploadFileName);
  return {
    accepted,
    errorCode: result.errorCode,
    errorDescription: result.errorDescription,
    uploadFileName: result.uploadFileName ?? null,
  };
}

export async function dryRunArubaApiInvoice(
  session: ArubaApiSession,
  xml: Buffer,
): Promise<ArubaApiUploadResult> {
  if (session.environment === "PRODUCTION") {
    throw new AppError("ARUBA_SEND_NOT_AUTHORIZED", 409);
  }
  return uploadArubaApiInvoice(session, xml, true);
}

export async function sendUnsignedArubaApiInvoice(
  session: ArubaApiSession,
  xml: Buffer,
): Promise<ArubaApiUploadResult> {
  return uploadArubaApiInvoice(session, xml, false);
}

function sessionFromToken(environment: ArubaApiEnvironment, value: z.infer<typeof tokenSchema>) {
  const issuedAt = Date.parse(value[".issued"]);
  const expiresAt = Date.parse(value[".expires"]);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  }
  return {
    environment,
    accessToken: value.access_token,
    expiresAt,
    refreshToken: value.refresh_token,
    refreshExpiresAt: issuedAt + 60 * 60 * 1_000,
  } satisfies ArubaApiSession;
}

export async function readArubaApiAccountInfo(
  session: ArubaApiSession,
): Promise<ArubaApiAccountInfo> {
  return parsed(
    arubaApiAccountInfoSchema,
    await providerJson(`${endpoints[session.environment].auth}/auth/userInfo`, {
      headers: bearer(session.accessToken),
    }),
  );
}

export async function refreshArubaApiSession(input: {
  session: ArubaApiSession;
}): Promise<ArubaApiSession> {
  const token = await requestToken(
    input.session.environment,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.session.refreshToken,
    }),
    true,
  );
  return sessionFromToken(input.session.environment, token);
}

export async function authenticateArubaApiWithAccount(input: {
  environment: ArubaApiEnvironment;
  credentials: ArubaApiCredentials;
  now?: number;
}): Promise<{ session: ArubaApiSession; account: ArubaApiAccountInfo }> {
  const credentials = z
    .object({
      username: z.string().trim().min(1).max(200),
      password: z.string().min(1).max(500),
      expectedTaxId: z.string().trim().min(1).max(64),
    })
    .safeParse(input.credentials);
  if (!credentials.success) throw new AppError("AUTH_INVALID_CREDENTIALS", 422);
  const token = await requestToken(
    input.environment,
    new URLSearchParams({
      grant_type: "password",
      username: credentials.data.username,
      password: credentials.data.password,
    }),
    false,
  );
  const session = sessionFromToken(input.environment, token);
  const userInfo = await readArubaApiAccountInfo(session);
  const expectedTaxId = taxIdentity(credentials.data.expectedTaxId);
  const observedTaxIds = new Set([taxIdentity(userInfo.vatCode), taxIdentity(userInfo.fiscalCode)]);
  if (!expectedTaxId || !observedTaxIds.has(expectedTaxId)) {
    throw new AppError("AUTH_PROVIDER_ACCOUNT_MISMATCH", 409);
  }
  if (userInfo.accountStatus.expired) throw new AppError("AUTH_PROVIDER_EXPIRED", 401);
  return { session, account: userInfo };
}

export async function authenticateArubaApi(input: {
  environment: ArubaApiEnvironment;
  credentials: ArubaApiCredentials;
  now?: number;
}): Promise<ArubaApiSession> {
  return (await authenticateArubaApiWithAccount(input)).session;
}

interface ArubaApiInvoiceSearchFilters {
  receiverCountry?: string;
  receiverVatCode?: string;
  receiverFiscalCode?: string;
  status?: (typeof ARUBA_API_V2_CONTRACT.documentedInvoiceStatuses)[number];
  documentType?: "TD01" | "TD04";
  modifiedStart?: Date;
  modifiedEnd?: Date;
}

export async function readArubaApiInvoicePage(input: {
  session: ArubaApiSession;
  page: number;
  windowStart: Date;
  windowEnd: Date;
  size?: number;
  filters?: ArubaApiInvoiceSearchFilters;
  documentType?: "TD01" | "TD04";
}): Promise<ArubaApiInvoicePage> {
  const page = z.number().int().positive().safeParse(input.page);
  const size = z
    .number()
    .int()
    .min(1)
    .max(ARUBA_API_V2_CONTRACT.maximumPageSize)
    .safeParse(input.size ?? PROBE_PAGE_SIZE);
  const windowHours = (input.windowEnd.getTime() - input.windowStart.getTime()) / 3_600_000;
  const modifiedHours =
    input.filters?.modifiedStart && input.filters.modifiedEnd
      ? (input.filters.modifiedEnd.getTime() - input.filters.modifiedStart.getTime()) / 3_600_000
      : null;
  if (
    !page.success ||
    !size.success ||
    windowHours <= 0 ||
    windowHours > 48 ||
    (modifiedHours !== null && modifiedHours <= 0) ||
    Boolean(input.filters?.modifiedStart) !== Boolean(input.filters?.modifiedEnd)
  ) {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 422);
  }
  const target = endpoints[input.session.environment];
  const url = new URL("/api/v2/invoices-out", target.services);
  url.search = new URLSearchParams({
    page: String(page.data),
    size: String(size.data),
    creationStartDate: input.windowStart.toISOString(),
    creationEndDate: input.windowEnd.toISOString(),
    ...(input.filters?.receiverCountry
      ? { receiverCountry: input.filters.receiverCountry.toUpperCase() }
      : {}),
    ...(input.filters?.receiverVatCode ? { receiverVatcode: input.filters.receiverVatCode } : {}),
    ...(input.filters?.receiverFiscalCode
      ? { receiverFiscalcode: input.filters.receiverFiscalCode }
      : {}),
    ...(input.filters?.status ? { status: input.filters.status } : {}),
    ...((input.filters?.documentType ?? input.documentType)
      ? { documentType: (input.filters?.documentType ?? input.documentType)! }
      : {}),
    ...(input.filters?.modifiedStart
      ? { modifiedStartDate: input.filters.modifiedStart.toISOString() }
      : {}),
    ...(input.filters?.modifiedEnd
      ? { modifiedEndDate: input.filters.modifiedEnd.toISOString() }
      : {}),
  }).toString();
  const result = parsed(
    invoiceSearchSchema,
    await providerJson(url.toString(), { headers: bearer(input.session.accessToken) }),
  );
  const expectedElements = Math.min(
    size.data,
    Math.max(0, result.totalElements - (page.data - 1) * size.data),
  );
  const groupIds = result.content.map((group) => group.id);
  const emptySearchSentinel = isEmptySearchSentinel(result, page.data);
  if (
    result.size !== size.data ||
    (!emptySearchSentinel &&
      (result.number !== page.data ||
        result.first !== (page.data === 1) ||
        result.last !== (result.totalPages === 0 || page.data === result.totalPages) ||
        result.numberOfElements !== result.content.length ||
        result.numberOfElements !== expectedElements ||
        result.totalPages !== Math.ceil(result.totalElements / size.data) ||
        new Set(groupIds).size !== groupIds.length))
  ) {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  }
  return {
    groups: result.content,
    page: emptySearchSentinel ? page.data : result.number,
    size: result.size,
    totalGroups: result.totalElements,
    totalPages: result.totalPages,
    terminal: result.last,
  };
}

export async function readArubaApiInvoiceDetail(
  session: ArubaApiSession,
  lookup: string | { id?: string; filename?: string; idSdi?: string },
): Promise<ArubaApiInvoiceDetail> {
  const candidates = typeof lookup === "string" ? { id: lookup } : lookup;
  const entries = Object.entries(candidates).filter((entry): entry is [string, string] =>
    Boolean(entry[1]),
  );
  if (entries.length !== 1) throw new AppError("PROVIDER_RESPONSE_INVALID", 422);
  const [key, rawValue] = entries[0]!;
  if (!(["id", "filename", "idSdi"] as const).includes(key as "id")) {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 422);
  }
  const value = z
    .string()
    .trim()
    .min(1)
    .max(key === "idSdi" ? 200 : 255)
    .safeParse(rawValue);
  if (!value.success) throw new AppError("PROVIDER_RESPONSE_INVALID", 422);
  const url = new URL("/api/v2/invoices-out/detail", endpoints[session.environment].services);
  url.search = new URLSearchParams({
    [key]: value.data,
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
  if (
    (key === "id" && detail.id !== value.data) ||
    (key === "filename" && detail.filename !== value.data) ||
    (key === "idSdi" && detail.idSdi !== value.data)
  ) {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  }
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

interface ArubaApiReadProbeInput {
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
  const emptySearchSentinel = isEmptySearchSentinel(firstPage, 1);
  if (
    firstPage.size !== PROBE_PAGE_SIZE ||
    (!emptySearchSentinel &&
      (firstPage.number !== 1 ||
        !firstPage.first ||
        firstPage.last !== firstPage.totalPages <= 1 ||
        firstPage.numberOfElements !== firstPage.content.length ||
        firstPage.numberOfElements !== expectedFirstPageElements ||
        firstPage.totalPages !== Math.ceil(firstPage.totalElements / PROBE_PAGE_SIZE) ||
        new Set(firstPageIds).size !== firstPageIds.length))
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
