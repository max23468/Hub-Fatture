import { randomUUID } from "node:crypto";

import type pg from "pg";
import { z } from "zod";

import { inventoryPageSchema, type RemoteInventoryDocument } from "../aruba-inbound.ts";
import { AppError } from "../errors.ts";
import { writeAudit } from "./audit.server.ts";
import { ingestParsedArubaPage, type ArubaPageIngestContext } from "./aruba-inbound.server.ts";
import { arubaBlockingMatchPredicate } from "./aruba-inventory-health.server.ts";
import {
  arubaAccountReference as accountReference,
  arubaPayloadDigest as payloadDigest,
  arubaRuntimeEnvironment as environment,
  requiredArubaInventoryCoverage,
  type ArubaReadActor,
} from "./aruba-inventory-context.server.ts";
import { getPool, withTransaction } from "./client.server.ts";

async function manualCoverage(client: pg.Pool | pg.PoolClient) {
  return requiredArubaInventoryCoverage(client);
}

async function expireStaleArubaReadSessions(client: pg.PoolClient) {
  await client.query(
    `UPDATE aruba_sync_sessions SET status = 'EXPIRED', lease_expires_at = NULL
     WHERE environment = $1 AND account_reference = $2
       AND status IN ('ACTIVE', 'SCANNING')
       AND (absolute_expires_at <= now() OR coalesce(lease_expires_at, '-infinity') <= now())`,
    [environment(), accountReference()],
  );
}

function parsedManualPages(raw: unknown) {
  const parsed = z.array(inventoryPageSchema).min(1).max(500).safeParse(raw);
  if (!parsed.success || parsed.data.some((page) => !page.fullScan)) {
    throw new AppError("ARUBA_INVENTORY_INVALID", 422);
  }
  const byStream = new Map<string, typeof parsed.data>();
  for (const page of parsed.data) {
    const pages = byStream.get(page.stream) ?? [];
    pages.push(page);
    byStream.set(page.stream, pages);
  }
  for (const pages of byStream.values()) {
    pages.sort((left, right) => left.pageOrdinal - right.pageOrdinal);
    if (
      pages.some((page, index) => page.pageOrdinal !== index + 1) ||
      !pages.at(-1)?.terminal ||
      pages.slice(0, -1).some((page) => page.terminal)
    ) {
      throw new AppError("ARUBA_INVENTORY_INCOMPLETE", 409);
    }
  }
  const remoteKeys = parsed.data.flatMap((page) => page.documents.map((item) => item.remoteId));
  if (new Set(remoteKeys).size !== remoteKeys.length) {
    throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
  }
  return {
    pages: parsed.data,
    byStream,
    remoteIds: [
      ...new Set(parsed.data.flatMap((page) => page.documents.map((item) => item.remoteId))),
    ],
  };
}

export async function createArubaManualReadback(actor: ArubaReadActor) {
  if (!actor.canApprove) throw new AppError("ARUBA_READ_SESSION_FORBIDDEN", 403);
  const coverage = await manualCoverage(getPool());
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO aruba_manual_readbacks
      (id, mode, environment, account_reference, coverage_json, created_by)
     VALUES ($1, 'FULL', $2, $3, $4, $5)`,
    [id, environment(), accountReference(), JSON.stringify(coverage), actor.id],
  );
  return { id, coverage };
}

export async function addArubaManualReadbackPages(
  readbackId: string,
  rawPages: unknown,
  actor: ArubaReadActor,
) {
  if (!actor.canApprove || !z.uuid().safeParse(readbackId).success) {
    throw new AppError("ARUBA_READ_SESSION_FORBIDDEN", 403);
  }
  const parsed = parsedManualPages(rawPages);
  return withTransaction(async (client) => {
    const readback = await client.query<{ status: string }>(
      `SELECT status FROM aruba_manual_readbacks
       WHERE id = $1 AND environment = $2 AND account_reference = $3 FOR UPDATE`,
      [readbackId, environment(), accountReference()],
    );
    if (readback.rows[0]?.status !== "DRAFT") {
      throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
    }
    for (const page of parsed.pages) {
      const digest = payloadDigest(page);
      await client.query(
        `INSERT INTO aruba_manual_readback_pages
          (manual_readback_id, stream, page_ordinal, cursor, terminal, row_count,
           rows_json, payload_digest)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (manual_readback_id, stream, page_ordinal) DO UPDATE SET
           cursor = EXCLUDED.cursor, terminal = EXCLUDED.terminal,
           row_count = EXCLUDED.row_count, rows_json = EXCLUDED.rows_json,
           payload_digest = EXCLUDED.payload_digest`,
        [
          readbackId,
          page.stream,
          page.pageOrdinal,
          page.cursor,
          page.terminal,
          page.documents.length,
          JSON.stringify(page.documents),
          digest,
        ],
      );
    }
    await client.query(
      `UPDATE aruba_manual_readbacks SET row_count = (
         SELECT coalesce(sum(row_count), 0)::integer FROM aruba_manual_readback_pages
         WHERE manual_readback_id = $1
       ), content_sha256 = $2, status = 'VALID' WHERE id = $1`,
      [readbackId, payloadDigest(parsed.pages)],
    );
    return { pages: parsed.pages.length, documents: parsed.remoteIds.length };
  });
}

export async function finalizeArubaManualReadback(readbackId: string, actor: ArubaReadActor) {
  if (!actor.canApprove || !z.uuid().safeParse(readbackId).success) {
    throw new AppError("ARUBA_READ_SESSION_FORBIDDEN", 403);
  }
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `aruba-read:${environment()}:${accountReference()}`,
    ]);
    const readback = await client.query<{
      status: string;
      coverage_json: { streams?: string[] };
      finalized_at: Date | null;
    }>(
      `SELECT status, coverage_json, finalized_at FROM aruba_manual_readbacks
       WHERE id = $1 AND mode = 'FULL' AND environment = $2 AND account_reference = $3
       FOR UPDATE`,
      [readbackId, environment(), accountReference()],
    );
    const current = readback.rows[0];
    if (current?.status === "FINALIZED") return { completed: true, repeated: true };
    if (current?.status !== "VALID") throw new AppError("ARUBA_INVENTORY_INCOMPLETE", 409);
    const storedPages = await client.query<{
      stream: string;
      page_ordinal: number;
      cursor: string | null;
      terminal: boolean;
      rows_json: RemoteInventoryDocument[];
    }>(
      `SELECT stream, page_ordinal, cursor, terminal, rows_json
       FROM aruba_manual_readback_pages WHERE manual_readback_id = $1
       ORDER BY stream, page_ordinal FOR UPDATE`,
      [readbackId],
    );
    const pages = storedPages.rows.map((page) =>
      inventoryPageSchema.parse({
        stream: page.stream,
        scanOrdinal: 1,
        pageOrdinal: page.page_ordinal,
        cursor: page.cursor,
        terminal: page.terminal,
        fullScan: true,
        documents: page.rows_json,
      }),
    );
    const parsed = parsedManualPages(pages);
    const required = current.coverage_json.streams ?? [];
    const requiredStreams = new Set(required);
    if (required.some((stream) => !parsed.byStream.has(stream))) {
      throw new AppError("ARUBA_INVENTORY_INCOMPLETE", 409);
    }
    const knownRemote = await client.query<{
      remote_id: string;
      document_type: "TD01" | "TD04";
      fiscal_year: number;
    }>(
      `SELECT remote_id, document_type, fiscal_year FROM aruba_remote_documents
       WHERE environment = $1 AND account_reference = $2`,
      [environment(), accountReference()],
    );
    const capturedByStream = new Map(
      [...parsed.byStream].map(([stream, streamPages]) => [
        stream,
        new Set(streamPages.flatMap((page) => page.documents.map((document) => document.remoteId))),
      ]),
    );
    if (
      knownRemote.rows.some((remote) => {
        const stream = `${remote.document_type === "TD01" ? "invoices" : "credit-notes"}:${remote.fiscal_year}`;
        return requiredStreams.has(stream) && !capturedByStream.get(stream)?.has(remote.remote_id);
      })
    ) {
      throw new AppError("ARUBA_INVENTORY_INCOMPLETE", 409);
    }
    await expireStaleArubaReadSessions(client);
    const sessionId = randomUUID();
    await client.query(
      `INSERT INTO aruba_sync_sessions
        (id, environment, account_reference, status, absolute_expires_at,
         lease_expires_at, requested_by, source, is_full_scan)
       VALUES ($1, $2, $3, 'SCANNING', now() + interval '5 minutes',
         now() + interval '2 minutes', $4, 'MANUAL', true)`,
      [sessionId, environment(), accountReference(), actor.id],
    );
    const session: ArubaPageIngestContext = {
      id: sessionId,
      environment: environment(),
      account_reference: accountReference(),
      sourceKind: "MANUAL",
    };
    for (const page of pages) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Le pagine condividono la stessa transazione e ogni match deve osservare la pagina precedente.
      await ingestParsedArubaPage(client, session, page);
    }
    const blockers = await client.query<{ count: string }>(
      `SELECT count(*) FROM aruba_document_matches matches
       JOIN aruba_remote_documents remote ON remote.id = matches.remote_document_id
       WHERE remote.environment = $1 AND remote.account_reference = $2
         AND ${arubaBlockingMatchPredicate}`,
      [environment(), accountReference()],
    );
    if (Number(blockers.rows[0]!.count) > 0) {
      throw new AppError("ARUBA_INVENTORY_BLOCKED", 409);
    }
    await client.query(
      `UPDATE aruba_sync_sessions SET status = 'COMPLETED', completed_at = now(),
         full_scan_completed_at = now(),
         lease_expires_at = NULL WHERE id = $1`,
      [sessionId],
    );
    await client.query(
      `INSERT INTO connections
        (provider, environment, account_reference, encrypted_credentials, status,
         last_checked_at, last_synced_at)
       VALUES ('ARUBA', $1, $2, NULL, 'CONNECTED', now(), now())
       ON CONFLICT (provider, environment) DO UPDATE SET
         account_reference = EXCLUDED.account_reference, status = 'CONNECTED',
         last_checked_at = now(), last_synced_at = now(), updated_at = now(),
         last_error_code = NULL, last_error_message_sanitized = NULL`,
      [environment() === "PRODUCTION" ? "PRODUCTION" : "DEVELOPMENT", accountReference()],
    );
    await client.query(
      `UPDATE aruba_manual_readbacks SET status = 'FINALIZED', finalized_by = $2,
         finalized_at = now() WHERE id = $1`,
      [readbackId, actor.id],
    );
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "ARUBA_INVENTORY_COMPLETED",
      eventClass: "OPERATIONAL",
      entityType: "ARUBA_SYNC_SESSION",
      entityId: sessionId,
      metadata: { streamCount: required.length },
      requestId: actor.requestId,
    });
    return { completed: true, repeated: false };
  });
}
