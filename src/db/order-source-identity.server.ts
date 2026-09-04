import type pg from "pg";

import { AppError } from "../errors.ts";
import type { OrderInput } from "../orders.ts";

export async function reconcileEbayIdentity(client: pg.PoolClient, input: OrderInput) {
  if (input.provider !== "EBAY") {
    return { absorbedOrderCount: 0, discardedCustomerIds: [] as string[] };
  }
  const lineIds = input.sourceIdentityIds;
  if (!lineIds.length) {
    return { absorbedOrderCount: 0, discardedCustomerIds: [] as string[] };
  }
  const candidatesResult = await client.query<{
    id: string;
    external_order_id: string;
    customer_id: string;
    mergeable: boolean;
  }>(
    `SELECT orders.id, orders.external_order_id, orders.customer_id,
            orders.payment_status = 'PENDING'
              AND orders.billing_case_id IS NULL
              AND orders.raw_snapshot_json #>> '{sourceSnapshot,sourceApi}' = 'EBAY_TRADING'
              AND NOT EXISTS (SELECT 1 FROM refunds WHERE refunds.order_id = orders.id)
              AND NOT EXISTS (
                SELECT 1 FROM document_orders WHERE document_orders.order_id = orders.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM document_lines WHERE document_lines.order_id = orders.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM aruba_document_matches
                WHERE aruba_document_matches.order_id = orders.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM order_source_revisions
                WHERE order_source_revisions.order_id = orders.id
              ) AS mergeable
     FROM orders
     WHERE orders.provider = 'EBAY' AND orders.external_account_id = $1
       AND (orders.external_order_id = $2 OR EXISTS (
         SELECT 1 FROM order_source_identities AS identities
         WHERE identities.order_id = orders.id
           AND identities.provider = 'EBAY'
           AND identities.external_account_id = $1
           AND identities.identity_kind = 'ORDER_LINE_ITEM'
           AND identities.external_id = ANY($3::text[])
       ))
     FOR UPDATE OF orders`,
    [input.externalAccountId, input.externalOrderId, lineIds],
  );
  const candidates = new Map(candidatesResult.rows.map((order) => [order.id, order]));
  const direct = candidatesResult.rows.find(
    ({ external_order_id }) => external_order_id === input.externalOrderId,
  );
  const existing =
    direct ??
    [...candidates.values()].sort((left, right) =>
      BigInt(left.id) < BigInt(right.id) ? -1 : 1,
    )[0];
  if (!existing) {
    return { absorbedOrderCount: 0, discardedCustomerIds: [] as string[] };
  }

  const mutableCandidates = [...candidates.values()].filter(
    (candidate) => candidate.id !== direct?.id,
  );
  const identities = await client.query<{ order_id: string; external_id: string }>(
    `SELECT order_id, external_id
     FROM order_source_identities
     WHERE order_id = ANY($1::bigint[])
     FOR UPDATE`,
    [mutableCandidates.map(({ id }) => id)],
  );
  const incomingIdentities = new Set(lineIds);
  if (
    mutableCandidates.some((candidate) => !candidate.mergeable) ||
    identities.rows.some(({ external_id }) => !incomingIdentities.has(external_id))
  ) {
    throw new AppError("CONFLICT_REVISION", 409);
  }

  const discarded = [...candidates.values()].filter(({ id }) => id !== existing.id);
  if (discarded.length) {
    const discardedIds = discarded.map(({ id }) => id);
    await client.query(
      `UPDATE order_source_identities SET order_id = $1
       WHERE order_id = ANY($2::bigint[])`,
      [existing.id, discardedIds],
    );
    const removed = await client.query(`DELETE FROM orders WHERE id = ANY($1::bigint[])`, [
      discardedIds,
    ]);
    if (removed.rowCount !== discarded.length) throw new AppError("CONFLICT_REVISION", 409);
  }

  if (existing.external_order_id !== input.externalOrderId) {
    const renamed = await client.query(
      `UPDATE orders SET external_order_id = $2, last_synced_at = now()
       WHERE id = $1`,
      [existing.id, input.externalOrderId],
    );
    if (renamed.rowCount !== 1) throw new AppError("CONFLICT_REVISION", 409);
  }
  return {
    absorbedOrderCount: discarded.length,
    discardedCustomerIds: discarded.map(({ customer_id }) => customer_id),
  };
}

export async function persistEbayIdentities(
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
