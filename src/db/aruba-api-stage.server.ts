import { z } from "zod";

import { inventoryPageSchema } from "../aruba-inbound.ts";
import { AppError } from "../errors.ts";
import { withTransaction } from "./client.server.ts";
import { ingestParsedArubaPage } from "./aruba-inbound.server.ts";

export async function stageApiPage(
  runId: string,
  rawPage: unknown,
  providerGroupIds: ReadonlyMap<string, string>,
  groupCount: number,
) {
  const id = z.uuid().safeParse(runId);
  const parsed = inventoryPageSchema.safeParse(rawPage);
  const parsedGroupCount = z.number().int().nonnegative().safeParse(groupCount);
  if (!id.success || !parsed.success || !parsedGroupCount.success) {
    throw new AppError("ARUBA_INVENTORY_INVALID", 422);
  }
  if (parsed.data.documents.some((document) => !providerGroupIds.has(document.remoteId))) {
    throw new AppError("ARUBA_INVENTORY_INVALID", 422);
  }
  return withTransaction(async (client) => {
    const result = await client.query<{
      environment: "MOCK" | "PRODUCTION";
      account_reference: string;
    }>(
      `SELECT environment, account_reference FROM aruba_sync_runs
       WHERE id = $1 AND status = 'RUNNING' AND authority_mode = 'CANONICAL'
       FOR UPDATE`,
      [id.data],
    );
    const run = result.rows[0];
    if (!run) throw new AppError("ARUBA_READ_SESSION_INVALID", 401);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `aruba-read:${run.environment}:${run.account_reference}`,
    ]);
    return ingestParsedArubaPage(
      client,
      {
        id: id.data,
        environment: run.environment,
        account_reference: run.account_reference,
        sourceKind: "API",
        providerGroupIds,
        groupCount: parsedGroupCount.data,
      },
      parsed.data,
      false,
    );
  });
}
