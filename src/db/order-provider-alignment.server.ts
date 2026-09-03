import type pg from "pg";

import { isEbayCareOfAddressMapperOnlyChange } from "../order-source-alignment.ts";
import { reconcileEbayCustomerAlignment } from "./order-ebay-customer-alignment.server.ts";
import { reconcileEbayPaymentTimestampChange } from "./order-ebay-payment-alignment.server.ts";
import { reconcileExistingEbayRefundMapperConflict } from "./order-ebay-refund-alignment.server.ts";
import { reconcileShopifyFulfillmentChange } from "./order-shopify-fulfillment-alignment.server.ts";

type EbayInput = Parameters<typeof reconcileExistingEbayRefundMapperConflict>[1];
type ShopifyInput = Parameters<typeof reconcileShopifyFulfillmentChange>[1];
type PreviousOrder =
  | (NonNullable<EbayInput["oldOrder"]> &
      NonNullable<ShopifyInput["oldOrder"]> & {
        billing_case_customer_snapshot_json: Record<string, unknown> | null;
        billing_case_customer_corrected: boolean;
      })
  | undefined;

export async function reconcileProviderOrderAlignment(
  client: pg.PoolClient,
  input: {
    provider: string;
    documentIssued: boolean;
    oldOrder: PreviousOrder;
    fingerprint: string;
    orderId: string;
    customerId: string;
    requestId: string;
    normalizedSnapshot: Record<string, unknown>;
    fingerprintChanged: boolean;
  },
) {
  if (input.provider === "EBAY") {
    const careOfAddress = Boolean(
      !input.documentIssued &&
      input.fingerprintChanged &&
      input.oldOrder?.billing_case_id &&
      input.oldOrder.billing_case_customer_snapshot_json &&
      !input.oldOrder.billing_case_customer_corrected &&
      isEbayCareOfAddressMapperOnlyChange(
        input.oldOrder.last_observed_snapshot_json,
        input.normalizedSnapshot,
      ) &&
      (await reconcileEbayCustomerAlignment(client, {
        caseId: input.oldOrder.billing_case_id,
        orderId: input.orderId,
        customerId: input.customerId,
        customerSnapshot: input.normalizedSnapshot.customerSnapshot as Record<string, unknown>,
        requestId: input.requestId,
        clearExistingConflict: false,
        alignment: "CARE_OF_ADDRESS",
      })),
    );
    return {
      refundMapper: await reconcileExistingEbayRefundMapperConflict(client, input),
      careOfAddress,
      paymentTimestamp: await reconcileEbayPaymentTimestampChange(client, input),
      shopifyFulfillment: false,
    };
  }
  if (input.provider === "SHOPIFY") {
    return {
      refundMapper: false,
      careOfAddress: false,
      paymentTimestamp: false,
      shopifyFulfillment: await reconcileShopifyFulfillmentChange(client, input),
    };
  }
  return {
    refundMapper: false,
    careOfAddress: false,
    paymentTimestamp: false,
    shopifyFulfillment: false,
  };
}
