import type pg from "pg";

import { getConfig } from "../config.server.ts";
import { arubaUnresolvedCandidateSql } from "./billing-case-sql.server.ts";
import { getPool } from "./client.server.ts";

function environment(): "MOCK" | "PRODUCTION" {
  return getConfig().APP_ENV === "production" ? "PRODUCTION" : "MOCK";
}

function accountReference() {
  return getConfig().ARUBA_ACCOUNT_REFERENCE;
}

export interface ArubaInventoryHealth {
  status: "NEVER" | "HEALTHY" | "WARNING" | "BLOCKED";
  blocking: boolean;
  lastCompletedAt: string | null;
  ageMinutes: number | null;
  activeSession: boolean;
  activeDeviceSuffix: string | null;
  activeSessionExpiresAt: string | null;
  nextScheduledAt: string | null;
  lastErrorCode: string | null;
  externalDocuments: number;
  potentialMatches: number;
  ambiguous: number;
  conflicts: number;
  remoteDocuments: number;
  blockingReason: "NEVER" | "STALE" | "FAILURE" | "CONFLICT" | null;
}

export const arubaPotentialMatchPredicate = `(matches.status = 'UNMATCHED'
  AND matches.method <> 'MANUAL'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(matches.candidates_json) candidate
    WHERE ${arubaUnresolvedCandidateSql("candidate")}
      OR coalesce((candidate -> 'signals' ->> 'explicitReference')::boolean, false)
  ))`;

export const arubaExternalDocumentPredicate = `(matches.status = 'UNMATCHED' AND (
  (matches.method = 'MANUAL' AND remote.origin = 'ARUBA_EXTERNAL')
  OR (matches.method <> 'MANUAL' AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(matches.candidates_json) candidate
    WHERE ${arubaUnresolvedCandidateSql("candidate")}
      OR coalesce((candidate -> 'signals' ->> 'explicitReference')::boolean, false)
  ))
))`;

export const arubaBlockingMatchPredicate = `(remote.remote_status <> 'REJECTED' AND (
  ${arubaPotentialMatchPredicate}
  OR matches.status IN ('AMBIGUOUS', 'PROFILE_CONFLICT', 'ERROR', 'UNKNOWN_REMOTE_STATE')
))`;

export async function getArubaInventoryHealth(
  client: pg.Pool | pg.PoolClient = getPool(),
): Promise<ArubaInventoryHealth> {
  const result = await client.query<{
    last_completed_at: Date | null;
    last_full_scan_completed_at: Date | null;
    active_session: boolean;
    active_device_suffix: string | null;
    active_session_expires_at: Date | null;
    next_scheduled_at: Date | null;
    last_error_code: string | null;
    unresolved_failure: boolean;
    external_documents: string;
    potential_matches: string;
    ambiguous: string;
    conflicts: string;
    remote_documents: string;
  }>(
    `WITH authority AS (
       SELECT coalesce((SELECT automatic_authority FROM connections
         WHERE provider = 'ARUBA'
           AND environment = CASE WHEN $1 = 'PRODUCTION' THEN 'PRODUCTION' ELSE 'DEVELOPMENT' END
           AND account_reference = $2), 'BROWSER') AS value
     )
     SELECT
       CASE WHEN (SELECT value FROM authority) = 'API' THEN
         (SELECT max(completed_at) FROM aruba_sync_runs
          WHERE environment = $1 AND account_reference = $2 AND status = 'COMPLETED'
            AND authority_mode = 'CANONICAL')
       ELSE
         (SELECT max(completed_at) FROM aruba_sync_sessions
          WHERE environment = $1 AND account_reference = $2 AND completed_at IS NOT NULL)
       END AS last_completed_at,
       CASE WHEN (SELECT value FROM authority) = 'API' THEN
         (SELECT max(full_scan_completed_at) FROM aruba_sync_runs
          WHERE environment = $1 AND account_reference = $2
            AND status = 'COMPLETED' AND authority_mode = 'CANONICAL'
            AND full_scan_completed_at IS NOT NULL)
       ELSE
         (SELECT max(full_scan_completed_at) FROM aruba_sync_sessions
          WHERE environment = $1 AND account_reference = $2
            AND full_scan_completed_at IS NOT NULL)
       END AS last_full_scan_completed_at,
       CASE WHEN (SELECT value FROM authority) = 'API' THEN
         EXISTS (SELECT 1 FROM aruba_sync_runs
          WHERE environment = $1 AND account_reference = $2
            AND status = 'RUNNING' AND authority_mode = 'CANONICAL'
            AND lease_expires_at > now())
       ELSE
         EXISTS (SELECT 1 FROM aruba_sync_sessions
          WHERE environment = $1 AND account_reference = $2
            AND status IN ('ACTIVE', 'SCANNING') AND absolute_expires_at > now()
            AND lease_expires_at > now() AND last_heartbeat_at > now() - interval '2 minutes')
       END AS active_session,
       CASE WHEN (SELECT value FROM authority) = 'BROWSER' THEN
         (SELECT right(device_id, 6) FROM aruba_sync_sessions
          WHERE environment = $1 AND account_reference = $2 AND status IN ('ACTIVE', 'SCANNING')
            AND absolute_expires_at > now() AND lease_expires_at > now()
            AND last_heartbeat_at > now() - interval '2 minutes'
          ORDER BY started_at DESC LIMIT 1)
       END AS active_device_suffix,
       CASE WHEN (SELECT value FROM authority) = 'API' THEN
         (SELECT lease_expires_at FROM aruba_sync_runs
          WHERE environment = $1 AND account_reference = $2 AND status = 'RUNNING'
            AND authority_mode = 'CANONICAL'
          ORDER BY started_at DESC LIMIT 1)
       ELSE
         (SELECT absolute_expires_at FROM aruba_sync_sessions
          WHERE environment = $1 AND account_reference = $2 AND status IN ('ACTIVE', 'SCANNING')
            AND absolute_expires_at > now() AND lease_expires_at > now()
            AND last_heartbeat_at > now() - interval '2 minutes'
          ORDER BY started_at DESC LIMIT 1)
       END AS active_session_expires_at,
       CASE WHEN (SELECT value FROM authority) = 'API' THEN
         (SELECT coalesce(completed_at, started_at) + interval '15 minutes'
          FROM aruba_sync_runs WHERE environment = $1 AND account_reference = $2
            AND authority_mode = 'CANONICAL'
          ORDER BY started_at DESC LIMIT 1)
       ELSE
         (SELECT coalesce(completed_at, last_heartbeat_at, started_at) + interval '15 minutes'
          FROM aruba_sync_sessions WHERE environment = $1 AND account_reference = $2
          ORDER BY started_at DESC LIMIT 1)
       END AS next_scheduled_at,
       CASE WHEN (SELECT value FROM authority) = 'API' THEN
         (SELECT last_error_code FROM aruba_sync_runs
          WHERE environment = $1 AND account_reference = $2
            AND authority_mode = 'CANONICAL' AND last_error_code IS NOT NULL
            AND started_at > coalesce((SELECT max(completed_at) FROM aruba_sync_runs
              WHERE environment = $1 AND account_reference = $2
                AND status = 'COMPLETED' AND authority_mode = 'CANONICAL'), '-infinity')
          ORDER BY started_at DESC LIMIT 1)
       ELSE
         (SELECT error_code FROM aruba_sync_sessions
          WHERE environment = $1 AND account_reference = $2
            AND status IN ('FAILED', 'INCOMPLETE') AND error_code IS NOT NULL
            AND coalesce(failed_at, started_at) > coalesce((SELECT max(completed_at)
              FROM aruba_sync_sessions WHERE environment = $1 AND account_reference = $2
                AND completed_at IS NOT NULL), '-infinity')
          ORDER BY started_at DESC LIMIT 1)
       END AS last_error_code,
       CASE WHEN (SELECT value FROM authority) = 'API' THEN
         EXISTS (SELECT 1 FROM aruba_sync_runs AS failed
          WHERE failed.environment = $1 AND failed.account_reference = $2
            AND failed.authority_mode = 'CANONICAL'
            AND (failed.status IN ('FAILED', 'INCOMPLETE')
              OR (failed.status = 'RUNNING' AND failed.lease_expires_at <= now()
                AND failed.last_error_code IS NOT NULL))
            AND failed.started_at > coalesce((SELECT max(completed_at) FROM aruba_sync_runs
              WHERE environment = $1 AND account_reference = $2
                AND status = 'COMPLETED' AND authority_mode = 'CANONICAL'), '-infinity'))
       ELSE
         EXISTS (SELECT 1 FROM aruba_sync_sessions AS failed
          WHERE failed.environment = $1 AND failed.account_reference = $2
            AND failed.status IN ('FAILED', 'INCOMPLETE')
            AND coalesce(failed.failed_at, failed.started_at) > coalesce((SELECT max(completed_at)
              FROM aruba_sync_sessions WHERE environment = $1 AND account_reference = $2
                AND completed_at IS NOT NULL), '-infinity'))
       END AS unresolved_failure,
       (SELECT count(*) FROM aruba_document_matches matches
        JOIN aruba_remote_documents remote ON remote.id = matches.remote_document_id
        WHERE remote.environment = $1 AND remote.account_reference = $2
          AND ${arubaExternalDocumentPredicate}) AS external_documents,
       (SELECT count(*) FROM aruba_document_matches matches
        JOIN aruba_remote_documents remote ON remote.id = matches.remote_document_id
        WHERE remote.environment = $1 AND remote.account_reference = $2
          AND remote.remote_status <> 'REJECTED'
          AND ${arubaPotentialMatchPredicate}) AS potential_matches,
       (SELECT count(*) FROM aruba_document_matches matches
        JOIN aruba_remote_documents remote ON remote.id = matches.remote_document_id
        WHERE remote.environment = $1 AND remote.account_reference = $2
          AND remote.remote_status <> 'REJECTED' AND matches.status = 'AMBIGUOUS') AS ambiguous,
       (SELECT count(*) FROM aruba_document_matches matches
        JOIN aruba_remote_documents remote ON remote.id = matches.remote_document_id
        WHERE remote.environment = $1 AND remote.account_reference = $2
          AND remote.remote_status <> 'REJECTED'
          AND matches.status IN ('PROFILE_CONFLICT', 'ERROR', 'UNKNOWN_REMOTE_STATE')) AS conflicts,
       (SELECT count(*) FROM aruba_remote_documents
        WHERE environment = $1 AND account_reference = $2) AS remote_documents`,
    [environment(), accountReference()],
  );
  const row = result.rows[0]!;
  const completed = row.last_full_scan_completed_at ? row.last_completed_at : null;
  const ageMinutes = completed ? Math.max(0, (Date.now() - completed.getTime()) / 60_000) : null;
  const unresolved = Number(row.potential_matches) + Number(row.ambiguous) + Number(row.conflicts);
  const blockingReason = !completed
    ? "NEVER"
    : row.unresolved_failure
      ? "FAILURE"
      : unresolved > 0
        ? "CONFLICT"
        : (ageMinutes ?? Infinity) > 4 * 60
          ? "STALE"
          : null;
  const status = !completed
    ? "NEVER"
    : row.unresolved_failure || unresolved > 0 || (ageMinutes ?? Infinity) > 4 * 60
      ? "BLOCKED"
      : (ageMinutes ?? 0) > 30
        ? "WARNING"
        : "HEALTHY";
  return {
    status,
    blocking: status === "NEVER" || status === "BLOCKED",
    lastCompletedAt: completed?.toISOString() ?? null,
    ageMinutes,
    activeSession: row.active_session,
    activeDeviceSuffix: row.active_device_suffix,
    activeSessionExpiresAt: row.active_session_expires_at?.toISOString() ?? null,
    nextScheduledAt: row.next_scheduled_at?.toISOString() ?? null,
    lastErrorCode: row.last_error_code,
    externalDocuments: Number(row.external_documents),
    potentialMatches: Number(row.potential_matches),
    ambiguous: Number(row.ambiguous),
    conflicts: Number(row.conflicts),
    remoteDocuments: Number(row.remote_documents),
    blockingReason,
  };
}

export async function getLockedArubaInventoryHealth(client: pg.PoolClient) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `aruba-read:${environment()}:${accountReference()}`,
  ]);
  return getArubaInventoryHealth(client);
}
