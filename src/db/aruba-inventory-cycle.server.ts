import { createHash } from "node:crypto";

import type pg from "pg";
import { z } from "zod";

import { ARUBA_PANEL_ORIGIN } from "../aruba.ts";
import { getConfig } from "../config.server.ts";
import { hashToken } from "../crypto.server.ts";
import { AppError } from "../errors.ts";
import { writeAudit } from "./audit.server.ts";
import { getPool, withTransaction } from "./client.server.ts";

interface InventorySessionRow {
  id: string;
  environment: "MOCK" | "PRODUCTION";
  account_reference: string;
  device_id: string;
  started_at: Date;
  absolute_expires_at: Date;
}

const inventorySnapshotSchema = z.object({
  oldestReconciliationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  streams: z
    .array(z.string().regex(/^(?:invoices|credit-notes):\d{4}$/))
    .min(2)
    .max(50),
});

type InventorySnapshot = z.infer<typeof inventorySnapshotSchema>;

function panelUrl(environment: InventorySessionRow["environment"]): string {
  return environment === "PRODUCTION"
    ? `${ARUBA_PANEL_ORIGIN}/`
    : new URL("/aruba-sintetica?scenario=inventory", getConfig().APP_BASE_URL).toString();
}

function cursorStream(environment: string, account: string, stream: string) {
  return `${environment}:${createHash("sha256").update(account).digest("hex").slice(0, 16)}:${stream}`;
}

function bearerParts(token: string) {
  const match = /^([A-Za-z0-9_-]{16,100})\.([A-Za-z0-9_-]{43})$/.exec(token);
  return match ? { deviceId: match[1]! } : null;
}

function romeDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

async function readSession(
  client: pg.Pool | pg.PoolClient,
  token: string,
  lock = false,
): Promise<InventorySessionRow | null> {
  const parts = bearerParts(token);
  if (!parts) return null;
  const result = await client.query<InventorySessionRow>(
    `SELECT id, environment, account_reference, device_id, started_at, absolute_expires_at
     FROM aruba_sync_sessions
     WHERE token_hash = $1 AND device_id = $2 AND status IN ('ACTIVE', 'SCANNING')
       AND absolute_expires_at > now() AND lease_expires_at > now()
     ${lock ? "FOR UPDATE" : ""}`,
    [hashToken(token), parts.deviceId],
  );
  return result.rows[0] ?? null;
}

async function computeInventorySnapshot(
  client: pg.PoolClient,
  session: InventorySessionRow,
): Promise<InventorySnapshot> {
  const [oldest, nonTerminalYears] = await Promise.all([
    client.query<{ oldest: string | null }>(
      `SELECT min(local_order_date)::text AS oldest
       FROM orders
       WHERE trigger_status NOT IN ('INVOICED', 'CANCELLED_NO_DOCUMENT', 'REFUNDED_BEFORE_ISSUE')`,
    ),
    client.query<{ fiscal_year: number }>(
      `SELECT DISTINCT fiscal_year FROM aruba_remote_documents
       WHERE environment = $1 AND account_reference = $2
         AND remote_status IN ('SUBMITTED', 'SDI_PROCESSING', 'UNKNOWN')`,
      [session.environment, session.account_reference],
    ),
  ]);
  const startedDate = romeDate(session.started_at);
  const latestYear = Math.max(
    Number(startedDate.slice(0, 4)),
    Number(romeDate(session.absolute_expires_at).slice(0, 4)),
  );
  const oldestReconciliationDate = oldest.rows[0]?.oldest ?? startedDate;
  const oldestYear = Number(oldestReconciliationDate.slice(0, 4));
  const lowerYear = Math.max(latestYear - 19, Math.min(oldestYear, latestYear));
  const years = new Set<number>(
    Array.from({ length: latestYear - lowerYear + 1 }, (_, index) => latestYear - index),
  );
  for (const row of nonTerminalYears.rows) years.add(row.fiscal_year);
  const snapshot = inventorySnapshotSchema.safeParse({
    oldestReconciliationDate,
    streams: [...years]
      .toSorted((left, right) => right - left)
      .flatMap((year) => [`invoices:${year}`, `credit-notes:${year}`]),
  });
  if (!snapshot.success || new Set(snapshot.data.streams).size !== snapshot.data.streams.length) {
    throw new AppError("ARUBA_INVENTORY_INCOMPLETE", 409);
  }
  return snapshot.data;
}

async function inventorySnapshot(
  client: pg.PoolClient,
  session: InventorySessionRow,
): Promise<InventorySnapshot> {
  const existing = await client.query<{ documents_json: unknown }>(
    `SELECT documents_json FROM aruba_sync_pages
     WHERE sync_session_id = $1 AND stream = '__manifest__'
       AND scan_ordinal = 1 AND page_ordinal = 1`,
    [session.id],
  );
  if (existing.rows[0]) {
    const parsed = inventorySnapshotSchema.safeParse(existing.rows[0].documents_json);
    if (!parsed.success || new Set(parsed.data.streams).size !== parsed.data.streams.length) {
      throw new AppError("ARUBA_INVENTORY_INCOMPLETE", 409);
    }
    return parsed.data;
  }

  const snapshot = await computeInventorySnapshot(client, session);
  const payload = JSON.stringify(snapshot);
  const digest = createHash("sha256").update(payload).digest("hex");
  await client.query(
    `INSERT INTO aruba_sync_pages
       (sync_session_id, stream, scan_ordinal, page_ordinal, cursor, terminal, full_scan,
        row_count, documents_json, payload_digest)
     VALUES ($1, '__manifest__', 1, 1, NULL, true, false, 0, $2, $3)
     ON CONFLICT (sync_session_id, stream, scan_ordinal, page_ordinal) DO NOTHING`,
    [session.id, payload, digest],
  );
  return snapshot;
}

export async function arubaInventoryManifest(token: string) {
  return withTransaction(async (client) => {
    const session = await readSession(client, token, true);
    if (!session) throw new AppError("ARUBA_READ_SESSION_INVALID", 401);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `aruba-read:${session.environment}:${session.account_reference}`,
    ]);
    const snapshot = await inventorySnapshot(client, session);
    const scopedStreams = snapshot.streams.map((stream) =>
      cursorStream(session.environment, session.account_reference, stream),
    );
    const [cursors, interrupted] = await Promise.all([
      client.query<{
        stream: string;
        cursor: string | null;
        overlap_from: Date | null;
        last_page_ordinal: number | null;
        full_scan_completed_at: Date | null;
      }>(
        `SELECT stream, cursor, overlap_from, last_page_ordinal, full_scan_completed_at
         FROM sync_cursors WHERE provider = 'ARUBA' AND stream = ANY($1::text[])`,
        [scopedStreams],
      ),
      client.query<{ stream: string; page_ordinal: number }>(
        `SELECT DISTINCT ON (stream) stream, page_ordinal
         FROM aruba_sync_pages
         WHERE sync_session_id = $1 AND NOT terminal AND stream <> '__manifest__'
         ORDER BY stream, committed_at DESC`,
        [session.id],
      ),
    ]);
    const byStream = new Map(cursors.rows.map((row) => [row.stream, row]));
    const resume = new Map(interrupted.rows.map((row) => [row.stream, row.page_ordinal]));
    return {
      operation: "READ_SYNC" as const,
      sessionId: session.id,
      environment: session.environment,
      accountReference: session.account_reference,
      panelUrl: panelUrl(session.environment),
      oldestReconciliationDate: snapshot.oldestReconciliationDate,
      streams: snapshot.streams.map((stream) => {
        const scoped = cursorStream(session.environment, session.account_reference, stream);
        const cursor = byStream.get(scoped);
        return {
          name: stream,
          cursor: cursor?.cursor ?? null,
          overlapFrom: cursor?.overlap_from?.toISOString() ?? null,
          lastFullScanCompletedAt: cursor?.full_scan_completed_at?.toISOString() ?? null,
          resumePageOrdinal: resume.get(stream) ?? null,
        };
      }),
      intervalSeconds: 900,
      absoluteExpiresAt: session.absolute_expires_at.toISOString(),
    };
  });
}

interface CompletionResult {
  completed: boolean;
  incomplete: boolean;
}

export async function completeStableArubaInventory(
  token: string,
  rawStreams: unknown,
  rawScanOrdinal: unknown,
  rawFullScan: unknown,
) {
  const streams = z
    .array(z.string().regex(/^(?:invoices|credit-notes):\d{4}$/))
    .min(2)
    .max(50)
    .safeParse(rawStreams);
  const scanOrdinal = z.number().int().positive().max(100_000).safeParse(rawScanOrdinal);
  const fullScan = z.boolean().safeParse(rawFullScan);
  if (
    !streams.success ||
    !scanOrdinal.success ||
    !fullScan.success ||
    new Set(streams.data).size !== streams.data.length
  ) {
    throw new AppError("ARUBA_INVENTORY_INCOMPLETE", 422);
  }

  const outcome = await withTransaction<CompletionResult>(async (client) => {
    const session = await readSession(client, token, true);
    if (!session) throw new AppError("ARUBA_READ_SESSION_INVALID", 401);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `aruba-read:${session.environment}:${session.account_reference}`,
    ]);
    const snapshot = await inventorySnapshot(client, session);
    const expectedStreams = snapshot.streams;
    if (
      streams.data.length !== expectedStreams.length ||
      streams.data.some((stream, index) => stream !== expectedStreams[index])
    ) {
      await client.query(
        `UPDATE aruba_sync_sessions SET status = 'INCOMPLETE', lease_expires_at = NULL,
           failed_at = now(), error_code = 'ARUBA_INVENTORY_INCOMPLETE',
           error_message_sanitized = 'Perimetro stream non coerente con la sessione'
         WHERE id = $1`,
        [session.id],
      );
      return { completed: false, incomplete: true };
    }

    const pageCoverage = await client.query<{
      stream: string;
      page_count: number;
      max_ordinal: number;
      terminal_count: number;
      terminal_ordinal: number | null;
      mode_count: number;
    }>(
      `SELECT stream, count(*)::integer AS page_count, max(page_ordinal)::integer AS max_ordinal,
              count(*) FILTER (WHERE terminal)::integer AS terminal_count,
              max(page_ordinal) FILTER (WHERE terminal)::integer AS terminal_ordinal,
              count(*) FILTER (WHERE full_scan = $3)::integer AS mode_count
       FROM aruba_sync_pages
       WHERE sync_session_id = $1 AND scan_ordinal = $2 AND stream <> '__manifest__'
       GROUP BY stream`,
      [session.id, scanOrdinal.data, fullScan.data],
    );
    const byStream = new Map(pageCoverage.rows.map((row) => [row.stream, row]));
    if (
      expectedStreams.some((stream) => {
        const row = byStream.get(stream);
        return (
          !row ||
          row.page_count !== row.max_ordinal ||
          row.terminal_count !== 1 ||
          row.terminal_ordinal !== row.max_ordinal ||
          row.mode_count !== row.page_count
        );
      })
    ) {
      await client.query(
        `UPDATE aruba_sync_sessions SET status = 'INCOMPLETE', lease_expires_at = NULL,
           failed_at = now(), error_code = 'ARUBA_INVENTORY_INCOMPLETE',
           error_message_sanitized = 'Stream incompleti'
         WHERE id = $1`,
        [session.id],
      );
      return { completed: false, incomplete: true };
    }

    if (fullScan.data) {
      const missing = await client.query<{ id: string }>(
        `SELECT DISTINCT remote.id
         FROM aruba_remote_observations AS previous
         JOIN aruba_remote_documents AS remote ON remote.id = previous.remote_document_id
         JOIN aruba_sync_pages AS previous_page
           ON previous_page.sync_session_id = previous.sync_session_id
          AND previous_page.stream = previous.stream
          AND previous_page.scan_ordinal = previous.scan_ordinal
          AND previous_page.page_ordinal = previous.page_ordinal
         JOIN aruba_sync_sessions AS previous_session
           ON previous_session.id = previous.sync_session_id
         WHERE remote.environment = $1 AND remote.account_reference = $2
           AND previous.stream = ANY($3::text[])
           AND previous_page.full_scan
           AND previous_session.full_scan_completed_at IS NOT NULL
           AND previous_page.committed_at <= previous_session.full_scan_completed_at
           AND NOT EXISTS (
             SELECT 1 FROM aruba_remote_observations AS current
             WHERE current.remote_document_id = previous.remote_document_id
               AND current.sync_session_id = $4 AND current.scan_ordinal = $5
               AND current.stream = previous.stream
           )`,
        [
          session.environment,
          session.account_reference,
          expectedStreams,
          session.id,
          scanOrdinal.data,
        ],
      );
      if (missing.rows.length) {
        const missingIds = missing.rows.map((row) => row.id);
        await client.query(
          `INSERT INTO aruba_remote_observations
            (remote_document_id, sync_session_id, remote_status, stream, scan_ordinal,
             page_ordinal, cursor, payload_digest, error_code)
           SELECT remote.id, $1, remote.remote_status, previous.stream, $2,
                  terminal.page_ordinal, terminal.cursor, remote.metadata_digest, 'NOT_FOUND'
           FROM aruba_remote_documents AS remote
           JOIN LATERAL (
             SELECT observations.stream FROM aruba_remote_observations AS observations
             WHERE observations.remote_document_id = remote.id
               AND observations.stream = ANY($3::text[])
             ORDER BY observations.observed_at DESC LIMIT 1
           ) AS previous ON true
           JOIN LATERAL (
             SELECT pages.page_ordinal, pages.cursor FROM aruba_sync_pages AS pages
             WHERE pages.sync_session_id = $1 AND pages.scan_ordinal = $2
               AND pages.stream = previous.stream AND pages.terminal
             LIMIT 1
           ) AS terminal ON true
           WHERE remote.id = ANY($4::bigint[])
           ON CONFLICT DO NOTHING`,
          [session.id, scanOrdinal.data, expectedStreams, missingIds],
        );
        await client.query(
          `UPDATE aruba_document_matches SET status = 'UNKNOWN_REMOTE_STATE', method = 'NONE',
             matcher_version = 1, updated_at = now()
           WHERE remote_document_id = ANY($1::bigint[])`,
          [missingIds],
        );
      }
    }

    await client.query(
      `UPDATE aruba_sync_sessions SET status = 'ACTIVE', completed_at = now(),
         full_scan_completed_at = CASE WHEN $2 THEN now() ELSE full_scan_completed_at END,
         lease_expires_at = least(absolute_expires_at, now() + interval '2 minutes'),
         error_code = NULL, error_message_sanitized = NULL
       WHERE id = $1`,
      [session.id, fullScan.data],
    );
    if (fullScan.data) {
      await client.query(
        `UPDATE sync_cursors SET full_scan_completed_at = now(), updated_at = now()
         WHERE provider = 'ARUBA' AND stream = ANY($1::text[])`,
        [
          expectedStreams.map((stream) =>
            cursorStream(session.environment, session.account_reference, stream),
          ),
        ],
      );
    }
    await client.query(
      `INSERT INTO connections
        (provider, environment, account_reference, encrypted_credentials, status,
         last_checked_at, last_synced_at)
       VALUES ('ARUBA', $1, $2, NULL, 'CONNECTED', now(), now())
       ON CONFLICT (provider, environment) DO UPDATE SET
         account_reference = EXCLUDED.account_reference, status = 'CONNECTED',
         last_checked_at = now(), last_synced_at = now(), updated_at = now(),
         last_error_code = NULL, last_error_message_sanitized = NULL`,
      [
        session.environment === "PRODUCTION" ? "PRODUCTION" : "DEVELOPMENT",
        session.account_reference,
      ],
    );
    await writeAudit(client, {
      actorType: "SYSTEM",
      action: "ARUBA_INVENTORY_COMPLETED",
      eventClass: "OPERATIONAL",
      entityType: "ARUBA_SYNC_SESSION",
      entityId: session.id,
      metadata: { streamCount: expectedStreams.length, fullScan: fullScan.data },
      requestId: `aruba-read:${session.id}`,
    });
    return { completed: true, incomplete: false };
  });

  if (outcome.incomplete) throw new AppError("ARUBA_INVENTORY_INCOMPLETE", 409);
  return { completed: outcome.completed };
}
