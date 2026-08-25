import type pg from "pg";

import {
  ARUBA_MATCHER_VERSION,
  groupOrderCandidates,
  remoteInventoryDocumentSchema,
  selectOrderMatch,
  type ArubaOrderCandidate,
  type RemoteInventoryDocument,
} from "../aruba-inbound.ts";

export async function reconcileCachedArubaMatcherUpgrade(
  client: pg.PoolClient,
  environment: string,
  account: string,
  reconcile: (remoteId: string, remote: RemoteInventoryDocument) => Promise<void>,
) {
  const unresolvedOrders = await client.query<{
    id: string;
    provider: "SHOPIFY" | "EBAY";
    display_number: string;
    local_order_date: string;
    billable_amount: number;
    recipient_name: string;
    billing_case_id: string | null;
  }>(
    `SELECT orders.id::text, orders.provider, orders.display_number,
            orders.local_order_date::text, orders.billing_case_id::text,
            coalesce(nullif(billing_cases.customer_snapshot_json ->> 'displayName', ''),
              customers.display_name) AS recipient_name,
            (orders.gross_amount - orders.deducted_shopify_payments_fee_amount - coalesce((
              SELECT sum(refunds.amount) FROM refunds
              WHERE refunds.order_id = orders.id AND refunds.applied_before_issue
            ), 0))::integer AS billable_amount
     FROM orders
     JOIN customers ON customers.id = orders.customer_id
     LEFT JOIN billing_cases ON billing_cases.id = orders.billing_case_id
     WHERE orders.trigger_status NOT IN (
       'INVOICED', 'CANCELLED_NO_DOCUMENT', 'REFUNDED_BEFORE_ISSUE'
     )
     ORDER BY orders.id`,
  );
  const individualCandidates: Array<ArubaOrderCandidate & { billingCaseId?: string | null }> =
    unresolvedOrders.rows.map((order) => ({
      id: order.id,
      billingCaseId: order.billing_case_id,
      provider: order.provider,
      displayNumber: order.display_number,
      localOrderDate: order.local_order_date,
      billableAmount: order.billable_amount,
      recipientName: order.recipient_name,
      recipientTaxIdentifiers: [],
      recipientAddress: null,
    }));
  const invoiceCandidates = [
    ...individualCandidates,
    ...groupOrderCandidates(individualCandidates).filter(
      (candidate) => (candidate.orderIds?.length ?? 1) > 1,
    ),
  ];
  const cached = await client.query<{
    id: string;
    payload: unknown;
    candidates_json: Array<{ potential?: boolean }>;
  }>(
    `SELECT remote.id::text, latest.payload, matches.candidates_json
     FROM aruba_remote_documents remote
     JOIN aruba_document_matches matches ON matches.remote_document_id = remote.id
     JOIN LATERAL (
       SELECT document.value AS payload
       FROM aruba_remote_observations observations
       JOIN aruba_sync_pages pages
         ON pages.sync_session_id = observations.sync_session_id
        AND pages.stream = observations.stream
        AND pages.scan_ordinal = observations.scan_ordinal
        AND pages.page_ordinal = observations.page_ordinal
       CROSS JOIN LATERAL jsonb_array_elements(pages.documents_json) document(value)
       WHERE observations.remote_document_id = remote.id
         AND document.value ->> 'remoteId' = remote.remote_id
       ORDER BY observations.observed_at DESC, observations.id DESC
       LIMIT 1
     ) latest ON true
     WHERE remote.environment = $1 AND remote.account_reference = $2
       AND remote.remote_status <> 'REJECTED'
       AND matches.method <> 'MANUAL'
       AND matches.status <> 'ERROR'
       AND ((remote.document_type = 'TD01' AND EXISTS (
         SELECT 1 FROM orders
         WHERE orders.trigger_status NOT IN (
           'INVOICED', 'CANCELLED_NO_DOCUMENT', 'REFUNDED_BEFORE_ISSUE'
         )
           AND orders.local_order_date BETWEEN remote.document_date - 31
             AND remote.document_date + 31
       )) OR (remote.document_type = 'TD04' AND EXISTS (
         SELECT 1 FROM refunds
         WHERE refunds.status = 'COMPLETED' AND NOT refunds.applied_before_issue
           AND refunds.amount > 0
           AND refunds.completed_at::date BETWEEN remote.document_date - 31
             AND remote.document_date + 31
           AND refunds.credit_document_id IS NULL
       )))
     ORDER BY remote.id`,
    [environment, account],
  );
  const invalidIds: string[] = [];
  for (const row of cached.rows) {
    const parsed = remoteInventoryDocumentSchema.safeParse(row.payload);
    if (!parsed.success) {
      invalidIds.push(row.id);
      continue;
    }
    if (
      parsed.data.documentType === "TD01" &&
      !row.candidates_json.some((candidate) => candidate.potential) &&
      !selectOrderMatch(parsed.data, invoiceCandidates).evaluations.some((candidate) =>
        Boolean(candidate.potential),
      )
    ) {
      // Un documento senza candidati deve restare rivalutabile: un ordine coerente
      // può arrivare da Shopify/eBay dopo questa lettura della cache Aruba.
      continue;
    }
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- I match condividono la stessa transazione e vengono aggiornati in ordine.
    await reconcile(row.id, parsed.data);
  }
  if (invalidIds.length) {
    await client.query(
      `UPDATE aruba_document_matches
       SET status = 'ERROR', method = 'NONE', matcher_version = $2,
           signals_json = '{"cachedPayloadInvalid":true}', updated_at = now()
       WHERE remote_document_id = ANY($1::bigint[])`,
      [invalidIds, ARUBA_MATCHER_VERSION],
    );
  }
}
