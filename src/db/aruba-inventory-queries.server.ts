import type { ArubaRemoteStatus } from "../aruba-inbound.ts";
import { arubaBlockingMatchPredicate } from "./aruba-inventory-health.server.ts";
import { arubaActionableCandidateSql } from "./billing-case-sql.server.ts";
import {
  arubaAccountReference as accountReference,
  arubaRuntimeEnvironment as environment,
} from "./aruba-inventory-context.server.ts";
import { getPool } from "./client.server.ts";
import { isDatabaseId } from "./database-id.ts";
import { containsNullByte, escapeLike, PAGE_SIZE, pageOffset, paginate } from "../orders.ts";

export interface RemoteDocumentFilters {
  attentionOnly?: boolean;
  blockingOnly?: boolean;
  billingCaseId?: string;
  query?: string;
}

export interface RemoteDocument {
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
  candidates: Array<{ id: string; label: string; guided: boolean }>;
  has_xml: boolean;
  requires_control: boolean;
}

interface RemoteDocumentQueryRow extends RemoteDocument {
  total_count: number;
}

function remoteDocumentParameters(options: RemoteDocumentFilters) {
  const billingCaseId = options.billingCaseId
    ? isDatabaseId(options.billingCaseId)
      ? options.billingCaseId
      : null
    : null;
  if (options.billingCaseId && !billingCaseId) return null;
  return [
    environment(),
    accountReference(),
    Boolean(options.attentionOnly || options.blockingOnly),
    Boolean(options.blockingOnly),
    billingCaseId,
    options.query?.trim() ? `%${escapeLike(options.query.trim())}%` : null,
  ];
}

const remoteDocumentsSql = `
  SELECT remote.id, remote.remote_id, remote.document_type, remote.fiscal_number,
         remote.series, remote.document_date::text, remote.total_amount,
         remote.remote_status, remote.last_observed_at,
         coalesce(matches.status, 'UNMATCHED') AS match_status,
         matches.order_id, matches.document_id,
         count(*) OVER()::int AS total_count,
         EXISTS (SELECT 1 FROM aruba_files
           WHERE aruba_files.remote_document_id = remote.id
             AND aruba_files.kind = 'ARUBA_XML') AS has_xml,
         ((${arubaBlockingMatchPredicate})
           OR (matches.status = 'MATCHED'
             AND remote.remote_status IN ('DELIVERED', 'NOT_DELIVERED')
             AND NOT EXISTS (SELECT 1 FROM aruba_files
               WHERE aruba_files.remote_document_id = remote.id
                 AND aruba_files.kind = 'ARUBA_XML'))) AS requires_control,
         coalesce((
           SELECT jsonb_agg(jsonb_build_object(
             'id', orders.id::text,
             'label', CASE orders.provider WHEN 'SHOPIFY' THEN 'Shopify ' ELSE 'eBay ' END
               || orders.display_number,
             'guided', ${arubaActionableCandidateSql("candidate", "remote")}
               AND NOT coalesce((candidate ->> 'compatible')::boolean, false)
           ) ORDER BY orders.id)
           FROM jsonb_array_elements(coalesce(matches.candidates_json, '[]')) AS candidate
           JOIN orders ON orders.id::text = candidate ->> 'candidateId'
           WHERE ${arubaActionableCandidateSql("candidate", "remote")}
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
        ${arubaBlockingMatchPredicate}
        OR (matches.status = 'MATCHED'
          AND remote.remote_status IN ('DELIVERED', 'NOT_DELIVERED')
          AND NOT EXISTS (SELECT 1 FROM aruba_files
            WHERE aruba_files.remote_document_id = remote.id
              AND aruba_files.kind = 'ARUBA_XML'))
      )))
    AND ($5::bigint IS NULL OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(coalesce(matches.candidates_json, '[]')) AS focused_candidate
      JOIN orders AS focused_order
        ON focused_order.id::text = focused_candidate ->> 'candidateId'
      WHERE focused_order.billing_case_id = $5
        AND ${arubaActionableCandidateSql("focused_candidate", "remote")}
    ))
    AND ($6::text IS NULL
      OR remote.remote_id ILIKE $6 ESCAPE '\\'
      OR remote.document_type ILIKE $6 ESCAPE '\\'
      OR remote.fiscal_number ILIKE $6 ESCAPE '\\'
      OR remote.series ILIKE $6 ESCAPE '\\'
      OR concat_ws(' ', remote.document_type, remote.series, remote.fiscal_number)
        ILIKE $6 ESCAPE '\\'
      OR remote.remote_status::text ILIKE $6 ESCAPE '\\'
      OR coalesce(matches.status, 'UNMATCHED') ILIKE $6 ESCAPE '\\'
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(coalesce(matches.candidates_json, '[]')) AS search_candidate
        JOIN orders AS search_order ON search_order.id::text = search_candidate ->> 'candidateId'
        WHERE search_order.display_number ILIKE $6 ESCAPE '\\'
           OR search_order.external_order_id ILIKE $6 ESCAPE '\\'
      )
      OR EXISTS (
        SELECT 1
        FROM aruba_remote_observations AS search_observation
        WHERE search_observation.remote_document_id = remote.id
          AND (coalesce(search_observation.payload_json ->> 'recipientName', '')
                 ILIKE $6 ESCAPE '\\'
            OR coalesce(search_observation.payload_json ->> 'recipientTaxId', '')
                 ILIKE $6 ESCAPE '\\')
      ))`;

export async function listRemoteDocuments(options: RemoteDocumentFilters = {}) {
  if (containsNullByte(options)) return [];
  const parameters = remoteDocumentParameters(options);
  if (!parameters) return [];
  const result = await getPool().query<RemoteDocumentQueryRow>(
    `${remoteDocumentsSql}
     ORDER BY remote.last_observed_at DESC, remote.id DESC
     LIMIT 200`,
    parameters,
  );
  return result.rows.map(({ total_count, ...row }) => {
    void total_count;
    return row;
  });
}

export async function listRemoteDocumentsPage(
  options: RemoteDocumentFilters & { page?: unknown } = {},
) {
  const empty = { rows: [] as RemoteDocument[], hasNext: false, total: 0 };
  if (containsNullByte(options)) return empty;
  const parameters = remoteDocumentParameters(options);
  if (!parameters) return empty;
  const result = await getPool().query<RemoteDocumentQueryRow>(
    `${remoteDocumentsSql}
     ORDER BY remote.last_observed_at DESC, remote.id DESC
     LIMIT ${PAGE_SIZE + 1} OFFSET $7`,
    [...parameters, pageOffset(options.page)],
  );
  const total = result.rows[0]?.total_count ?? 0;
  const page = paginate(result.rows);
  return {
    rows: page.rows.map(({ total_count, ...row }) => {
      void total_count;
      return row;
    }),
    hasNext: page.hasNext,
    total,
  };
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
