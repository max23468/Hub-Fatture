import { z } from "zod";

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

const invoiceSearchSchema = z.object({
  content: z.array(z.unknown()),
  numberOfElements: z.coerce.number().int().nonnegative(),
  totalElements: z.coerce.number().int().nonnegative(),
  totalPages: z.coerce.number().int().nonnegative(),
});

const PROBE_PAGE_SIZE = 10;
const PROBE_MAX_PAGES = 2;

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
  totalInvoiceGroups: number;
  completeWindowRead: boolean;
  windowStart: string;
  windowEnd: string;
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
  if (
    nextPage.numberOfElements !== nextPage.content.length ||
    nextPage.totalElements !== input.firstPage.totalElements ||
    nextPage.totalPages !== input.firstPage.totalPages ||
    input.returnedInvoiceGroups + nextPage.numberOfElements > nextPage.totalElements
  ) {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  }
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
  const token = parsed(
    tokenSchema,
    await providerJson(`${target.auth}/auth/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({
        grant_type: "password",
        username: input.username,
        password: input.password,
      }),
    }),
  );

  const userInfo = parsed(
    userInfoSchema,
    await providerJson(`${target.auth}/auth/userInfo`, { headers: bearer(token.access_token) }),
  );
  const expectedTaxId = taxIdentity(input.expectedTaxId);
  const observedTaxIds = new Set([taxIdentity(userInfo.vatCode), taxIdentity(userInfo.fiscalCode)]);
  if (!expectedTaxId || !observedTaxIds.has(expectedTaxId)) {
    throw new AppError("AUTH_PROVIDER_ACCOUNT_MISMATCH", 409);
  }
  if (userInfo.accountStatus.expired) throw new AppError("AUTH_PROVIDER_EXPIRED", 401);

  const windowEnd = input.now ?? new Date();
  const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);
  const firstPage = parsed(
    invoiceSearchSchema,
    await providerJson(
      invoiceSearchUrl({ services: target.services, page: 1, windowStart, windowEnd }),
      { headers: bearer(token.access_token) },
    ),
  );
  if (
    firstPage.numberOfElements !== firstPage.content.length ||
    firstPage.totalPages !== Math.ceil(firstPage.totalElements / PROBE_PAGE_SIZE) ||
    firstPage.numberOfElements > firstPage.totalElements
  ) {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  }

  const requestedPages = Math.max(1, Math.min(firstPage.totalPages, PROBE_MAX_PAGES));
  const returnedInvoiceGroups = await readAdditionalPages({
    target,
    token: token.access_token,
    firstPage,
    page: 2,
    requestedPages,
    returnedInvoiceGroups: firstPage.content.length,
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
    totalInvoiceGroups: firstPage.totalElements,
    completeWindowRead,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
  };
}
