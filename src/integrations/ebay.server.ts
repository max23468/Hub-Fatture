import { createHash, createHmac, createVerify, timingSafeEqual } from "node:crypto";

import { create } from "xmlbuilder2";
import { z } from "zod";

import { getConfig } from "../config.server.ts";
import {
  completedHistoryImportResult,
  historyImportPending,
  loadConnection,
  markConnectionSynced,
  readCursor,
  saveConnection,
  writeCursor,
} from "../db/connector-connections.server.ts";
import { jobLeaseCurrent } from "../db/connector-jobs.server.ts";
import { processEbayDeletionRecord } from "../db/connector-webhooks.server.ts";
import type { ClaimedJob, ConnectorActor } from "../db/connector-types.server.ts";
import { importOrders } from "../db/order-import.server.ts";
import { AppError } from "../errors.ts";
import { splitTwoPartNameUsingFiscalCode } from "../italian-fiscal-code.ts";
import { splitEbayCareOfRecipient } from "../ebay-recipient.ts";
import {
  customerKindFromCountry,
  decimalToCents,
  defaultHistoricalStartDate,
  historicalOrderWindow,
  markHistoricalOrders,
  type OrderInput,
} from "../orders.ts";
import { providerJson, providerText } from "./provider-http.server.ts";
import { providerOrder } from "./provider-order.ts";
import { record, records, text } from "./provider-values.ts";

export const EBAY_FULFILLMENT_API_VERSION = "v1";
export const EBAY_TRADING_API_COMPATIBILITY_LEVEL = "1475";
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
const EBAY_TRADING_SITE_ID = "101";
const EBAY_TRADING_MAX_PAGES = 20;
const EBAY_TRADING_PAGE_SIZE = 100;
const EBAY_TRADING_MAX_MOD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const EBAY_TRADING_XML_MAX_BYTES = 2 * 1024 * 1024;
const EBAY_TRADING_XML_MAX_DEPTH = 64;
const EBAY_TRADING_XML_MAX_ELEMENTS = 20_000;

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
function money(value: unknown): { value: string; currency: string } | null {
  return moneySchema.safeParse(value).data ?? null;
}

function xmlValues(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function xmlText(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") return text(String(value));
  return text(record(value)["#"]);
}

function xmlMoney(value: unknown): { value: string; currency: string } | null {
  const node = record(value);
  const amount = xmlText(value);
  const currency = text(node["@currencyID"]);
  return amount && currency ? { value: amount, currency } : null;
}

function validateEbayTradingXml(xml: string) {
  if (
    Buffer.byteLength(xml) > EBAY_TRADING_XML_MAX_BYTES ||
    xml.includes("\u0000") ||
    /<!DOCTYPE|<!ENTITY/i.test(xml)
  ) {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  }
  const openElements: string[] = [];
  let cursor = 0;
  let elements = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf("<", cursor);
    if (start === -1) break;
    if (xml.startsWith("<!--", start)) {
      const end = xml.indexOf("-->", start + 4);
      if (end === -1) throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", start)) {
      const end = xml.indexOf("]]>", start + 9);
      if (end === -1) throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<?", start)) {
      const end = xml.indexOf("?>", start + 2);
      if (end === -1) throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith("<!", start)) throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
    const closing = xml[start + 1] === "/";
    const nameStart = start + (closing ? 2 : 1);
    let nameEnd = nameStart;
    while (nameEnd < xml.length && !/[\s/>]/.test(xml[nameEnd]!)) nameEnd += 1;
    const name = xml.slice(nameStart, nameEnd);
    if (!name) throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
    let quote: "'" | '"' | null = null;
    let end = -1;
    for (let index = nameEnd; index < xml.length; index += 1) {
      const character = xml[index]!;
      if (quote) {
        if (character === "<") throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
        if (character === quote) quote = null;
      } else if (character === "'" || character === '"') quote = character;
      else if (character === "<") throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
      else if (character === ">") {
        end = index;
        break;
      }
    }
    if (quote || end === -1) throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
    if (closing) {
      if (xml.slice(nameEnd, end).trim() || openElements.pop() !== name) {
        throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
      }
    } else {
      elements += 1;
      if (elements > EBAY_TRADING_XML_MAX_ELEMENTS) {
        throw new AppError("PROVIDER_RESPONSE_TOO_LARGE", 502);
      }
      if (xml.slice(nameEnd, end).trimEnd().at(-1) !== "/") {
        openElements.push(name);
        if (openElements.length > EBAY_TRADING_XML_MAX_DEPTH) {
          throw new AppError("PROVIDER_RESPONSE_TOO_LARGE", 502);
        }
      }
    }
    cursor = end + 1;
  }
  if (openElements.length || elements === 0) {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  }
}

export function parseEbayTradingResponse(call: "GetOrders" | "GetSellerTransactions", xml: string) {
  validateEbayTradingXml(xml);
  let parsed: Record<string, unknown>;
  try {
    parsed = create(xml).end({ format: "object" }) as Record<string, unknown>;
  } catch {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  }
  const response = record(parsed[`${call}Response`]);
  const acknowledgement = xmlText(response.Ack);
  if (!response || !["Success", "Warning"].includes(acknowledgement ?? "")) {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  }
  return response;
}

export function ebayTradingHeaders(call: "GetOrders" | "GetSellerTransactions", token: string) {
  return {
    "Content-Type": "text/xml; charset=utf-8",
    "X-EBAY-API-CALL-NAME": call,
    "X-EBAY-API-COMPATIBILITY-LEVEL": EBAY_TRADING_API_COMPATIBILITY_LEVEL,
    "X-EBAY-API-SITEID": EBAY_TRADING_SITE_ID,
    "X-EBAY-API-IAF-TOKEN": token,
  };
}

function tradingRequest(
  call: "GetOrders" | "GetSellerTransactions",
  fields: Record<string, unknown>,
) {
  return create({ version: "1.0", encoding: "utf-8" })
    .ele({ [`${call}Request`]: { "@xmlns": "urn:ebay:apis:eBLBaseComponents", ...fields } })
    .end({ prettyPrint: false });
}

function tradingEndpoint(environment: "sandbox" | "production") {
  return environment === "sandbox"
    ? "https://api.sandbox.ebay.com/ws/api.dll"
    : "https://api.ebay.com/ws/api.dll";
}

async function ebayTradingCall(
  environment: "sandbox" | "production",
  token: string,
  call: "GetOrders" | "GetSellerTransactions",
  fields: Record<string, unknown>,
) {
  const xml = await providerText(tradingEndpoint(environment), {
    method: "POST",
    headers: ebayTradingHeaders(call, token),
    body: tradingRequest(call, fields),
  });
  return parseEbayTradingResponse(call, xml);
}

function netDeliveryAmount(pricing: Record<string, unknown>, currency: string): string {
  const cost = money(pricing.deliveryCost);
  const discount = money(pricing.deliveryDiscount);
  if ((cost && cost.currency !== currency) || (discount && discount.currency !== currency)) {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  }
  try {
    const costCents = decimalToCents(cost?.value ?? "0.00");
    const discountCents = Math.abs(decimalToCents(discount?.value ?? "0.00"));
    const netCents = costCents - discountCents;
    if (netCents < 0) throw new Error("Sconto spedizione superiore al costo");
    return (netCents / 100).toFixed(2);
  } catch {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  }
}

function refundId(refund: Record<string, unknown>): string | undefined {
  return text(refund.refundId) ?? text(refund.refundReferenceId);
}

function exactShippingRefundIds(
  paymentRefunds: Record<string, unknown>[],
  lineRefunds: Record<string, unknown>[],
  shippingAmount: string,
  currency: string,
): Set<string> {
  const shippingCents = decimalToCents(shippingAmount);
  if (shippingCents <= 0) return new Set();

  return new Set(
    paymentRefunds.flatMap((paymentRefund) => {
      const id = refundId(paymentRefund);
      if (!id || paymentRefund.refundStatus !== "REFUNDED") return [];
      const matchingLineRefunds = lineRefunds.filter((lineRefund) => refundId(lineRefund) === id);
      if (!matchingLineRefunds.length) return [];
      try {
        const lineRefundCents = matchingLineRefunds.reduce((sum, lineRefund) => {
          const amount = money(lineRefund.amount);
          if (!amount || amount.currency !== currency) throw new Error("Importo riga assente");
          return sum + decimalToCents(amount.value);
        }, 0);
        return lineRefundCents === shippingCents ? [id] : [];
      } catch {
        return [];
      }
    }),
  );
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
    header = record(JSON.parse(Buffer.from(signatureHeader, "base64").toString()));
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
  const recipient = splitEbayCareOfRecipient(shipTo.fullName, address.addressLine2);
  const fullName = recipient.fullName;
  const privateItalianName =
    !companyName &&
    fullName &&
    declaredTaxType === "CODICE_FISCALE" &&
    countryCode === "IT" &&
    taxpayerId
      ? splitTwoPartNameUsingFiscalCode(fullName, taxpayerId)
      : null;
  const buyerId = text(buyer.username) ?? text(buyer.userId);
  const lineItems = records(order.lineItems);
  const sourceIdentityIds = lineItems.map((line) => {
    const lineItemId = text(line.lineItemId);
    const legacyItemId = text(line.legacyItemId);
    if (!lineItemId || !legacyItemId) throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
    return `${legacyItemId}-${lineItemId}`;
  });
  const payments = records(record(order.paymentSummary).payments);
  const paymentRefunds = records(record(order.paymentSummary).refunds);
  const lineRefunds = lineItems.flatMap((line) => records(line.refunds));
  const shippingAmount = netDeliveryAmount(pricing, total.currency);
  const resolvedShippingRefundIds = exactShippingRefundIds(
    paymentRefunds,
    lineRefunds,
    shippingAmount,
    total.currency,
  );
  const paymentRefundIds = new Set(
    paymentRefunds.map(refundId).filter((refundId): refundId is string => Boolean(refundId)),
  );
  // eBay può ripetere lo stesso rimborso sulle righe senza ID o data, oltre al record
  // autorevole nel riepilogo pagamento. Conserviamo però un eventuale record di riga
  // con un proprio ID non presente nel riepilogo, perché rappresenta un evento distinto.
  const refunds = [
    ...paymentRefunds,
    ...lineRefunds.filter((refund) => {
      if (!paymentRefunds.length) return true;
      const id = refundId(refund);
      return Boolean(id && !paymentRefundIds.has(id));
    }),
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
    shippingAmount,
    paymentStatus: ["FULLY_REFUNDED", "REFUNDED"].includes(paymentStatus)
      ? "REFUNDED"
      : ["PAID", "PARTIALLY_REFUNDED"].includes(paymentStatus)
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
    sourceIdentityIds,
    sourceSnapshot: order,
    customer: {
      kind: customerKindFromCountry(countryCode, Boolean(companyName)),
      displayName: companyName ?? fullName ?? buyerId,
      firstName: privateItalianName?.firstName,
      lastName: privateItalianName?.lastName,
      companyName,
      email: text(shipTo.email),
      phone: text(shipTo.primaryPhone?.toString()),
      billingAddress: {
        line1: text(address.addressLine1),
        line2: recipient.addressLine2,
        postalCode: text(address.postalCode),
        city: text(address.city),
        province: text(address.stateOrProvince),
        countryCode,
      },
      shippingAddress: {
        line1: text(address.addressLine1),
        line2: recipient.addressLine2,
        postalCode: text(address.postalCode),
        city: text(address.city),
        province: text(address.stateOrProvince),
        countryCode,
      },
      taxIdentifiers,
    },
    lines: lineItems.map((line) => {
      const gross = money(line.lineItemCost);
      const discounted = money(line.discountedLineItemCost) ?? gross;
      if (!gross || !discounted) {
        throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
      }
      const discount = Math.max(
        0,
        Math.round((Number(gross.value) - Number(discounted.value)) * 100),
      );
      return {
        externalLineId: text(line.lineItemId)!,
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
    refunds: refunds.map((refund, index) => {
      const id = refundId(refund);
      const resolvedShippingRefund = Boolean(id && resolvedShippingRefundIds.has(id));
      return {
        externalRefundId: id ?? `${orderId}-refund-${index + 1}`,
        // L'importo nel riepilogo eBay è il netto venditore. Diventa fiscalmente
        // utilizzabile solo quando le quote cliente sulle righe ricostruiscono
        // esattamente l'intera spedizione netta dell'ordine.
        status: resolvedShippingRefund ? ("COMPLETED" as const) : ("AMBIGUOUS" as const),
        amount: resolvedShippingRefund ? shippingAmount : null,
        completedAt: text(refund.refundDate) ?? null,
        raw: refund,
      };
    }),
  });
}

export function ebayListingMarketplaceId(payload: unknown): string {
  const marketplaces = new Set(
    records(record(payload).lineItems).flatMap((line) => {
      const marketplace = text(line.listingMarketplaceId);
      return marketplace ? [marketplace] : [];
    }),
  );
  if (marketplaces.size !== 1) throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  const marketplace = [...marketplaces][0]!;
  if (!/^EBAY_[A-Z0-9_]+$/.test(marketplace)) {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  }
  return marketplace;
}

export function ebayTradingOrderIsActive(payload: unknown) {
  return xmlText(record(payload).OrderStatus) === "Active";
}

function ebayTradingOrderIsCancelled(payload: unknown) {
  return xmlText(record(payload).OrderStatus) === "Cancelled";
}

export function ebayTradingOrderIsImportable(payload: unknown) {
  return ebayTradingOrderIsActive(payload) || ebayTradingOrderIsCancelled(payload);
}

export function ebayTradingModificationWindows(start: string, end: string) {
  const startTime = Date.parse(start);
  const endTime = Date.parse(end);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime > endTime) {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  }
  const windows: Array<{ start: string; end: string }> = [];
  let windowStart = startTime;
  while (windowStart <= endTime) {
    const windowEnd = Math.min(windowStart + EBAY_TRADING_MAX_MOD_WINDOW_MS, endTime);
    windows.push({
      start: new Date(windowStart).toISOString(),
      end: new Date(windowEnd).toISOString(),
    });
    if (windowEnd === endTime) break;
    windowStart = windowEnd;
  }
  return windows;
}

function tradingTransactionPending(transaction: Record<string, unknown>) {
  const status = record(transaction.Status);
  return !(
    xmlText(status.CheckoutStatus) === "CheckoutComplete" &&
    xmlText(status.CompleteStatus) === "Complete" &&
    xmlText(status.eBayPaymentStatus) === "NoPaymentFailure"
  );
}

export function ebayTradingPendingLineId(payload: unknown) {
  const transaction = record(payload);
  if (!tradingTransactionPending(transaction)) return null;
  const lineId = xmlText(transaction.OrderLineItemID);
  if (!lineId) throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  return lineId;
}

function tradingOrders(response: Record<string, unknown>) {
  return xmlValues(record(response.OrderArray).Order).flatMap((value) => {
    const order = record(value);
    return ebayTradingOrderIsActive(order) ? [order] : [];
  });
}

function tradingTransactions(response: Record<string, unknown>) {
  return xmlValues(record(response.TransactionArray).Transaction).map(record);
}

export function mapEbayTradingOrder(payload: unknown, accountReference: string): OrderInput {
  const order = record(payload);
  const orderStatus = xmlText(order.OrderStatus);
  const orderId = xmlText(order.OrderID) ?? xmlText(order.ExtendedOrderID);
  const transactions = xmlValues(record(order.TransactionArray).Transaction).map(record);
  const total = xmlMoney(order.Total);
  const createdAt =
    xmlText(order.CreatedTime) ??
    transactions.map((item) => xmlText(item.CreatedDate)).find(Boolean);
  const updatedAt = xmlText(record(order.CheckoutStatus).LastModifiedTime) ?? createdAt;
  if (
    !orderId ||
    !transactions.length ||
    !total ||
    !createdAt ||
    !updatedAt ||
    !["Active", "Cancelled"].includes(orderStatus ?? "")
  ) {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  }
  const shipping = xmlMoney(record(order.ShippingServiceSelected).ShippingServiceCost);
  if (shipping && shipping.currency !== total.currency) {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  }
  const address = record(order.ShippingAddress);
  const buyerId = xmlText(order.BuyerUserID);
  const companyName = xmlText(address.CompanyName);
  const fullName = xmlText(address.Name);
  const countryCode = xmlText(address.Country);
  const sourceIdentityIds = transactions.map((transaction) => {
    const lineItemId = xmlText(transaction.OrderLineItemID);
    if (!lineItemId) throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
    return lineItemId;
  });
  return providerOrder({
    provider: "EBAY",
    externalAccountId: accountReference,
    externalOrderId: orderId,
    externalCustomerId: buyerId,
    displayNumber: orderId,
    createdAt,
    updatedAt,
    currency: total.currency,
    total: total.value,
    shippingAmount: shipping?.value ?? "0.00",
    paymentStatus: "PENDING",
    fulfillmentStatus: "UNFULFILLED",
    cancelledAt: orderStatus === "Cancelled" ? updatedAt : null,
    sourceReviewRequired: orderStatus === "Active",
    sourceIdentityIds,
    sourceSnapshot: { sourceApi: "EBAY_TRADING", call: "GetOrders", payload: order },
    customer: {
      kind: customerKindFromCountry(countryCode, Boolean(companyName)),
      displayName: companyName ?? fullName ?? buyerId,
      companyName,
      billingAddress: {
        line1: xmlText(address.Street1),
        line2: xmlText(address.Street2),
        postalCode: xmlText(address.PostalCode),
        city: xmlText(address.CityName),
        province: xmlText(address.StateOrProvince),
        countryCode,
      },
      shippingAddress: {
        line1: xmlText(address.Street1),
        line2: xmlText(address.Street2),
        postalCode: xmlText(address.PostalCode),
        city: xmlText(address.CityName),
        province: xmlText(address.StateOrProvince),
        countryCode,
      },
      taxIdentifiers: [],
    },
    lines: transactions.map((transaction, index) => {
      const quantity = Number(xmlText(transaction.QuantityPurchased) ?? "1");
      const unitPrice = xmlMoney(transaction.TransactionPrice);
      if (
        !Number.isInteger(quantity) ||
        quantity <= 0 ||
        !unitPrice ||
        unitPrice.currency !== total.currency
      ) {
        throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
      }
      let grossAmount: string;
      try {
        grossAmount = ((decimalToCents(unitPrice.value) * quantity) / 100).toFixed(2);
      } catch {
        throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
      }
      return {
        externalLineId: sourceIdentityIds[index]!,
        description: xmlText(record(transaction.Item).Title) ?? "Articolo eBay",
        quantity,
        grossAmount,
        discountAmount: "0.00",
      };
    }),
    payments: [],
    refunds: [],
  });
}

async function fetchEbayTradingPendingOrders(
  environment: "sandbox" | "production",
  token: string,
  accountReference: string,
  start: string,
  end: string,
) {
  const observed = new Map<string, OrderInput>();
  const activeLineIds = new Set<string>();
  for (let page = 1; page <= EBAY_TRADING_MAX_PAGES; page += 1) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const response = await ebayTradingCall(environment, token, "GetOrders", {
      DetailLevel: "ReturnAll",
      OrderRole: "Seller",
      OrderStatus: "Active",
      NumberOfDays: "30",
      Pagination: { EntriesPerPage: String(EBAY_TRADING_PAGE_SIZE), PageNumber: String(page) },
    });
    const orders = tradingOrders(response).map((order) =>
      mapEbayTradingOrder(order, accountReference),
    );
    for (const order of orders) {
      observed.set(order.externalOrderId, order);
      for (const line of order.lines) activeLineIds.add(line.externalLineId);
    }
    if (xmlText(response.HasMoreOrders) !== "true") break;
    if (page === EBAY_TRADING_MAX_PAGES) {
      throw new AppError("PROVIDER_RESPONSE_TOO_LARGE", 502);
    }
  }

  const missingLineIds = new Set<string>();
  for (const modificationWindow of ebayTradingModificationWindows(start, end)) {
    for (let page = 1; page <= EBAY_TRADING_MAX_PAGES; page += 1) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const response = await ebayTradingCall(environment, token, "GetSellerTransactions", {
        DetailLevel: "ReturnAll",
        IncludeContainingOrder: "true",
        ModTimeFrom: modificationWindow.start,
        ModTimeTo: modificationWindow.end,
        Pagination: { EntriesPerPage: String(EBAY_TRADING_PAGE_SIZE), PageNumber: String(page) },
      });
      for (const transaction of tradingTransactions(response)) {
        const lineId = ebayTradingPendingLineId(transaction);
        if (lineId && !activeLineIds.has(lineId)) missingLineIds.add(lineId);
      }
      if (xmlText(response.HasMoreTransactions) !== "true") break;
      if (page === EBAY_TRADING_MAX_PAGES) {
        throw new AppError("PROVIDER_RESPONSE_TOO_LARGE", 502);
      }
    }
  }

  const missing = [...missingLineIds];
  for (let offset = 0; offset < missing.length; offset += 20) {
    const requested = missing.slice(offset, offset + 20);
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const response = await ebayTradingCall(environment, token, "GetOrders", {
      DetailLevel: "ReturnAll",
      OrderRole: "Seller",
      OrderIDArray: { OrderID: requested },
    });
    const targetedOrders = xmlValues(record(response.OrderArray).Order).map(record);
    for (const targeted of targetedOrders) {
      for (const transaction of xmlValues(record(targeted.TransactionArray).Transaction).map(
        record,
      )) {
        const lineId = xmlText(transaction.OrderLineItemID);
        if (lineId) missingLineIds.delete(lineId);
      }
      if (!ebayTradingOrderIsImportable(targeted)) continue;
      const order = mapEbayTradingOrder(targeted, accountReference);
      observed.set(order.externalOrderId, order);
    }
  }
  if (missingLineIds.size) throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  return [...observed.values()];
}

export function mergeEbayOrderObservations(
  tradingOrders: OrderInput[],
  fulfillmentOrders: OrderInput[],
) {
  const canonicalIdentityIds = new Set(
    fulfillmentOrders.flatMap((order) => order.sourceIdentityIds),
  );
  const provisionalOrders = tradingOrders.filter((order) => {
    const matchedIdentities = order.sourceIdentityIds.filter((identity) =>
      canonicalIdentityIds.has(identity),
    ).length;
    if (matchedIdentities > 0 && matchedIdentities !== order.sourceIdentityIds.length) {
      throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
    }
    return matchedIdentities === 0;
  });
  return { orders: [...provisionalOrders, ...fulfillmentOrders], provisionalOrders };
}

export function ebayFulfillmentHeaders(token: string, marketplaceId?: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    ...(marketplaceId ? { "X-EBAY-C-MARKETPLACE-ID": marketplaceId } : {}),
  };
}

async function fetchOrder(
  environment: "sandbox" | "production",
  token: string,
  orderId: string,
  marketplaceId: string,
) {
  return providerJson(
    `${environmentBase(environment)}/sell/fulfillment/${EBAY_FULFILLMENT_API_VERSION}/order/${encodeURIComponent(orderId)}?fieldGroups=TAX_BREAKDOWN`,
    { headers: ebayFulfillmentHeaders(token, marketplaceId) },
  );
}

const ebaySyncContinuationSchema = z.object({
  kind: z.literal("EBAY_ORDERS_PAGE"),
  end: z.iso.datetime(),
  next: z.string().min(1),
});

type EbaySyncContinuation = z.infer<typeof ebaySyncContinuationSchema>;

export function parseEbaySyncContinuation(value: string | null) {
  if (!value) return null;
  try {
    return ebaySyncContinuationSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}

async function fetchOrdersBatch(
  start: string,
  continuation: EbaySyncContinuation | null = null,
  includeTrading = true,
) {
  const connection = await loadConnection<EbayCredentials>("EBAY");
  const environment = connection.environment === "SANDBOX" ? "sandbox" : "production";
  const token = await accessToken(environment, connection.credentials.refreshToken);
  const end = continuation?.end ?? new Date().toISOString();
  const fulfillmentOrders: OrderInput[] = [];
  const tradingOrders = includeTrading
    ? await fetchEbayTradingPendingOrders(
        environment,
        token,
        connection.accountReference,
        start,
        end,
      )
    : [];
  let url: string | null = continuation
    ? ebayNextUrl(environment, continuation.next)
    : `${environmentBase(environment)}/sell/fulfillment/${EBAY_FULFILLMENT_API_VERSION}/order?` +
      new URLSearchParams({
        filter: `lastmodifieddate:[${start}..${end}]`,
        fieldGroups: "TAX_BREAKDOWN",
        limit: "50",
      });
  for (let page = 0; url && page < 20; page += 1) {
    const response = await providerJson(url, {
      headers: ebayFulfillmentHeaders(token),
    });
    for (const summary of records(response.orders)) {
      const orderId = text(summary.orderId);
      if (!orderId) throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
      const marketplaceId = ebayListingMarketplaceId(summary);
      // Tax identifier is contractually present only on getOrder; la sequenza evita burst di 50 richieste.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const detail = await fetchOrder(environment, token, orderId, marketplaceId);
      fulfillmentOrders.push(mapEbayOrder(detail, connection.accountReference));
    }
    url = ebayNextUrl(environment, response.next);
  }
  const merged = mergeEbayOrderObservations(tradingOrders, fulfillmentOrders);
  return {
    connection,
    end,
    orders: merged.orders,
    pendingCount: merged.provisionalOrders.length,
    continuation: url ? { kind: "EBAY_ORDERS_PAGE" as const, end, next: url } : null,
  };
}

async function fetchOrdersSince(start: string) {
  const result = await fetchOrdersBatch(start, null, false);
  if (result.continuation) throw new AppError("PROVIDER_RESPONSE_TOO_LARGE", 502);
  return result;
}

export async function syncEbayOrders(job?: ClaimedJob) {
  if (await historyImportPending("EBAY")) throw new AppError("CONFLICT_REVISION", 409);
  const cursor = await readCursor("EBAY");
  const start = cursor.overlapFrom ?? new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const currentContinuation = parseEbaySyncContinuation(cursor.cursor);
  const { end, orders, pendingCount, continuation } = await fetchOrdersBatch(
    start,
    currentContinuation,
    !currentContinuation,
  );
  if (job && !(await jobLeaseCurrent(job))) throw new AppError("CONFLICT_REVISION", 409);
  if (orders.length) {
    await importOrders(orders, { type: "SYSTEM", requestId: `ebay-sync:${end}` }, job);
  }
  await writeCursor(
    "EBAY",
    continuation ? JSON.stringify(continuation) : end,
    continuation ? start : new Date(Date.parse(end) - OVERLAP_MS).toISOString(),
    job,
  );
  if (!continuation) await markConnectionSynced("EBAY", job);
  return {
    count: orders.length,
    pendingCount,
    from: start,
    to: end,
    hasMore: Boolean(continuation),
  };
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
  const completed = job ? await completedHistoryImportResult("EBAY", job) : null;
  if (completed) return completed;
  if (job) {
    const expectedAccount = job.payload.accountReference;
    const currentAccount = await loadConnection<unknown>("EBAY");
    if (
      typeof expectedAccount !== "string" ||
      currentAccount.accountReference !== expectedAccount
    ) {
      return { count: 0, reviewRequired: 0, imported: 0, updated: 0, ignored: 0 };
    }
  }
  if (!(await historyImportPending("EBAY"))) throw new AppError("CONFLICT_REVISION", 409);
  const { connection, end, orders } = await ebayHistory(startDate);
  const reviewRequired = orders.filter((order) => order.refunds.length).length;
  const result = await importOrders(orders, actor, job, {
    provider: "EBAY",
    accountReference: connection.accountReference,
    cursor: end,
    overlapFrom: new Date(Date.parse(end) - OVERLAP_MS).toISOString(),
    count: orders.length,
    reviewRequired,
  });
  return {
    ...result,
    count: orders.length,
    reviewRequired,
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
    payload = record(JSON.parse(body.toString("utf8")));
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
