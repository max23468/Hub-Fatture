import { getConfig } from "../config.server.ts";
import { arubaUnresolvedCandidateSql } from "./billing-case-sql.server.ts";
import { getPool } from "./client.server.ts";

type BackfillStatus = "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | null;

interface ReconciliationPreviewRow {
  backfill_status: BackfillStatus;
  backfill_complete: boolean;
  unresolved_documents: number;
  ambiguous_documents: number;
  exact_api_signature: number;
  official_evidence_available: number;
  ready_for_targeted_reconciliation: number;
  multiple_api_signatures: number;
  not_yet_covered: number;
}

/**
 * Restituisce soltanto conteggi sanitizzati. La firma data/importo non autorizza un collegamento:
 * indica esclusivamente quali documenti potranno essere riletti con la prova ufficiale dell’API.
 */
export async function getArubaApiReconciliationPreview() {
  const environment = getConfig().APP_ENV === "production" ? "PRODUCTION" : "MOCK";
  const result = await getPool().query<ReconciliationPreviewRow>(
    `WITH candidate_run AS (
       SELECT runs.id, runs.status
       FROM aruba_sync_runs AS runs
       WHERE runs.environment = $1 AND runs.kind IN ('BACKFILL', 'FULL')
         AND runs.authority_mode = 'SHADOW'
       ORDER BY runs.completed_at DESC NULLS FIRST, runs.started_at DESC, runs.id DESC
       LIMIT 1
     ), unresolved AS (
       SELECT DISTINCT matches.id, matches.status, remote.document_type, remote.fiscal_year,
         remote.document_date, remote.total_amount
       FROM aruba_document_matches AS matches
       JOIN aruba_remote_documents AS remote ON remote.id = matches.remote_document_id
       LEFT JOIN LATERAL jsonb_array_elements(matches.candidates_json) AS candidate ON true
       WHERE remote.environment = $1 AND remote.remote_status <> 'REJECTED'
         AND (
           (matches.status = 'UNMATCHED' AND matches.method <> 'MANUAL'
             AND ${arubaUnresolvedCandidateSql("candidate")})
           OR matches.status IN (
             'AMBIGUOUS', 'PROFILE_CONFLICT', 'ERROR', 'UNKNOWN_REMOTE_STATE'
           )
         )
     ), correlated AS (
       SELECT unresolved.id, unresolved.status,
         count(DISTINCT shadow.remote_key)::integer AS api_signatures,
         coalesce(bool_or(
           shadow.xml_sha256 IS NOT NULL OR shadow.p7m_sha256 IS NOT NULL
         ), false) AS official_evidence
       FROM unresolved
       LEFT JOIN aruba_api_shadow_documents AS shadow
         ON shadow.sync_run_id = (SELECT id FROM candidate_run)
        AND shadow.document_type = unresolved.document_type
        AND shadow.fiscal_year = unresolved.fiscal_year
        AND shadow.document_date = unresolved.document_date
        AND shadow.total_amount = unresolved.total_amount
       GROUP BY unresolved.id, unresolved.status
     )
     SELECT
       (SELECT status FROM candidate_run) AS backfill_status,
       coalesce((SELECT status = 'COMPLETED' FROM candidate_run), false) AS backfill_complete,
       count(*)::integer AS unresolved_documents,
       count(*) FILTER (WHERE status = 'AMBIGUOUS')::integer AS ambiguous_documents,
       count(*) FILTER (WHERE api_signatures = 1)::integer AS exact_api_signature,
       count(*) FILTER (WHERE official_evidence)::integer AS official_evidence_available,
       count(*) FILTER (WHERE api_signatures = 1 AND official_evidence)::integer
         AS ready_for_targeted_reconciliation,
       count(*) FILTER (WHERE api_signatures > 1)::integer AS multiple_api_signatures,
       count(*) FILTER (WHERE api_signatures = 0)::integer AS not_yet_covered
     FROM correlated`,
    [environment],
  );
  const row = result.rows[0] ?? {
    backfill_status: null,
    backfill_complete: false,
    unresolved_documents: 0,
    ambiguous_documents: 0,
    exact_api_signature: 0,
    official_evidence_available: 0,
    ready_for_targeted_reconciliation: 0,
    multiple_api_signatures: 0,
    not_yet_covered: 0,
  };
  return {
    backfillStatus: row.backfill_status,
    backfillComplete: row.backfill_complete,
    unresolvedDocuments: row.unresolved_documents,
    ambiguousDocuments: row.ambiguous_documents,
    exactApiSignature: row.exact_api_signature,
    officialEvidenceAvailable: row.official_evidence_available,
    readyForTargetedReconciliation: row.ready_for_targeted_reconciliation,
    multipleApiSignatures: row.multiple_api_signatures,
    notYetCovered: row.not_yet_covered,
  };
}
