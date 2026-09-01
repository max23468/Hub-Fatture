import type pg from "pg";

import { reconcileExistingEbayRefundMapperConflict } from "./order-ebay-refund-alignment.server.ts";
import { reconcileShopifyFulfillmentChange } from "./order-shopify-fulfillment-alignment.server.ts";

type EbayInput = Parameters<typeof reconcileExistingEbayRefundMapperConflict>[1];
type ShopifyInput = Parameters<typeof reconcileShopifyFulfillmentChange>[1];
type PreviousOrder =
  | (NonNullable<EbayInput["oldOrder"]> & NonNullable<ShopifyInput["oldOrder"]>)
  | undefined;

export async function reconcileProviderOrderAlignment(
  client: pg.PoolClient,
  input: {
    provider: string;
    documentIssued: boolean;
    oldOrder: PreviousOrder;
    fingerprint: string;
    orderId: string;
    requestId: string;
    normalizedSnapshot: Record<string, unknown>;
    fingerprintChanged: boolean;
  },
) {
  if (input.provider === "EBAY") {
    return {
      refundMapper: await reconcileExistingEbayRefundMapperConflict(client, input),
      shopifyFulfillment: false,
    };
  }
  if (input.provider === "SHOPIFY") {
    return {
      refundMapper: false,
      shopifyFulfillment: await reconcileShopifyFulfillmentChange(client, input),
    };
  }
  return { refundMapper: false, shopifyFulfillment: false };
}
