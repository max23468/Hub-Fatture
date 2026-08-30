import type pg from "pg";

import { draftTriggerSchema, shopifyPaymentFeeModeSchema } from "../orders.ts";

export async function currentOrderSettings(client: pg.PoolClient) {
  const result = await client.query<{ key: string; value_json: unknown }>(
    `SELECT key, value_json FROM settings
     WHERE key IN ('draft_trigger', 'shopify_payment_fee_mode')`,
  );
  const settings = new Map(result.rows.map((row) => [row.key, row.value_json]));
  return {
    trigger: draftTriggerSchema.parse(settings.get("draft_trigger") ?? "PAID"),
    shopifyPaymentFeeMode: shopifyPaymentFeeModeSchema.parse(
      settings.get("shopify_payment_fee_mode") ?? "DEDUCT",
    ),
  };
}
