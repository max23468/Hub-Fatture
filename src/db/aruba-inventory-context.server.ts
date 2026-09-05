import { createHash } from "node:crypto";

import type pg from "pg";

import { getConfig } from "../config.server.ts";
import { localOrderDate } from "../orders.ts";

export interface ArubaReadActor {
  id: number;
  canApprove: boolean;
  requestId: string;
}

export function arubaRuntimeEnvironment(): "MOCK" | "PRODUCTION" {
  return getConfig().APP_ENV === "production" ? "PRODUCTION" : "MOCK";
}

export function arubaAccountReference(): string {
  return getConfig().ARUBA_ACCOUNT_REFERENCE;
}

export async function lockArubaInventory(
  client: pg.PoolClient,
  environment = arubaRuntimeEnvironment(),
  accountReference = arubaAccountReference(),
) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `aruba-read:${environment}:${accountReference}`,
  ]);
}

export function arubaPayloadDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** La decisione vale solo per le due osservazioni effettivamente verificate. */
export async function refreshArubaIdentityResolutions(
  client: pg.PoolClient,
  remoteId: string,
  reopen = false,
) {
  const reopened = await client.query<{ evidence: Record<string, string> }>(
    `UPDATE aruba_deduplication_conflicts conflicts SET resolved_at = NULL
     WHERE resolved_at IS NOT NULL AND resolution_json -> 'evidence' ? $1
       AND ($2::boolean OR EXISTS (
         SELECT 1 FROM jsonb_each_text(resolution_json -> 'evidence') evidence
         LEFT JOIN aruba_remote_documents member ON member.id::text = evidence.key
         LEFT JOIN aruba_document_matches match ON match.remote_document_id = member.id
         WHERE member.metadata_digest IS DISTINCT FROM evidence.value
           OR member.remote_status IS DISTINCT FROM (resolution_json -> 'statuses' ->> evidence.key)
           OR (SELECT storage.sha256 FROM aruba_files files JOIN storage_objects storage ON storage.id = files.storage_object_id
               WHERE files.remote_document_id = member.id AND files.kind = 'ARUBA_XML'
               ORDER BY files.id DESC LIMIT 1) IS DISTINCT FROM (resolution_json -> 'xmlHashes' ->> evidence.key)
           OR coalesce((match.signals_json ->> 'remoteObservationConflict')::boolean, false)
       ))
     RETURNING resolution_json -> 'evidence' AS evidence`,
    [remoteId, reopen],
  );
  const ids = [...new Set(reopened.rows.flatMap((row) => Object.keys(row.evidence)))];
  if (ids.length)
    await client.query(
      `UPDATE aruba_document_matches SET status = 'UNKNOWN_REMOTE_STATE', method = 'NONE',
       signals_json = (signals_json - 'identityCollisionExcluded') ||
         '{"providerIdentityCollision":true,"identityCollisionCandidatesVerified":false}', updated_at = now()
     WHERE remote_document_id = ANY($1::bigint[])`,
      [ids],
    );
}

export function arubaCursorStream(environment: string, accountReference: string, stream: string) {
  const accountDigest = createHash("sha256").update(accountReference).digest("hex").slice(0, 16);
  return `${environment}:${accountDigest}:${stream}`;
}

export async function requiredArubaInventoryCoverage(client: pg.Pool | pg.PoolClient) {
  const oldest = await client.query<{ oldest: string | null }>(
    `SELECT min(local_order_date)::text AS oldest
       FROM orders
       WHERE trigger_status NOT IN ('INVOICED', 'CANCELLED_NO_DOCUMENT', 'REFUNDED_BEFORE_ISSUE')`,
  );
  // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- La copertura usa lo stesso snapshot logico delle date locali.
  const nonTerminalYears = await client.query<{ fiscal_year: number }>(
    `SELECT DISTINCT fiscal_year FROM aruba_remote_documents
       WHERE environment = $1 AND account_reference = $2
         AND remote_status IN ('SUBMITTED', 'SDI_PROCESSING', 'UNKNOWN')`,
    [arubaRuntimeEnvironment(), arubaAccountReference()],
  );
  const currentDate = localOrderDate(new Date().toISOString());
  const currentYear = Number(currentDate.slice(0, 4));
  const oldestDate = oldest.rows[0]?.oldest ?? currentDate;
  const oldestYear = Number(oldestDate.slice(0, 4));
  const years = new Set<number>(
    Array.from(
      { length: Math.max(1, Math.min(20, currentYear - oldestYear + 1)) },
      (_, index) => currentYear - index,
    ),
  );
  for (const row of nonTerminalYears.rows) years.add(row.fiscal_year);
  return {
    oldestReconciliationDate: oldestDate,
    streams: [...years]
      .toSorted((left, right) => right - left)
      .flatMap((year) => [`invoices:${year}`, `credit-notes:${year}`]),
  };
}

export async function currentArubaInventoryWatermark(client: pg.Pool | pg.PoolClient) {
  const result = await client.query<{ value: string }>(
    `SELECT greatest(
       coalesce((SELECT max(inventory_watermark) FROM aruba_sync_sessions
         WHERE environment = $1 AND account_reference = $2), 0),
       coalesce((SELECT max(inventory_version) FROM aruba_remote_documents
         WHERE environment = $1 AND account_reference = $2), 0)
     )::text AS value`,
    [arubaRuntimeEnvironment(), arubaAccountReference()],
  );
  return Number(result.rows[0]?.value ?? 0);
}
