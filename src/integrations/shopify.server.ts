import "@shopify/shopify-api/adapters/web-api";

import { createHash } from "node:crypto";

import { ApiVersion, DeliveryMethod, shopifyApi } from "@shopify/shopify-api";
import { z } from "zod";

import { getConfig } from "../config.server.ts";
import {
  ingestShopifyWebhook,
  loadConnection,
  markConnectionSynced,
  processShopifyPrivacyRecord,
  recordShopifyDataRequest,
  readCursor,
  revokeConnection,
  saveConnection,
  writeCursor,
} from "../db/connectors.server.ts";
import { importOrders } from "../db/order-import.server.ts";
import { AppError } from "../errors.ts";
import type { OrderInput } from "../orders.ts";
import { providerJson } from "./provider-http.server.ts";
import { providerOrder } from "./provider-order.ts";

export const SHOPIFY_API_VERSION = "2026-07";
export const SHOPIFY_API_SUPPORTED_UNTIL = "2027-07-16";
export const SHOPIFY_SCOPES = ["read_orders", "read_customers"] as const;
const OVERLAP_MS = 5 * 60 * 1000;

interface ShopifyCredentials {
  accessToken: string;
  scope: string;
}

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

function nodes(value: unknown): Record<string, unknown>[] {
  return records(record(value).nodes);
}

export function shopifyGraphqlError(errors: unknown): AppError | null {
  const codes = records(errors).map((error) => record(error.extensions).code);
  if (codes.includes("THROTTLED")) return new AppError("PROVIDER_RATE_LIMITED", 429);
  if (codes.includes("ACCESS_DENIED")) return new AppError("AUTH_PROVIDER_EXPIRED", 401);
  return null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function shopMoney(value: unknown) {
  const money = record(record(value).shopMoney);
  const amount = text(money.amount);
  const currency = text(money.currencyCode);
  return amount && currency ? { amount, currency } : null;
}

function configValues() {
  const config = getConfig();
  if (!config.SHOPIFY_API_KEY || !config.SHOPIFY_API_SECRET || !config.SHOPIFY_SHOP) {
    throw new AppError("PROVIDER_NOT_CONFIGURED", 503);
  }
  const base = new URL(config.APP_BASE_URL);
  return { config, base };
}

let shopifyInstance: ReturnType<typeof shopifyApi> | null = null;

function shopify() {
  if (shopifyInstance) return shopifyInstance;
  const { config, base } = configValues();
  shopifyInstance = shopifyApi({
    apiKey: config.SHOPIFY_API_KEY!,
    apiSecretKey: config.SHOPIFY_API_SECRET!,
    apiVersion: ApiVersion.July26,
    scopes: [...SHOPIFY_SCOPES],
    hostName: base.host,
    hostScheme: base.protocol === "https:" ? "https" : "http",
    isEmbeddedApp: false,
  });
  shopifyInstance.webhooks.addHandlers(
    Object.fromEntries(
      [
        "APP_UNINSTALLED",
        "CUSTOMERS_DATA_REQUEST",
        "CUSTOMERS_REDACT",
        "ORDERS_CANCELLED",
        "ORDERS_CREATE",
        "ORDERS_PAID",
        "ORDERS_UPDATED",
        "REFUNDS_CREATE",
        "SHOP_REDACT",
      ].map((topic) => [
        topic,
        { deliveryMethod: DeliveryMethod.Http, callbackUrl: "/webhooks/shopify" },
      ]),
    ),
  );
  return shopifyInstance;
}

export async function beginShopifyOAuth(request: Request) {
  const { config } = configValues();
  return shopify().auth.begin({
    shop: config.SHOPIFY_SHOP!,
    callbackPath: "/integrations/shopify/callback",
    isOnline: false,
    rawRequest: request,
  });
}

export async function completeShopifyOAuth(request: Request) {
  const result = await shopify().auth.callback({ rawRequest: request });
  if (!result.session.accessToken) throw new AppError("AUTH_PROVIDER_EXPIRED", 401);
  await saveConnection({
    provider: "SHOPIFY",
    environment: getConfig().APP_ENV === "production" ? "PRODUCTION" : "DEVELOPMENT",
    accountReference: result.session.shop,
    credentials: {
      accessToken: result.session.accessToken,
      scope: result.session.scope ?? SHOPIFY_SCOPES.join(","),
    },
  });
  return result.headers;
}

function shopifyGid(resource: "Customer" | "Order", value: unknown): string | undefined {
  const identifier =
    typeof value === "number" && Number.isSafeInteger(value) ? String(value) : text(value);
  if (!identifier) return undefined;
  if (identifier.startsWith(`gid://shopify/${resource}/`)) return identifier;
  return /^\d+$/.test(identifier) ? `gid://shopify/${resource}/${identifier}` : undefined;
}

function mapTaxIdentifiers(order: Record<string, unknown>, customer: Record<string, unknown>) {
  const identifiers: {
    type: "CODICE_FISCALE" | "PARTITA_IVA" | "ALTRO";
    value: string;
    countryCode?: string;
    sourceField: string;
  }[] = [];
  for (const field of nodes(order.localizedFields)) {
    const value = text(field.value);
    const key = text(field.key)?.toUpperCase() ?? "";
    const purpose = text(field.purpose)?.toUpperCase() ?? "";
    const stableName = `${key}:${purpose}`;
    const type = /VAT/.test(stableName)
      ? "PARTITA_IVA"
      : /(FISCAL|CODICE|TAX_CREDENTIAL_IT)/.test(stableName)
        ? "CODICE_FISCALE"
        : undefined;
    if (!value || !type) continue;
    identifiers.push({
      type,
      value,
      countryCode: text(field.countryCode),
      sourceField: `localizedFields:${key}:${purpose}`,
    });
  }
  if (!identifiers.length) {
    const fallback = text(record(customer.taxSettings).taxId);
    if (fallback) {
      const normalized = fallback.toUpperCase().replace(/[^A-Z0-9]/g, "");
      identifiers.push({
        type:
          /^IT\d{11}$/.test(normalized) || /^\d{11}$/.test(normalized)
            ? "PARTITA_IVA"
            : /^[A-Z0-9]{16}$/.test(normalized)
              ? "CODICE_FISCALE"
              : "ALTRO",
        value: fallback,
        sourceField: "customer.taxSettings.taxId",
      });
    }
  }
  return identifiers;
}

export function mapShopifyOrder(payload: unknown, shop: string): OrderInput {
  const order = record(payload);
  const id = text(order.id);
  const createdAt = text(order.createdAt);
  const updatedAt = text(order.updatedAt);
  const total = shopMoney(order.totalPriceSet);
  if (!id || !createdAt || !updatedAt || !total) {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  }
  const customer = record(order.customer);
  const address = record(order.billingAddress);
  const countryCode = text(address.countryCodeV2);
  const companyName = text(address.company);
  const lineItems = nodes(order.lineItems);
  const transactions = records(order.transactions).filter((transaction) =>
    ["SALE", "CAPTURE"].includes(text(transaction.kind) ?? ""),
  );
  const refunds = records(order.refunds);
  const financialStatus = text(order.displayFinancialStatus) ?? "PENDING";
  return providerOrder({
    provider: "SHOPIFY",
    externalAccountId: shop,
    externalOrderId: id,
    externalCustomerId: text(customer.id),
    displayNumber: text(order.name) ?? id,
    createdAt,
    updatedAt,
    currency: total.currency,
    total: total.amount,
    shippingAmount: shopMoney(order.totalShippingPriceSet)?.amount ?? "0.00",
    paymentStatus:
      financialStatus === "REFUNDED"
        ? "REFUNDED"
        : financialStatus === "PAID" || financialStatus === "PARTIALLY_REFUNDED"
          ? "PAID"
          : "PENDING",
    fulfillmentStatus:
      order.displayFulfillmentStatus === "FULFILLED"
        ? "FULFILLED"
        : order.displayFulfillmentStatus === "PARTIALLY_FULFILLED"
          ? "PARTIAL"
          : "UNFULFILLED",
    cancelledAt: text(order.cancelledAt) ?? null,
    customer: {
      kind:
        countryCode === "IT"
          ? companyName
            ? "BUSINESS_IT"
            : "PRIVATE_IT"
          : countryCode
            ? "EU"
            : "UNKNOWN",
      displayName: text(customer.displayName) ?? text(address.name),
      firstName: text(customer.firstName),
      lastName: text(customer.lastName),
      companyName,
      email: text(record(customer.defaultEmailAddress).emailAddress),
      phone: text(record(customer.defaultPhoneNumber).phoneNumber) ?? text(address.phone),
      billingAddress: {
        line1: text(address.address1),
        line2: text(address.address2),
        postalCode: text(address.zip),
        city: text(address.city),
        province: text(address.provinceCode),
        countryCode,
      },
      taxIdentifiers: mapTaxIdentifiers(order, customer),
    },
    lines: lineItems.map((line) => {
      const original = shopMoney(line.originalTotalSet);
      const discounted = shopMoney(line.discountedTotalSet);
      if (!original || !discounted) throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
      const discount = Math.max(
        0,
        Math.round((Number(original.amount) - Number(discounted.amount)) * 100),
      );
      return {
        externalLineId: text(line.id),
        description: text(line.name) ?? "Articolo Shopify",
        quantity: Number(line.quantity),
        grossAmount: original.amount,
        discountAmount: (discount / 100).toFixed(2),
      };
    }),
    payments: transactions.map((transaction) => ({
      externalPaymentId: text(transaction.id),
      method: text(transaction.gateway) ?? "SHOPIFY",
      status: transaction.status === "SUCCESS" ? "PAID" : "PENDING",
      amount: shopMoney(transaction.amountSet)?.amount ?? "0.00",
      paidAt: text(transaction.processedAt) ?? null,
    })),
    refunds: refunds.map((refund) => {
      const refundTransactions = nodes(refund.transactions);
      const statuses = refundTransactions.map((transaction) => text(transaction.status));
      return {
        externalRefundId: text(refund.id),
        status: statuses.some((status) => status === "FAILURE")
          ? "FAILED"
          : statuses.length && statuses.every((status) => status === "SUCCESS")
            ? "COMPLETED"
            : "PENDING",
        amount: shopMoney(refund.totalRefundedSet)?.amount ?? null,
        completedAt: text(refund.processedAt) ?? null,
        raw: refund,
      };
    }),
  });
}

function orderFields() {
  return `
    id name createdAt updatedAt cancelledAt currencyCode
    displayFinancialStatus displayFulfillmentStatus
    totalPriceSet { shopMoney { amount currencyCode } }
    totalShippingPriceSet { shopMoney { amount currencyCode } }
    localizedFields(first: 20) { nodes { key countryCode purpose title value } }
    customer {
      id displayName firstName lastName
      defaultEmailAddress { emailAddress }
      defaultPhoneNumber { phoneNumber }
      taxSettings { taxId }
    }
    billingAddress { name company address1 address2 zip city provinceCode countryCodeV2 phone }
    lineItems(first: 100) {
      nodes { id name quantity originalTotalSet { shopMoney { amount currencyCode } }
        discountedTotalSet { shopMoney { amount currencyCode } } }
    }
    transactions { id kind status gateway processedAt amountSet { shopMoney { amount currencyCode } } }
    refunds {
      id processedAt totalRefundedSet { shopMoney { amount currencyCode } }
      transactions(first: 20) { nodes { id status } }
    }
  `;
}

async function graphql<T>(operation: string, variables: Record<string, unknown>) {
  const connection = await loadConnection<ShopifyCredentials>("SHOPIFY");
  const response = await providerJson(
    `https://${connection.accountReference}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": connection.credentials.accessToken,
      },
      body: JSON.stringify({ query: operation, variables }),
    },
  );
  const responseError = shopifyGraphqlError(response.errors);
  if (responseError) throw responseError;
  if (response.errors || !response.data || typeof response.data !== "object") {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  }
  return { connection, data: response.data as T };
}

export async function fetchShopifyOrder(orderId: string) {
  const result = await graphql<{ order: unknown }>(
    `query HubFattureOrder($id: ID!) { order(id: $id) { ${orderFields()} } }`,
    { id: orderId },
  );
  if (!result.data?.order) throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  return mapShopifyOrder(result.data.order, result.connection.accountReference);
}

async function fetchOrdersSince(start: string) {
  interface OrdersPage {
    orders: {
      nodes: unknown[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  }
  const orders: OrderInput[] = [];
  let cursor: string | null = null;
  let connectionReference = "";
  for (let page = 0; page < 20; page += 1) {
    const result: {
      connection: { accountReference: string };
      data: OrdersPage | undefined;
    } = await graphql<OrdersPage>(
      `query HubFattureOrders($after: String, $query: String!) {
        orders(first: 50, after: $after, sortKey: UPDATED_AT, query: $query) {
          nodes { ${orderFields()} }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { after: cursor, query: shopifyUpdatedAtQuery(start) },
    );
    connectionReference = result.connection.accountReference;
    const pageData: OrdersPage["orders"] | undefined = result.data?.orders;
    if (!pageData) throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
    orders.push(...pageData.nodes.map((order) => mapShopifyOrder(order, connectionReference)));
    if (!pageData.pageInfo.hasNextPage) return orders;
    cursor = pageData.pageInfo.endCursor;
    if (!cursor) throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  }
  throw new AppError("PROVIDER_RESPONSE_TOO_LARGE", 502);
}

export function shopifyUpdatedAtQuery(start: string) {
  return `updated_at:>='${start}'`;
}

export async function syncShopifyOrders() {
  const cursor = await readCursor("SHOPIFY");
  const start = cursor.overlapFrom ?? new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const end = new Date().toISOString();
  const orders = await fetchOrdersSince(start);
  if (orders.length) {
    await importOrders(orders, { type: "SYSTEM", requestId: `shopify-sync:${end}` });
  }
  await writeCursor("SHOPIFY", end, new Date(Date.parse(end) - OVERLAP_MS).toISOString());
  await markConnectionSynced("SHOPIFY");
  return { count: orders.length, from: start, to: end };
}

export async function previewShopifyHistory(days = 7) {
  const safeDays = Math.min(7, Math.max(1, Math.trunc(days)));
  const orders = await fetchOrdersSince(new Date(Date.now() - safeDays * 86_400_000).toISOString());
  return {
    count: orders.length,
    reviewRequired: orders.filter((order) => order.refunds.length).length,
  };
}

export async function processShopifyWebhook(request: Request, rawBody: Buffer) {
  const validation = await shopify().webhooks.validate({
    rawBody: rawBody.toString("utf8"),
    rawRequest: request,
  });
  if (!validation.valid) throw new AppError("WEBHOOK_SIGNATURE_INVALID", 401);
  const payloadHash = createHash("sha256").update(rawBody).digest("hex");
  let payload: Record<string, unknown>;
  try {
    payload = recordSchema.parse(JSON.parse(rawBody.toString("utf8")));
  } catch {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 400);
  }
  if (validation.topic === "APP_UNINSTALLED") await revokeConnection("SHOPIFY");
  const externalEventId = validation.eventId ?? validation.webhookId ?? payloadHash;
  if (
    validation.topic === "CUSTOMERS_DATA_REQUEST" ||
    validation.topic === "CUSTOMERS_REDACT" ||
    validation.topic === "SHOP_REDACT"
  ) {
    const customer = record(payload.customer);
    const customerIds = [payload.customer_id, customer.id].flatMap((value) => {
      const identifier = shopifyGid("Customer", value);
      return identifier ? [identifier] : [];
    });
    const orderIds = (
      Array.isArray(payload.orders_requested) ? payload.orders_requested : []
    ).flatMap((value) => {
      const identifier = shopifyGid("Order", value);
      return identifier ? [identifier] : [];
    });
    if (validation.topic === "CUSTOMERS_DATA_REQUEST") {
      if (!customerIds.length && !orderIds.length) {
        throw new AppError("PROVIDER_RESPONSE_INVALID", 400);
      }
      return recordShopifyDataRequest({
        externalEventId,
        payloadSha256: payloadHash,
        customerIds,
        orderIds,
      });
    }
    if (validation.topic === "CUSTOMERS_REDACT" && !customerIds.length) {
      throw new AppError("PROVIDER_RESPONSE_INVALID", 400);
    }
    return processShopifyPrivacyRecord({
      externalEventId,
      topic: validation.topic,
      payloadSha256: payloadHash,
      customerIds,
    });
  }
  const orderResourceId = validation.topic.startsWith("ORDERS_")
    ? (text(payload.admin_graphql_api_id) ??
      (payload.id ? `gid://shopify/Order/${String(payload.id)}` : null))
    : payload.order_id
      ? `gid://shopify/Order/${String(payload.order_id)}`
      : null;
  return ingestShopifyWebhook({
    externalEventId,
    topic: validation.topic,
    payloadSha256: payloadHash,
    orderId:
      validation.topic.startsWith("ORDERS_") ||
      validation.topic.startsWith("REFUNDS_") ||
      validation.topic.startsWith("FULFILLMENTS_")
        ? orderResourceId
        : null,
  });
}
