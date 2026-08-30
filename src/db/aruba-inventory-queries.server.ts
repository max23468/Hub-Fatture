import type { ArubaRemoteStatus } from "../aruba-inbound.ts";
import { arubaBlockingMatchPredicate } from "./aruba-inventory-health.server.ts";
import {
  arubaAccountReference as accountReference,
  arubaRuntimeEnvironment as environment,
} from "./aruba-inventory-context.server.ts";
import { getPool } from "./client.server.ts";
import { isDatabaseId } from "./database-id.ts";
export async function listRemoteDocuments(
  options: { attentionOnly?: boolean; blockingOnly?: boolean } = {},
) {
  const result = await getPool().query<{
    id: string;
    remote_id: string;
    document_type: "TD01" | "TD04";
    fiscal_number: string | null;
    series: string | null;
    document_date: string;
    total_amount: number;
    remote_status: ArubaRemoteStatus;
    last_observed_at: string;
    match_status: string;
    order_id: string | null;
    document_id: string | null;
    candidates: Array<{ id: string; label: string }>;
    has_xml: boolean;
  }>(
    `SELECT remote.id, remote.remote_id, remote.document_type, remote.fiscal_number,
            remote.series, remote.document_date::text, remote.total_amount,
            remote.remote_status, remote.last_observed_at,
            coalesce(matches.status, 'UNMATCHED') AS match_status,
            matches.order_id, matches.document_id,
            EXISTS (SELECT 1 FROM aruba_files
              WHERE aruba_files.remote_document_id = remote.id
                AND aruba_files.kind = 'ARUBA_XML') AS has_xml,
            coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                'id', orders.id::text,
                'label', CASE orders.provider WHEN 'SHOPIFY' THEN 'Shopify ' ELSE 'eBay ' END
                  || orders.display_number
              ) ORDER BY orders.id)
              FROM orders
              WHERE orders.id::text IN (
                SELECT candidate ->> 'candidateId'
                FROM jsonb_array_elements(coalesce(matches.candidates_json, '[]')) AS candidate
                WHERE coalesce((candidate ->> 'compatible')::boolean, false)
              )
            ), '[]') AS candidates
     FROM aruba_remote_documents AS remote
     LEFT JOIN aruba_document_matches AS matches ON matches.remote_document_id = remote.id
     WHERE remote.environment = $1 AND remote.account_reference = $2
       AND (NOT $3::boolean OR ($4::boolean AND (
           ${arubaBlockingMatchPredicate}
           OR (matches.status = 'MATCHED'
             AND remote.remote_status IN ('DELIVERED', 'NOT_DELIVERED')
             AND NOT EXISTS (SELECT 1 FROM aruba_files
               WHERE aruba_files.remote_document_id = remote.id
                 AND aruba_files.kind = 'ARUBA_XML'))
         )) OR (NOT $4::boolean AND (
           (coalesce(matches.status, 'UNMATCHED') <> 'MATCHED'
             AND NOT (matches.status = 'UNMATCHED' AND matches.method = 'MANUAL'))
           OR (matches.status = 'MATCHED'
             AND remote.remote_status IN ('DELIVERED', 'NOT_DELIVERED')
             AND NOT EXISTS (SELECT 1 FROM aruba_files
               WHERE aruba_files.remote_document_id = remote.id
                 AND aruba_files.kind = 'ARUBA_XML'))
         )))
     ORDER BY remote.last_observed_at DESC, remote.id DESC
     LIMIT 200`,
    [
      environment(),
      accountReference(),
      Boolean(options.attentionOnly || options.blockingOnly),
      Boolean(options.blockingOnly),
    ],
  );
  return result.rows;
}

export async function listOrderRemoteDocuments(orderId: string) {
  if (!isDatabaseId(orderId)) return [];
  const result = await getPool().query(
    `SELECT remote.remote_id, remote.document_type, remote.fiscal_number, remote.series,
            remote.remote_status, remote.last_observed_at, matches.status AS match_status
     FROM aruba_document_matches AS matches
     JOIN aruba_remote_documents AS remote ON remote.id = matches.remote_document_id
     WHERE matches.order_id = $1 ORDER BY remote.last_observed_at DESC`,
    [orderId],
  );
  return result.rows;
}
