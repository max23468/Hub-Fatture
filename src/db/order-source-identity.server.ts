import type pg from "pg";

import { AppError } from "../errors.ts";
import type { OrderInput } from "../orders.ts";

export async function reconcileEbayOrderIdentity(client: pg.PoolClient, input: OrderInput) {
  if (input.provider !== "EBAY") return;
  const lineIds = input.sourceIdentityIds;
  if (!lineIds.length) return;
  const direct = await client.query<{ id: string; external_order_id: string }>(
    `SELECT id, external_order_id
     FROM orders
     WHERE provider = 'EBAY' AND external_account_id = $1 AND external_order_id = $2
     FOR UPDATE`,
    [input.externalAccountId, input.externalOrderId],
  );
  const aliased = await client.query<{ id: string; external_order_id: string }>(
    `SELECT orders.id, orders.external_order_id
     FROM order_source_identities AS identities
     JOIN orders ON orders.id = identities.order_id
     WHERE identities.provider = 'EBAY'
       AND identities.external_account_id = $1
       AND identities.identity_kind = 'ORDER_LINE_ITEM'
       AND identities.external_id = ANY($2::text[])
     FOR UPDATE OF orders`,
    [input.externalAccountId, lineIds],
  );
  const candidates = new Map(
    [...direct.rows, ...aliased.rows].map((order) => [order.id, order.external_order_id]),
  );
  if (candidates.size > 1) throw new AppError("CONFLICT_REVISION", 409);
  const existing = [...candidates.entries()][0];
  if (!existing || existing[1] === input.externalOrderId) return;

  const renamed = await client.query(
    `UPDATE orders
     SET external_order_id = $2, last_synced_at = now()
     WHERE id = $1
       AND provider = 'EBAY'
       AND payment_status = 'PENDING'
       AND billing_case_id IS NULL
       AND raw_snapshot_json #>> '{sourceSnapshot,sourceApi}' = 'EBAY_TRADING'
       AND NOT EXISTS (SELECT 1 FROM refunds WHERE refunds.order_id = orders.id)`,
    [existing[0], input.externalOrderId],
  );
  if (renamed.rowCount !== 1) throw new AppError("CONFLICT_REVISION", 409);
}

export async function persistEbayOrderIdentities(
  client: pg.PoolClient,
  input: OrderInput,
  orderId: string,
) {
  if (input.provider !== "EBAY") return;
  for (const externalId of input.sourceIdentityIds) {
    const persisted = await client.query(
      `INSERT INTO order_source_identities
        (provider, external_account_id, identity_kind, external_id, order_id)
       VALUES ('EBAY', $1, 'ORDER_LINE_ITEM', $2, $3)
       ON CONFLICT (provider, external_account_id, identity_kind, external_id)
       DO UPDATE SET order_id = EXCLUDED.order_id
       WHERE order_source_identities.order_id = EXCLUDED.order_id`,
      [input.externalAccountId, externalId, orderId],
    );
    if (persisted.rowCount !== 1) throw new AppError("CONFLICT_REVISION", 409);
  }
}
