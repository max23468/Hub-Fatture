import type pg from "pg";

import { ARUBA_API_POLICY } from "../aruba-api-policy.ts";
import { getConfig } from "../config.server.ts";
import { arubaActionableCandidateSql } from "./billing-case-sql.server.ts";
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
  uncertainRemoteStates: number;
  remoteDocuments: number;
  blockingReason: "NEVER" | "STALE" | "FAILURE" | "CONFLICT" | null;
}

const arubaActionableCandidatesPredicate = `EXISTS (
    SELECT 1 FROM jsonb_array_elements(matches.candidates_json) candidate
    WHERE ${arubaActionableCandidateSql("candidate", "remote")}
  )`;

export const arubaPotentialMatchPredicate = `(matches.status = 'UNMATCHED'
  AND matches.method <> 'MANUAL'
  AND ${arubaActionableCandidatesPredicate})`;

export const arubaAmbiguousMatchPredicate = `(matches.status = 'AMBIGUOUS'
  AND matches.method <> 'MANUAL'
  AND ${arubaActionableCandidatesPredicate})`;

export const arubaConflictMatchPredicate = `(
  (matches.status = 'PROFILE_CONFLICT'
    AND matches.method <> 'MANUAL'
    AND ${arubaActionableCandidatesPredicate})
  OR matches.status IN ('ERROR', 'UNKNOWN_REMOTE_STATE')
)`;

export const arubaExternalDocumentPredicate = `(matches.status = 'UNMATCHED' AND (
  (matches.method = 'MANUAL' AND remote.origin = 'ARUBA_EXTERNAL')
  OR (matches.method <> 'MANUAL' AND NOT (${arubaPotentialMatchPredicate}))
))`;

export const arubaBlockingMatchPredicate = `(remote.remote_status <> 'REJECTED' AND (
  ${arubaPotentialMatchPredicate}
  OR ${arubaAmbiguousMatchPredicate}
  OR ${arubaConflictMatchPredicate}
))`;

/** Una collisione resta locale solo dopo il confronto di entrambi gli ID canonici. */
export const arubaBoundedIdentityCollisionPredicate = `(
  matches.status = 'UNKNOWN_REMOTE_STATE'
  AND matches.signals_json @> '{"providerIdentityCollision":true,"identityCollisionCandidatesVerified":true}'
  AND remote.remote_status <> 'UNKNOWN'
  AND EXISTS (
    SELECT 1 FROM aruba_deduplication_conflicts collision
    WHERE collision.environment = remote.environment
      AND collision.account_reference = remote.account_reference
      AND collision.resolved_at IS NULL
      AND (collision.existing_remote_document_id = remote.id
        OR collision.incoming_remote_id = remote.remote_id)
  )
  AND NOT EXISTS (
    SELECT 1 FROM aruba_deduplication_conflicts collision
    WHERE collision.environment = remote.environment
      AND collision.account_reference = remote.account_reference
      AND collision.resolved_at IS NULL
      AND (collision.existing_remote_document_id = remote.id
        OR collision.incoming_remote_id = remote.remote_id)
      AND (SELECT count(*) FROM aruba_remote_documents member
        JOIN aruba_document_matches member_match ON member_match.remote_document_id = member.id
        WHERE member.environment = collision.environment
          AND member.account_reference = collision.account_reference
          AND (member.id = collision.existing_remote_document_id
            OR member.remote_id = collision.incoming_remote_id)
          AND member.remote_status <> 'UNKNOWN'
          AND member_match.status = 'UNKNOWN_REMOTE_STATE'
          AND member_match.signals_json @> '{"providerIdentityCollision":true,"identityCollisionCandidatesVerified":true}'
          AND NOT coalesce((member_match.signals_json ->> 'remoteObservationConflict')::boolean, false)
      ) <> 2
  )
)`;

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
    uncertain_remote_states: string;
    remote_documents: string;
  }>(
    `SELECT
       (SELECT max(completed_at) FROM aruba_sync_runs
        WHERE environment = $1 AND account_reference = $2 AND status = 'COMPLETED'
          AND authority_mode = 'CANONICAL') AS last_completed_at,
       (SELECT max(full_scan_completed_at) FROM aruba_sync_runs
        WHERE environment = $1 AND account_reference = $2
          AND status = 'COMPLETED'
          AND full_scan_completed_at IS NOT NULL) AS last_full_scan_completed_at,
       EXISTS (SELECT 1 FROM aruba_sync_runs
        WHERE environment = $1 AND account_reference = $2
          AND status = 'RUNNING' AND authority_mode = 'CANONICAL'
          AND lease_expires_at > now()) AS active_session,
       NULL::text AS active_device_suffix,
       (SELECT lease_expires_at FROM aruba_sync_runs
        WHERE environment = $1 AND account_reference = $2 AND status = 'RUNNING'
          AND authority_mode = 'CANONICAL'
        ORDER BY started_at DESC LIMIT 1) AS active_session_expires_at,
       (SELECT coalesce(completed_at, started_at) + interval '15 minutes'
        FROM aruba_sync_runs WHERE environment = $1 AND account_reference = $2
          AND authority_mode = 'CANONICAL'
        ORDER BY started_at DESC LIMIT 1) AS next_scheduled_at,
       (SELECT last_error_code FROM aruba_sync_runs
        WHERE environment = $1 AND account_reference = $2
          AND authority_mode = 'CANONICAL' AND last_error_code IS NOT NULL
          AND started_at > coalesce((SELECT max(completed_at) FROM aruba_sync_runs
            WHERE environment = $1 AND account_reference = $2
              AND status = 'COMPLETED' AND authority_mode = 'CANONICAL'), '-infinity')
        ORDER BY started_at DESC LIMIT 1) AS last_error_code,
       EXISTS (SELECT 1 FROM aruba_sync_runs AS failed
        WHERE failed.environment = $1 AND failed.account_reference = $2
          AND failed.authority_mode = 'CANONICAL'
          AND (failed.status IN ('FAILED', 'INCOMPLETE')
            OR (failed.status = 'RUNNING' AND failed.lease_expires_at <= now()
              AND failed.last_error_code IS NOT NULL))
          AND failed.started_at > coalesce((SELECT max(completed_at) FROM aruba_sync_runs
            WHERE environment = $1 AND account_reference = $2
              AND status = 'COMPLETED' AND authority_mode = 'CANONICAL'), '-infinity'))
       AS unresolved_failure,
       (SELECT count(*) FROM aruba_document_matches matches
        JOIN aruba_remote_documents remote ON remote.id = matches.remote_document_id
        WHERE remote.environment = $1 AND remote.account_reference = $2
          AND remote.document_date >= $3::date
          AND ${arubaExternalDocumentPredicate}) AS external_documents,
       (SELECT count(*) FROM aruba_document_matches matches
        JOIN aruba_remote_documents remote ON remote.id = matches.remote_document_id
        WHERE remote.environment = $1 AND remote.account_reference = $2
          AND remote.document_date >= $3::date
          AND remote.remote_status <> 'REJECTED'
          AND ${arubaPotentialMatchPredicate}) AS potential_matches,
       (SELECT count(*) FROM aruba_document_matches matches
        JOIN aruba_remote_documents remote ON remote.id = matches.remote_document_id
        WHERE remote.environment = $1 AND remote.account_reference = $2
          AND remote.document_date >= $3::date
          AND remote.remote_status <> 'REJECTED'
          AND ${arubaAmbiguousMatchPredicate}) AS ambiguous,
       (SELECT count(*) FROM aruba_document_matches matches
        JOIN aruba_remote_documents remote ON remote.id = matches.remote_document_id
        WHERE remote.environment = $1 AND remote.account_reference = $2
          AND remote.document_date >= $3::date
          AND remote.remote_status <> 'REJECTED'
          AND ${arubaConflictMatchPredicate}) AS conflicts,
       (SELECT count(*) FROM aruba_document_matches matches
        JOIN aruba_remote_documents remote ON remote.id = matches.remote_document_id
        WHERE remote.environment = $1 AND remote.account_reference = $2
          AND remote.document_date >= $3::date
          AND remote.remote_status <> 'REJECTED'
          AND matches.status IN ('ERROR', 'UNKNOWN_REMOTE_STATE')
          AND NOT ${arubaBoundedIdentityCollisionPredicate}) AS uncertain_remote_states,
       (SELECT count(*) FROM aruba_remote_documents
        WHERE environment = $1 AND account_reference = $2
          AND document_date >= $3::date) AS remote_documents`,
    [environment(), accountReference(), ARUBA_API_POLICY.inventoryStart],
  );
  const row = result.rows[0]!;
  // Il FULL API qualificato precede il cutover e conserva intenzionalmente la provenienza
  // storica SHADOW. Dopo il passaggio atomico dell'autorità all'API è la baseline canonica;
  // riscrivere authority_mode falsificherebbe invece l'audit dell'esecuzione originaria.
  const completed = row.last_full_scan_completed_at
    ? (row.last_completed_at ?? row.last_full_scan_completed_at)
    : null;
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
    uncertainRemoteStates: Number(row.uncertain_remote_states),
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
