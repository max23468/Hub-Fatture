import { AppError } from "../errors.ts";
import { normalizedMatchText } from "../aruba-inbound.ts";
import { fiscalNumberLabel } from "../fiscal-number.ts";
import type { ArubaApiInvoicePage } from "../integrations/aruba-api.server.ts";
import type { ArubaSyncRunRow } from "./aruba-api-context.server.ts";
import { arubaActionableCandidateSql } from "./billing-case-sql.server.ts";
import { withTransaction } from "./client.server.ts";

export interface HistoricalApiTarget {
  remote_document_id: string | null;
  search_start: Date | null;
  search_end: Date | null;
  document_type: "TD01" | "TD04" | null;
  fiscal_year: number | null;
  document_date: string | null;
  series: string | null;
  fiscal_number: string | null;
}

export interface TargetedRunTarget extends HistoricalApiTarget {
  target_ordinal: number;
  provider_group_id: string | null;
  target_count: number;
}

export async function snapshotTargetedTargets(run: ArubaSyncRunRow) {
  return withTransaction(async (client) => {
    const locked = await client.query<ArubaSyncRunRow>(
      `SELECT * FROM aruba_sync_runs
       WHERE id = $1 AND status = 'RUNNING' AND kind = 'TARGETED'
       FOR UPDATE`,
      [run.id],
    );
    const current = locked.rows[0];
    if (!current) throw new AppError("CONFLICT_REVISION", 409);
    const existing = await client.query<{ count: number }>(
      `SELECT count(*)::integer AS count
       FROM aruba_api_targeted_run_targets WHERE sync_run_id = $1`,
      [run.id],
    );
    if (existing.rows[0]!.count === 0 && current.checkpoint_page === 1) {
      const legacy = await client.query<{ id: string; search_start: Date; search_end: Date }>(
        `SELECT DISTINCT remote.id::text,
           (remote.document_date::timestamp AT TIME ZONE 'Europe/Rome') - interval '6 hours'
             AS search_start,
           (remote.document_date::timestamp AT TIME ZONE 'Europe/Rome') + interval '42 hours'
             AS search_end
         FROM aruba_remote_documents AS remote
         JOIN aruba_document_matches AS matches ON matches.remote_document_id = remote.id
         CROSS JOIN LATERAL jsonb_array_elements(matches.candidates_json) AS candidate
         WHERE remote.environment = $1 AND remote.account_reference = $2
           AND remote.remote_status <> 'REJECTED'
           AND (remote.automatic_source <> 'API' OR remote.provider_group_id IS NULL)
           AND NOT EXISTS (SELECT 1 FROM aruba_files files
             WHERE files.remote_document_id = remote.id AND files.kind = 'ARUBA_XML')
           AND matches.method <> 'MANUAL'
           AND matches.status IN ('UNMATCHED', 'AMBIGUOUS', 'PROFILE_CONFLICT')
           AND ${arubaActionableCandidateSql("candidate", "remote")}
           AND (remote.historical_api_recovery_checked_at IS NULL
             OR remote.historical_api_recovery_checked_at <= now() - interval '30 days')
         ORDER BY remote.id::text`,
        [run.environment, run.account_reference],
      );
      const groups = await client.query<{ provider_group_id: string }>(
        `WITH unresolved AS (
           SELECT DISTINCT matches.remote_document_id
           FROM aruba_document_matches AS matches
           JOIN aruba_remote_documents AS candidate_remote
             ON candidate_remote.id = matches.remote_document_id
           LEFT JOIN LATERAL jsonb_array_elements(matches.candidates_json) AS candidate ON true
           WHERE (
             (matches.status = 'UNMATCHED' AND matches.method <> 'MANUAL'
               AND ${arubaActionableCandidateSql("candidate", "candidate_remote")})
             OR (matches.status IN ('AMBIGUOUS', 'PROFILE_CONFLICT')
               AND matches.method <> 'MANUAL'
               AND ${arubaActionableCandidateSql("candidate", "candidate_remote")})
             OR matches.status IN ('ERROR', 'UNKNOWN_REMOTE_STATE')
           )
         )
         SELECT DISTINCT remote.provider_group_id
         FROM aruba_remote_documents AS remote
         LEFT JOIN unresolved ON unresolved.remote_document_id = remote.id
         WHERE remote.environment = $1 AND remote.account_reference = $2
           AND remote.automatic_source = 'API' AND remote.provider_group_id IS NOT NULL
           AND remote.remote_status <> 'REJECTED'
           AND (
             remote.remote_status IN ('SUBMITTED', 'SDI_PROCESSING', 'UNKNOWN')
             OR unresolved.remote_document_id IS NOT NULL
           )
         ORDER BY remote.provider_group_id`,
        [run.environment, run.account_reference],
      );
      if (legacy.rows.length > 0 || groups.rows.length > 0) {
        await client.query(
          `INSERT INTO aruba_api_targeted_run_targets
            (sync_run_id, target_ordinal, provider_group_id, remote_document_id,
             search_start, search_end)
           SELECT $1, row_number() OVER (ORDER BY priority, stable_key)::integer,
                  provider_group_id, remote_document_id, search_start, search_end
           FROM (
             SELECT 0 AS priority, legacy.id::text AS stable_key, NULL::text AS provider_group_id,
                    legacy.id::bigint AS remote_document_id,
                    legacy.search_start, legacy.search_end
             FROM unnest($2::bigint[], $3::timestamptz[], $4::timestamptz[])
               AS legacy(id, search_start, search_end)
             UNION ALL
             SELECT 1, groups.provider_group_id, groups.provider_group_id,
                    NULL::bigint, NULL::timestamptz, NULL::timestamptz
             FROM unnest($5::text[]) AS groups(provider_group_id)
           ) AS targets`,
          [
            run.id,
            legacy.rows.map((target) => target.id),
            legacy.rows.map((target) => target.search_start),
            legacy.rows.map((target) => target.search_end),
            groups.rows.map((group) => group.provider_group_id),
          ],
        );
      }
    }
    const snapshot = await client.query<TargetedRunTarget>(
      `SELECT targets.target_ordinal, targets.provider_group_id,
              targets.remote_document_id::text, targets.search_start, targets.search_end,
              remote.document_type, remote.fiscal_year, remote.document_date::text, remote.series,
              remote.fiscal_number,
              (SELECT count(*)::integer FROM aruba_api_targeted_run_targets
               WHERE sync_run_id = $1) AS target_count
       FROM aruba_api_targeted_run_targets AS targets
       LEFT JOIN aruba_remote_documents AS remote ON remote.id = targets.remote_document_id
       WHERE targets.sync_run_id = $1 AND targets.target_ordinal = $2`,
      [run.id, current.checkpoint_page],
    );
    return snapshot.rows[0] ?? null;
  });
}

function comparableInvoiceNumber(value: string | null) {
  return normalizedMatchText(value)?.replaceAll(/[^A-Z0-9]/g, "") ?? "";
}

export async function findHistoricalArubaProviderGroup(
  target: HistoricalApiTarget,
  readPage: (page: number, windowStart: Date, windowEnd: Date) => Promise<ArubaApiInvoicePage>,
) {
  if (
    !target.remote_document_id ||
    !target.search_start ||
    !target.search_end ||
    !target.document_type ||
    !target.document_date ||
    !target.fiscal_number
  ) {
    throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
  }
  const expectedNumbers = new Set(
    [
      `${target.series ?? ""}${target.fiscal_number}`,
      target.fiscal_number,
      target.series && target.fiscal_year && Number.isSafeInteger(Number(target.fiscal_number))
        ? fiscalNumberLabel(target.series, target.fiscal_year, Number(target.fiscal_number))
        : null,
    ].map(comparableInvoiceNumber),
  );
  const matchingGroupIds = new Set<string>();
  let searchedGroups = 0;
  let pageNumber = 1;
  while (true) {
    const page = await readPage(pageNumber, target.search_start, target.search_end);
    searchedGroups += page.groups.length;
    for (const group of page.groups) {
      if (
        group.invoices.some(
          (invoice) =>
            invoice.documentType === target.document_type &&
            invoice.invoiceDate.slice(0, 10) === target.document_date &&
            expectedNumbers.has(comparableInvoiceNumber(invoice.number)),
        )
      ) {
        matchingGroupIds.add(group.id);
      }
    }
    if (page.terminal) break;
    pageNumber += 1;
  }
  return {
    searchedGroups,
    providerGroupId: matchingGroupIds.size === 1 ? [...matchingGroupIds][0]! : undefined,
    result:
      matchingGroupIds.size === 1
        ? ("RECOVERED" as const)
        : matchingGroupIds.size === 0
          ? ("NOT_FOUND" as const)
          : ("AMBIGUOUS" as const),
  };
}

export async function recordHistoricalArubaRecovery(
  runId: string,
  remoteDocumentId: string,
  proposedResult: "RECOVERED" | "NOT_FOUND" | "AMBIGUOUS",
  providerGroupId?: string,
) {
  await withTransaction(async (client) => {
    const evidence = await client.query<{ has_xml: boolean; has_group_file: boolean }>(
      `SELECT
         EXISTS (SELECT 1 FROM aruba_files
           WHERE remote_document_id = $1 AND kind = 'ARUBA_XML') AS has_xml,
         EXISTS (SELECT 1 FROM aruba_api_group_files
           WHERE sync_run_id = $2 AND provider_group_id = $3
             AND kind IN ('ARUBA_XML', 'ARUBA_P7M')) AS has_group_file`,
      [remoteDocumentId, runId, providerGroupId ?? null],
    );
    const result =
      proposedResult !== "RECOVERED"
        ? proposedResult
        : evidence.rows[0]?.has_xml
          ? "RECOVERED"
          : evidence.rows[0]?.has_group_file
            ? "GROUP_FILE_ONLY"
            : "AMBIGUOUS";
    await client.query(
      `UPDATE aruba_remote_documents
       SET historical_api_recovery_checked_at = now(), historical_api_recovery_result = $2
       WHERE id = $1`,
      [remoteDocumentId, result],
    );
  });
}
