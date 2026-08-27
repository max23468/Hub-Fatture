import { createHash } from "node:crypto";

import { z } from "zod";

import { inventoryPageSchema } from "../aruba-inbound.ts";
import { AppError } from "../errors.ts";
import { withTransaction } from "./client.server.ts";

export async function commitArubaApiInventoryPage(
  runId: string,
  rawPage: unknown,
  groupCount: number,
) {
  const id = z.uuid().safeParse(runId);
  const parsed = inventoryPageSchema.safeParse(rawPage);
  const parsedGroupCount = z.number().int().nonnegative().safeParse(groupCount);
  if (!id.success || !parsed.success || !parsedGroupCount.success) {
    throw new AppError("ARUBA_INVENTORY_INVALID", 422);
  }
  return withTransaction(async (client) => {
    const run = await client.query<{
      environment: "MOCK" | "PRODUCTION";
      account_reference: string;
      checkpoint_start: Date;
      checkpoint_end: Date;
    }>(
      `SELECT environment, account_reference, checkpoint_start, checkpoint_end
       FROM aruba_sync_runs
       WHERE id = $1 AND status = 'RUNNING' AND authority_mode = 'CANONICAL'
       FOR UPDATE`,
      [id.data],
    );
    const context = run.rows[0];
    if (!context) throw new AppError("ARUBA_READ_SESSION_INVALID", 401);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `aruba-read:${context.environment}:${context.account_reference}`,
    ]);
    const digest = createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex");
    const existing = await client.query<{ payload_digest: string }>(
      `SELECT payload_digest FROM aruba_sync_run_pages
       WHERE sync_run_id = $1 AND window_start = $2 AND window_end = $3
         AND page_ordinal = $4`,
      [id.data, context.checkpoint_start, context.checkpoint_end, parsed.data.pageOrdinal],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].payload_digest !== digest) {
        throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
      }
      return { repeated: true };
    }
    const staged = await client.query<{ count: number; incomplete_files: number }>(
      `SELECT count(DISTINCT observations.remote_document_id)::integer AS count,
         count(DISTINCT observations.remote_document_id) FILTER (WHERE
           NOT EXISTS (SELECT 1 FROM aruba_files files
             WHERE files.remote_document_id = observations.remote_document_id
               AND files.kind IN ('ARUBA_XML', 'ARUBA_P7M'))
           OR NOT EXISTS (SELECT 1 FROM aruba_files files
             WHERE files.remote_document_id = observations.remote_document_id
               AND files.kind = 'ARUBA_PDF')
         )::integer AS incomplete_files
       FROM aruba_remote_observations observations
       JOIN aruba_remote_documents remote ON remote.id = observations.remote_document_id
       WHERE observations.sync_run_id = $1 AND observations.page_ordinal = $2
         AND remote.environment = $3 AND remote.account_reference = $4
         AND remote.remote_id = ANY($5::text[])`,
      [
        id.data,
        parsed.data.pageOrdinal,
        context.environment,
        context.account_reference,
        parsed.data.documents.map((document) => document.remoteId),
      ],
    );
    if (
      staged.rows[0]?.count !== parsed.data.documents.length ||
      staged.rows[0]?.incomplete_files !== 0
    ) {
      throw new AppError("ARUBA_INVENTORY_BLOCKED", 409);
    }
    await client.query(
      `INSERT INTO aruba_sync_run_pages
        (sync_run_id, window_start, window_end, page_ordinal, terminal,
         group_count, document_count, payload_digest)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id.data,
        context.checkpoint_start,
        context.checkpoint_end,
        parsed.data.pageOrdinal,
        parsed.data.terminal,
        parsedGroupCount.data,
        parsed.data.documents.length,
        digest,
      ],
    );
    await client.query(
      `UPDATE aruba_sync_runs SET page_count = page_count + 1,
         group_count = group_count + $2, document_count = document_count + $3,
         checkpoint_page = CASE WHEN $4 THEN 1 ELSE $5 END,
         lease_expires_at = now() + interval '3 minutes'
       WHERE id = $1 AND status = 'RUNNING'`,
      [
        id.data,
        parsedGroupCount.data,
        parsed.data.documents.length,
        parsed.data.terminal,
        parsed.data.pageOrdinal + 1,
      ],
    );
    return { repeated: false };
  });
}
