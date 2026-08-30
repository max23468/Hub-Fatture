import { randomUUID } from "node:crypto";

import type pg from "pg";

import type { FiscalIdentity } from "../aruba-inbound.ts";
import { AppError } from "../errors.ts";
import {
  arubaBlockingMatchPredicate,
  getArubaInventoryHealth,
} from "./aruba-inventory-health.server.ts";
import {
  arubaAccountReference,
  arubaPayloadDigest,
  arubaRuntimeEnvironment,
  currentArubaInventoryWatermark,
  lockArubaInventory,
  type ArubaReadActor,
} from "./aruba-inventory-context.server.ts";
import { getPool, withTransaction } from "./client.server.ts";
async function requestArubaPreflight(
  input: {
    billingCaseId?: string;
    documentId?: string;
    draftVersion: number;
    projectionSha256: string;
  },
  actor: ArubaReadActor,
  sharedManifestSha256?: string,
) {
  const health = await getArubaInventoryHealth();
  if (health.blocking && health.blockingReason !== "STALE") {
    throw new AppError("ARUBA_INVENTORY_BLOCKED", 409);
  }
  const request = await getPool().query<{
    id: string;
    document_type: "TD01" | "TD04";
    order_ids: string[];
    searches: Array<{
      provider: "SHOPIFY" | "EBAY";
      displayNumber: string;
      amount: number;
      documentType: "TD01" | "TD04";
      orderId: string;
      orderDate: string;
      recipientName: string | null;
      recipientTaxIdentifiers: FiscalIdentity[];
      recipientAddress: string | null;
      refundIds: string[];
    }>;
  }>(
    `SELECT documents.id, documents.document_type, coalesce(array_agg(document_orders.order_id::text)
      FILTER (WHERE document_orders.order_id IS NOT NULL), '{}') AS order_ids,
      coalesce(jsonb_agg(DISTINCT jsonb_build_object(
        'provider', orders.provider, 'displayNumber', orders.display_number,
        'amount', document_orders.amount, 'documentType', documents.document_type,
        'orderId', orders.id::text, 'orderDate', orders.local_order_date::text,
        'recipientName', customers.display_name,
        'recipientTaxIdentifiers', coalesce((SELECT jsonb_agg(jsonb_build_object(
          'type', tax.type, 'countryCode', coalesce(tax.country_code,
            orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,countryCode}'),
          'value', tax.normalized_value))
          FROM order_tax_identifiers tax WHERE tax.order_id = orders.id), '[]'),
        'recipientAddress', concat_ws(' ',
          orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,line1}',
          orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,postalCode}',
          orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,city}',
          orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,countryCode}'),
        'refundIds', coalesce((SELECT jsonb_agg(refunds.id::text ORDER BY refunds.id)
          FROM refunds WHERE refunds.order_id = orders.id AND refunds.status = 'COMPLETED'
            AND refunds.credit_document_id = documents.id), '[]')
      )) FILTER (WHERE orders.id IS NOT NULL), '[]') AS searches
     FROM documents
     LEFT JOIN document_orders ON document_orders.document_id = documents.id
     LEFT JOIN orders ON orders.id = document_orders.order_id
     LEFT JOIN customers ON customers.id = orders.customer_id
     WHERE (($1::bigint IS NOT NULL AND documents.billing_case_id = $1)
        OR ($2::bigint IS NOT NULL AND documents.id = $2))
       AND documents.draft_version = $3 AND documents.projection_sha256 = $4
     GROUP BY documents.id`,
    [
      input.billingCaseId ?? null,
      input.documentId ?? null,
      input.draftVersion,
      input.projectionSha256,
    ],
  );
  const document = request.rows[0];
  if (!document) throw new AppError("DOCUMENT_PROJECTION_STALE", 409);
  const manifest = {
    billingCaseId: input.billingCaseId ?? null,
    documentId: document.id,
    documentType: document.document_type,
    draftVersion: input.draftVersion,
    projectionSha256: input.projectionSha256,
    orderIds: document.order_ids,
    refundIds: document.searches.flatMap((search) => search.refundIds),
    searches: document.searches,
  };
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `aruba-preflight:${document.id}:${input.draftVersion}:${input.projectionSha256}`,
    ]);
    await client.query(
      `UPDATE aruba_preflight_receipts SET status = 'EXPIRED'
       WHERE billing_case_id IS NOT DISTINCT FROM $1 AND document_id = $2
         AND draft_version = $3 AND projection_sha256 = $4 AND status = 'PASSED'
         AND expires_at <= now()`,
      [input.billingCaseId ?? null, document.id, input.draftVersion, input.projectionSha256],
    );
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- Il watermark va letto dopo l'espirazione sotto lo stesso lock transazionale.
    const watermark = await currentArubaInventoryWatermark(client);
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- La ricerca del receipt deve osservare l'espirazione già applicata nello stesso snapshot transazionale.
    const existing = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM aruba_preflight_receipts
       WHERE billing_case_id IS NOT DISTINCT FROM $1 AND document_id = $2
         AND draft_version = $3 AND projection_sha256 = $4
         AND status IN ('REQUESTED', 'RUNNING', 'PASSED')
         AND (expires_at IS NULL OR expires_at > now())
      ORDER BY requested_at DESC LIMIT 1`,
      [input.billingCaseId ?? null, document.id, input.draftVersion, input.projectionSha256],
    );
    if (existing.rows[0]) return { ...existing.rows[0], documentId: document.id };
    const id = randomUUID();
    const syntheticPass = arubaRuntimeEnvironment() === "MOCK";
    await client.query(
      `INSERT INTO aruba_preflight_receipts
      (id, environment, account_reference, billing_case_id, document_id, draft_version,
       projection_sha256, manifest_sha256, inventory_watermark, requested_by, request_json,
       source, status, completed_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'MANUAL',
       CASE WHEN $12 THEN 'PASSED' ELSE 'REQUESTED' END,
       CASE WHEN $12 THEN now() ELSE NULL END,
       CASE WHEN $12 THEN now() + interval '5 minutes' ELSE NULL END)`,
      [
        id,
        arubaRuntimeEnvironment(),
        arubaAccountReference(),
        input.billingCaseId ?? null,
        document.id,
        input.draftVersion,
        input.projectionSha256,
        sharedManifestSha256 ?? arubaPayloadDigest(manifest),
        watermark,
        actor.id,
        JSON.stringify({
          ...manifest,
          sharedManifestSha256: sharedManifestSha256 ?? null,
        }),
        syntheticPass,
      ],
    );
    return {
      id,
      status: syntheticPass ? "PASSED" : "REQUESTED",
      documentId: document.id,
    };
  });
}

export async function ensureArubaPreflight(
  input: {
    billingCaseId?: string;
    documentId?: string;
    draftVersion: number;
    projectionSha256: string;
  },
  actor: ArubaReadActor,
) {
  const receipt = await requestArubaPreflight(input, actor);
  if (receipt.status !== "PASSED") throw new AppError("ARUBA_PREFLIGHT_REQUIRED", 409);
  return { id: receipt.id, documentId: receipt.documentId };
}

export async function consumeArubaPreflight(
  client: pg.PoolClient,
  receiptId: string,
  input: {
    billingCaseId?: string;
    documentId?: string;
    draftVersion: number;
    projectionSha256: string;
  },
) {
  const receipt = await client.query<{
    id: string;
    inventory_watermark: string;
    environment: string;
    account_reference: string;
    completed_at: Date;
  }>(
    `SELECT id, inventory_watermark::text, environment, account_reference, completed_at
     FROM aruba_preflight_receipts
     WHERE id = $1 AND status = 'PASSED' AND expires_at > now()
       AND billing_case_id IS NOT DISTINCT FROM $2
       AND document_id IS NOT DISTINCT FROM $3
       AND draft_version = $4 AND projection_sha256 = $5
     FOR UPDATE`,
    [
      receiptId,
      input.billingCaseId ?? null,
      input.documentId ?? null,
      input.draftVersion,
      input.projectionSha256,
    ],
  );
  const current = receipt.rows[0];
  if (!current) throw new AppError("ARUBA_PREFLIGHT_REQUIRED", 409);
  await lockArubaInventory(
    client,
    current.environment as "MOCK" | "PRODUCTION",
    current.account_reference,
  );
  const watermark = await currentArubaInventoryWatermark(client);
  if (watermark !== Number(current.inventory_watermark)) {
    throw new AppError("ARUBA_PREFLIGHT_REQUIRED", 409);
  }
  const subsequentFailure = await client.query(
    `SELECT 1 FROM aruba_sync_sessions
     WHERE environment = $1 AND account_reference = $2 AND status IN ('FAILED', 'INCOMPLETE')
       AND coalesce(failed_at, started_at) > $3
     LIMIT 1`,
    [current.environment, current.account_reference, current.completed_at],
  );
  if (subsequentFailure.rows[0]) throw new AppError("ARUBA_PREFLIGHT_REQUIRED", 409);
  // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk -- Il predicato interpolato è una costante SQL interna composta soltanto da frammenti statici; i valori esterni restano parametrizzati.
  const blocker = await client.query(
    `SELECT 1 FROM aruba_document_matches matches
     JOIN aruba_remote_documents remote ON remote.id = matches.remote_document_id
     WHERE remote.environment = $1 AND remote.account_reference = $2
       AND ${arubaBlockingMatchPredicate}
     LIMIT 1`,
    [current.environment, current.account_reference],
  );
  if (blocker.rows[0]) throw new AppError("ARUBA_INVENTORY_BLOCKED", 409);
  await client.query(
    `UPDATE aruba_preflight_receipts SET status = 'CONSUMED', consumed_at = now() WHERE id = $1`,
    [current.id],
  );
}
