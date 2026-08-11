import { createHash, createHmac, createVerify, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { getConfig } from "../config.server.ts";
import {
  completeHistoryImport,
  historyImportPending,
  jobLeaseCurrent,
  loadConnection,
  markConnectionSynced,
  processEbayDeletionRecord,
  readCursor,
  saveConnection,
  writeCursor,
  type ClaimedJob,
  type ConnectorActor,
} from "../db/connectors.server.ts";
import { importOrders } from "../db/order-import.server.ts";
import { AppError } from "../errors.ts";
import {
  defaultHistoricalStartDate,
  historicalOrderWindow,
  markHistoricalOrders,
  type OrderInput,
} from "../orders.ts";
import { providerJson } from "./provider-http.server.ts";
import { providerOrder } from "./provider-order.ts";

export const EBAY_FULFILLMENT_API_VERSION = "v1";
export const EBAY_FULFILLMENT_SCHEMA_RELEASE = "1.20.7";
export const EBAY_SCOPE = [
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly",
  "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
].join(" ");
const OVERLAP_MS = 5 * 60 * 1000;
const EBAY_WEBHOOK_WINDOW_MS = 60_000;
const EBAY_WEBHOOK_ATTEMPTS_PER_WINDOW = 10;
const EBAY_WEBHOOK_ORIGIN_LIMIT = 1_024;
const EBAY_PUBLIC_KEY_CACHE_LIMIT = 256;
const EBAY_PUBLIC_KEY_FAILURE_TTL_MS = 60_000;
const EBAY_PUBLIC_KEY_MAX_IN_FLIGHT = 4;
const EBAY_PUBLIC_KEY_REQUESTS_PER_WINDOW = 30;

interface EbayCredentials {
  refreshToken: string;
}

let accessTokenCache: { key: string; token: string; expiresAt: number } | null = null;
let applicationTokenCache: { token: string; expiresAt: number } | null = null;
const publicKeyCache = new Map<
  string,
  { key: string; digest: "sha1" | "sha256"; expiresAt: number }
>();
const failedPublicKeyCache = new Map<string, number>();
const deletionAttempts = new Map<string, { count: number; resetAt: number }>();
let publicKeyRequestsInFlight = 0;
const publicKeyRequestBudget = { count: 0, resetAt: 0 };

const moneySchema = z.looseObject({ value: z.string(), currency: z.string() });
const recordSchema = z.record(z.string(), z.unknown());

function record(value: unknown): Record<string, unknown> {
  return recordSchema.safeParse(value).data ?? {};
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const parsed = record(item);
        return Object.keys(parsed).length ? [parsed] : [];
      })
    : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function money(value: unknown): { value: string; currency: string } | null {
  return moneySchema.safeParse(value).data ?? null;
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  if (!map.has(key) && map.size >= limit) map.delete(map.keys().next().value!);
  map.set(key, value);
}

export function assertEbayDeletionRequestAllowed(originKey: string): void {
  const now = Date.now();
  const current = deletionAttempts.get(originKey);
  if (!current || current.resetAt <= now) {
    setBounded(
      deletionAttempts,
      originKey,
      { count: 1, resetAt: now + EBAY_WEBHOOK_WINDOW_MS },
      EBAY_WEBHOOK_ORIGIN_LIMIT,
    );
    return;
  }
  if (current.count >= EBAY_WEBHOOK_ATTEMPTS_PER_WINDOW) {
    throw new AppError("PROVIDER_RATE_LIMITED", 429);
  }
  current.count += 1;
}

export function assertEbayPublicKeyRequestAllowed(now = Date.now()): void {
  if (publicKeyRequestBudget.resetAt <= now) {
    publicKeyRequestBudget.count = 1;
    publicKeyRequestBudget.resetAt = now + EBAY_WEBHOOK_WINDOW_MS;
    return;
  }
  if (publicKeyRequestBudget.count >= EBAY_PUBLIC_KEY_REQUESTS_PER_WINDOW) {
    throw new AppError("PROVIDER_RATE_LIMITED", 429);
  }
  publicKeyRequestBudget.count += 1;
}

function environmentBase(environment: "sandbox" | "production") {
  return environment === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
}

export function ebayNextUrl(environment: "sandbox" | "production", value: unknown) {
  const next = text(value);
  if (!next) return null;
  const base = new URL(environmentBase(environment));
  let url: URL;
  try {
    url = new URL(next, base);
  } catch {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  }
  if (url.protocol !== "https:" || url.origin !== base.origin) {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  }
  return url.toString();
}

function identityBase(environment: "sandbox" | "production") {
  return environment === "sandbox" ? "https://apiz.sandbox.ebay.com" : "https://apiz.ebay.com";
}

export function ebayAccountReference(profile: unknown, expected: string) {
  const source = record(profile);
  const references = [source.username, source.userId, source.user_id].flatMap((value) => {
    const reference = text(value);
    return reference ? [reference] : [];
  });
  const verified = references.find(
    (reference) => reference.toLocaleLowerCase("en-US") === expected.toLocaleLowerCase("en-US"),
  );
  if (!verified) throw new AppError("AUTH_PROVIDER_ACCOUNT_MISMATCH", 409);
  return verified;
}

async function accessToken(environment: "sandbox" | "production", refreshToken: string) {
  const config = getConfig();
  if (!config.EBAY_CLIENT_ID || !config.EBAY_CLIENT_SECRET)
    throw new AppError("PROVIDER_NOT_CONFIGURED", 503);
  const key = createHash("sha256").update(`${environment}\0${refreshToken}`).digest("hex");
  if (accessTokenCache?.key === key && accessTokenCache.expiresAt > Date.now()) {
    return accessTokenCache.token;
  }
  const result = await providerJson(`${environmentBase(environment)}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.EBAY_CLIENT_ID}:${config.EBAY_CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: EBAY_SCOPE,
    }),
  });
  const token = text(result.access_token);
  if (!token) throw new AppError("AUTH_PROVIDER_EXPIRED", 401);
  const expiresIn = Number(result.expires_in ?? 7200);
  accessTokenCache = {
    key,
    token,
    expiresAt: Date.now() + Math.max(30, expiresIn - 60) * 1000,
  };
  return token;
}

async function applicationToken() {
  if (applicationTokenCache && applicationTokenCache.expiresAt > Date.now()) {
    return applicationTokenCache.token;
  }
  const config = getConfig();
  if (!config.EBAY_CLIENT_ID || !config.EBAY_CLIENT_SECRET)
    throw new AppError("PROVIDER_NOT_CONFIGURED", 503);
  const result = await providerJson("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.EBAY_CLIENT_ID}:${config.EBAY_CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "https://api.ebay.com/oauth/api_scope",
    }),
  });
  const token = text(result.access_token);
  if (!token) throw new AppError("AUTH_PROVIDER_EXPIRED", 401);
  applicationTokenCache = {
    token,
    expiresAt: Date.now() + Math.max(30, Number(result.expires_in ?? 7200) - 60) * 1000,
  };
  return token;
}

async function publicKey(keyId: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(keyId)) throw new AppError("WEBHOOK_SIGNATURE_INVALID", 401);
  const now = Date.now();
  const cached = publicKeyCache.get(keyId);
  if (cached && cached.expiresAt > now) return cached;
  if ((failedPublicKeyCache.get(keyId) ?? 0) > now) {
    throw new AppError("WEBHOOK_SIGNATURE_INVALID", 401);
  }
  if (publicKeyRequestsInFlight >= EBAY_PUBLIC_KEY_MAX_IN_FLIGHT) {
    throw new AppError("PROVIDER_RATE_LIMITED", 429);
  }
  assertEbayPublicKeyRequestAllowed(now);
  publicKeyRequestsInFlight += 1;
  try {
    const result = await providerJson(
      `https://api.ebay.com/commerce/notification/v1/public_key/${encodeURIComponent(keyId)}`,
      { headers: { Authorization: `Bearer ${await applicationToken()}` } },
    );
    let key = text(result.key);
    const algorithm = text(result.algorithm)?.toUpperCase();
    const digest = text(result.digest)?.replace("-", "").toUpperCase();
    if (!key || algorithm !== "ECDSA" || (digest !== "SHA1" && digest !== "SHA256")) {
      throw new AppError("WEBHOOK_SIGNATURE_INVALID", 401);
    }
    if (key.includes("-----BEGIN PUBLIC KEY-----") && !key.includes("\n")) {
      const body = key
        .replace("-----BEGIN PUBLIC KEY-----", "")
        .replace("-----END PUBLIC KEY-----", "")
        .replace(/\s+/g, "");
      key = `-----BEGIN PUBLIC KEY-----\n${body.match(/.{1,64}/g)?.join("\n") ?? body}\n-----END PUBLIC KEY-----`;
    }
    const entry = {
      key,
      digest: digest === "SHA1" ? ("sha1" as const) : ("sha256" as const),
      expiresAt: Date.now() + 60 * 60_000,
    };
    setBounded(publicKeyCache, keyId, entry, EBAY_PUBLIC_KEY_CACHE_LIMIT);
    return entry;
  } catch (error) {
    if (
      error instanceof AppError &&
      (error.code === "WEBHOOK_SIGNATURE_INVALID" || error.code === "PROVIDER_RESPONSE_INVALID")
    ) {
      setBounded(
        failedPublicKeyCache,
        keyId,
        Date.now() + EBAY_PUBLIC_KEY_FAILURE_TTL_MS,
        EBAY_PUBLIC_KEY_CACHE_LIMIT,
      );
      throw new AppError("WEBHOOK_SIGNATURE_INVALID", 401);
    }
    throw error;
  } finally {
    publicKeyRequestsInFlight -= 1;
  }
}

async function verifyAccountDeletionSignature(body: Buffer, signatureHeader: string | null) {
  if (!signatureHeader || Buffer.byteLength(signatureHeader) > 8192)
    throw new AppError("WEBHOOK_SIGNATURE_INVALID", 401);
  let header: Record<string, unknown>;
  try {
    header = recordSchema.parse(JSON.parse(Buffer.from(signatureHeader, "base64").toString()));
  } catch {
    throw new AppError("WEBHOOK_SIGNATURE_INVALID", 401);
  }
  const keyId = text(header.kid);
  const signature = text(header.signature);
  if (!keyId || !signature) throw new AppError("WEBHOOK_SIGNATURE_INVALID", 401);
  const publicKeyEntry = await publicKey(keyId);
  const verifier = createVerify(publicKeyEntry.digest);
  verifier.update(body);
  verifier.end();
  if (!verifier.verify(publicKeyEntry.key, Buffer.from(signature, "base64"))) {
    throw new AppError("WEBHOOK_SIGNATURE_INVALID", 401);
  }
}

export function mapEbayOrder(payload: unknown, accountReference: string): OrderInput {
  const order = record(payload);
  const orderId = text(order.orderId);
  const createdAt = text(order.creationDate);
  const updatedAt = text(order.lastModifiedDate) ?? createdAt;
  const pricing = record(order.pricingSummary);
  const total = money(pricing.total);
  if (!orderId || !createdAt || !updatedAt || !total) {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  }
  const buyer = record(order.buyer);
  const instructions = records(order.fulfillmentStartInstructions);
  const shippingStep = record(instructions.map((item) => record(item.shippingStep)).find(Boolean));
  const shipTo = record(shippingStep.shipTo);
  const address = record(shipTo.contactAddress);
  const taxIdentifier = record(buyer.taxIdentifier);
  const declaredTaxType = text(taxIdentifier.taxIdentifierType);
  const taxpayerId = text(taxIdentifier.taxpayerId);
  const countryCode = text(taxIdentifier.issuingCountry) ?? text(address.countryCode);
  const taxIdentifiers =
    taxpayerId && declaredTaxType
      ? [
          {
            type:
              declaredTaxType === "CODICE_FISCALE"
                ? ("CODICE_FISCALE" as const)
                : declaredTaxType === "VATIN"
                  ? ("PARTITA_IVA" as const)
                  : ("ALTRO" as const),
            value: taxpayerId,
            countryCode,
            sourceField: `buyer.taxIdentifier.${declaredTaxType}`,
          },
        ]
      : [];
  const companyName = text(shipTo.companyName);
  const fullName = text(shipTo.fullName);
  const buyerId = text(buyer.username) ?? text(buyer.userId);
  const lineItems = records(order.lineItems);
  const payments = records(record(order.paymentSummary).payments);
  const refunds = [
    ...records(record(order.paymentSummary).refunds),
    ...lineItems.flatMap((line) => records(line.refunds)),
  ];
  const cancelled = text(record(order.cancelStatus).cancelState);
  const paymentStatus = text(order.orderPaymentStatus) ?? "PENDING";
  return providerOrder({
    provider: "EBAY",
    externalAccountId: accountReference,
    externalOrderId: orderId,
    externalCustomerId: buyerId,
    displayNumber: text(order.salesRecordReference) ?? orderId,
    createdAt,
    updatedAt,
    currency: total.currency,
    total: total.value,
    shippingAmount: money(pricing.deliveryCost)?.value ?? "0.00",
    paymentStatus: ["FULLY_REFUNDED", "REFUNDED"].includes(paymentStatus)
      ? "REFUNDED"
      : paymentStatus === "PAID"
        ? "PAID"
        : "PENDING",
    fulfillmentStatus:
      order.orderFulfillmentStatus === "FULFILLED"
        ? "FULFILLED"
        : order.orderFulfillmentStatus === "IN_PROGRESS"
          ? "PARTIAL"
          : "UNFULFILLED",
    cancelledAt: cancelled === "CANCELED" ? updatedAt : null,
    sourceReviewRequired: cancelled === "IN_PROGRESS",
    sourceSnapshot: order,
    customer: {
      kind:
        countryCode === "IT"
          ? companyName
            ? "BUSINESS_IT"
            : "PRIVATE_IT"
          : countryCode
            ? "EU"
            : "UNKNOWN",
      displayName: companyName ?? fullName ?? buyerId,
      companyName,
      email: text(shipTo.email),
      phone: text(shipTo.primaryPhone?.toString()),
      billingAddress: {
        line1: text(address.addressLine1),
        line2: text(address.addressLine2),
        postalCode: text(address.postalCode),
        city: text(address.city),
        province: text(address.stateOrProvince),
        countryCode,
      },
      shippingAddress: {
        line1: text(address.addressLine1),
        line2: text(address.addressLine2),
        postalCode: text(address.postalCode),
        city: text(address.city),
        province: text(address.stateOrProvince),
        countryCode,
      },
      taxIdentifiers,
    },
    lines: lineItems.map((line, index) => {
      const gross = money(line.lineItemCost);
      const discounted = money(line.discountedLineItemCost) ?? gross;
      if (!gross || !discounted) throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
      const discount = Math.max(
        0,
        Math.round((Number(gross.value) - Number(discounted.value)) * 100),
      );
      return {
        externalLineId: text(line.lineItemId) ?? `${orderId}-${index + 1}`,
        description: text(line.title) ?? "Articolo eBay",
        quantity: Number(line.quantity ?? 1),
        grossAmount: gross.value,
        discountAmount: (discount / 100).toFixed(2),
      };
    }),
    payments: payments.map((payment, index) => ({
      externalPaymentId: text(payment.paymentReferenceId) ?? `${orderId}-payment-${index + 1}`,
      method: text(payment.paymentMethod) ?? "EBAY",
      status: payment.paymentStatus === "PAID" ? "PAID" : "PENDING",
      amount: money(payment.amount)?.value ?? "0.00",
      paidAt: text(payment.paymentDate) ?? null,
    })),
    // eBay dichiara che l'importo Fulfillment è netto venditore e può escludere imposte:
    // non è un importo cliente fiscalmente utilizzabile senza una fonte aggiuntiva.
    refunds: refunds.map((refund, index) => ({
      externalRefundId:
        text(refund.refundId) ?? text(refund.refundReferenceId) ?? `${orderId}-refund-${index + 1}`,
      status: "AMBIGUOUS",
      amount: null,
      completedAt: text(refund.refundDate) ?? null,
      raw: refund,
    })),
  });
}

async function fetchOrder(environment: "sandbox" | "production", token: string, orderId: string) {
  return providerJson(
    `${environmentBase(environment)}/sell/fulfillment/${EBAY_FULFILLMENT_API_VERSION}/order/${encodeURIComponent(orderId)}?fieldGroups=TAX_BREAKDOWN`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
  );
}

async function fetchOrdersSince(start: string) {
  const connection = await loadConnection<EbayCredentials>("EBAY");
  const environment = connection.environment === "SANDBOX" ? "sandbox" : "production";
  const token = await accessToken(environment, connection.credentials.refreshToken);
  const end = new Date().toISOString();
  const orders: OrderInput[] = [];
  let url: string | null =
    `${environmentBase(environment)}/sell/fulfillment/${EBAY_FULFILLMENT_API_VERSION}/order?` +
    new URLSearchParams({
      filter: `lastmodifieddate:[${start}..${end}]`,
      fieldGroups: "TAX_BREAKDOWN",
      limit: "50",
    });
  for (let page = 0; url && page < 20; page += 1) {
    const response = await providerJson(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    for (const summary of records(response.orders)) {
      const orderId = text(summary.orderId);
      if (!orderId) throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
      // Tax identifier is contractually present only on getOrder; la sequenza evita burst di 50 richieste.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const detail = await fetchOrder(environment, token, orderId);
      orders.push(mapEbayOrder(detail, connection.accountReference));
    }
    url = ebayNextUrl(environment, response.next);
  }
  if (url) throw new AppError("PROVIDER_RESPONSE_TOO_LARGE", 502);
  return { connection, end, orders };
}

export async function syncEbayOrders(job?: ClaimedJob) {
  if (await historyImportPending("EBAY")) throw new AppError("CONFLICT_REVISION", 409);
  const cursor = await readCursor("EBAY");
  const start = cursor.overlapFrom ?? new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { end, orders } = await fetchOrdersSince(start);
  if (job && !(await jobLeaseCurrent(job))) throw new AppError("CONFLICT_REVISION", 409);
  if (orders.length) {
    await importOrders(orders, { type: "SYSTEM", requestId: `ebay-sync:${end}` }, job);
  }
  await writeCursor("EBAY", end, new Date(Date.parse(end) - OVERLAP_MS).toISOString(), job);
  await markConnectionSynced("EBAY", job);
  return { count: orders.length, from: start, to: end };
}

async function ebayHistory(value: unknown) {
  const window = historicalOrderWindow(value);
  if (!window) throw new AppError("ORDER_INVALID_INPUT", 422);
  const result = await fetchOrdersSince(window.fetchFrom);
  return { ...result, orders: markHistoricalOrders(result.orders, window.startDate) };
}

export async function previewEbayHistory(startDate: unknown = defaultHistoricalStartDate()) {
  const { orders } = await ebayHistory(startDate);
  return {
    count: orders.length,
    reviewRequired: orders.filter((order) => order.refunds.length).length,
  };
}

export async function importEbayHistory(
  startDate: unknown,
  actor: ConnectorActor,
  job?: ClaimedJob,
) {
  if (!(await historyImportPending("EBAY"))) throw new AppError("CONFLICT_REVISION", 409);
  const { end, orders } = await ebayHistory(startDate);
  const result = await importOrders(orders, actor, job);
  await completeHistoryImport(
    "EBAY",
    end,
    new Date(Date.parse(end) - OVERLAP_MS).toISOString(),
    job,
  );
  return {
    ...result,
    count: orders.length,
    reviewRequired: orders.filter((order) => order.refunds.length).length,
  };
}

function stateKey() {
  const value = getConfig().CREDENTIALS_ENCRYPTION_KEY;
  if (!value) throw new AppError("PROVIDER_NOT_CONFIGURED", 503);
  return Buffer.from(value, "base64url");
}

export function createEbayOAuthState(userId: number) {
  const payload = Buffer.from(
    JSON.stringify({ userId, expiresAt: Date.now() + 10 * 60_000 }),
  ).toString("base64url");
  return `${payload}.${createHmac("sha256", stateKey()).update(payload).digest("base64url")}`;
}

export function verifyEbayOAuthState(value: string, userId: number) {
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return false;
  const expected = createHmac("sha256", stateKey()).update(payload).digest();
  const actual = Buffer.from(signature, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
  try {
    const parsed = z
      .object({ userId: z.number().int(), expiresAt: z.number().int() })
      .parse(JSON.parse(Buffer.from(payload, "base64url").toString()));
    return parsed.userId === userId && parsed.expiresAt >= Date.now();
  } catch {
    return false;
  }
}

export function ebayAuthorizationUrl(state: string) {
  const config = getConfig();
  if (!config.EBAY_CLIENT_ID || !config.EBAY_RUNAME)
    throw new AppError("PROVIDER_NOT_CONFIGURED", 503);
  const host = config.EBAY_ENVIRONMENT === "sandbox" ? "auth.sandbox.ebay.com" : "auth.ebay.com";
  return `https://${host}/oauth2/authorize?${new URLSearchParams({
    client_id: config.EBAY_CLIENT_ID,
    redirect_uri: config.EBAY_RUNAME,
    response_type: "code",
    scope: EBAY_SCOPE,
    state,
  })}`;
}

export async function completeEbayOAuth(code: string, actor: ConnectorActor) {
  const config = getConfig();
  if (!config.EBAY_CLIENT_ID || !config.EBAY_CLIENT_SECRET || !config.EBAY_RUNAME)
    throw new AppError("PROVIDER_NOT_CONFIGURED", 503);
  const response = await providerJson(
    `${environmentBase(config.EBAY_ENVIRONMENT)}/identity/v1/oauth2/token`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.EBAY_CLIENT_ID}:${config.EBAY_CLIENT_SECRET}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.EBAY_RUNAME,
      }),
    },
  );
  const refreshToken = text(response.refresh_token);
  const accessToken = text(response.access_token);
  if (!refreshToken || !accessToken) throw new AppError("AUTH_PROVIDER_EXPIRED", 401);
  const profile = await providerJson(
    `${identityBase(config.EBAY_ENVIRONMENT)}/commerce/identity/v1/user/`,
    { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } },
  );
  const accountReference = ebayAccountReference(profile, config.EBAY_ACCOUNT_REFERENCE);
  await saveConnection(
    {
      provider: "EBAY",
      environment: config.EBAY_ENVIRONMENT === "sandbox" ? "SANDBOX" : "PRODUCTION",
      accountReference,
      credentials: { refreshToken },
    },
    actor,
  );
}

export async function processEbayAccountDeletion(body: Buffer, signatureHeader: string | null) {
  await verifyAccountDeletionSignature(body, signatureHeader);
  let payload: Record<string, unknown>;
  try {
    payload = recordSchema.parse(JSON.parse(body.toString("utf8")));
  } catch {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 400);
  }
  if (record(payload.metadata).topic !== "MARKETPLACE_ACCOUNT_DELETION") {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 400);
  }
  const notification = record(payload.notification);
  const data = record(notification.data);
  const notificationId = text(notification.notificationId);
  if (!notificationId) throw new AppError("PROVIDER_RESPONSE_INVALID", 400);
  const identifiers = [data.userId, data.username, data.eiasToken].flatMap((value) => {
    const identifier = text(value);
    return identifier ? [identifier] : [];
  });
  if (!identifiers.length) throw new AppError("PROVIDER_RESPONSE_INVALID", 400);
  const payloadSha256 = createHash("sha256").update(body).digest("hex");
  return processEbayDeletionRecord({
    externalEventId: notificationId,
    payloadSha256,
    identifiers,
  });
}
