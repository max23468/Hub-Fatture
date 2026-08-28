import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";

import { z } from "zod";

import { ARUBA_IMPORT_MAX_BYTES, validateOfficialFile } from "../aruba.ts";
import { AppError } from "../errors.ts";
import { validatedArubaFiscalXml } from "./aruba-p7m-evidence.server.ts";
import { storeImportedFile } from "./aruba.server.ts";
import { getPool, withTransaction } from "./client.server.ts";

const kindSchema = z.enum(["ARUBA_XML", "ARUBA_P7M", "ARUBA_PDF"]);

export async function importArubaApiGroupFile(input: {
  runId: string;
  providerGroupId: string;
  kind: unknown;
  filename: string;
  bytes: Buffer;
}) {
  const runId = z.uuid().safeParse(input.runId);
  const groupId = z.string().trim().min(1).max(200).safeParse(input.providerGroupId);
  const kind = kindSchema.safeParse(input.kind);
  const filename = z.string().trim().min(1).max(500).safeParse(input.filename);
  if (
    !runId.success ||
    !groupId.success ||
    !kind.success ||
    !filename.success ||
    !input.bytes.byteLength ||
    input.bytes.byteLength > ARUBA_IMPORT_MAX_BYTES
  ) {
    throw new AppError("ARUBA_INVENTORY_INVALID", 422);
  }
  try {
    if (kind.data === "ARUBA_PDF") validateOfficialFile(kind.data, input.bytes);
    else await validatedArubaFiscalXml(kind.data, input.bytes);
  } catch {
    throw new AppError("ARUBA_INVENTORY_INVALID", 422);
  }
  const digest = createHash("sha256").update(input.bytes).digest("hex");
  const existing = await getPool().query<{ sha256: string }>(
    `SELECT storage.sha256 FROM aruba_api_group_files files
     JOIN storage_objects storage ON storage.id = files.storage_object_id
     WHERE files.sync_run_id = $1 AND files.provider_group_id = $2 AND files.kind = $3`,
    [runId.data, groupId.data, kind.data],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].sha256 !== digest) throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
    return { repeated: true };
  }
  const safeGroup = createHash("sha256").update(groupId.data).digest("hex").slice(0, 24);
  const stored = await storeImportedFile(`api-group-${safeGroup}`, kind.data, input.bytes);
  try {
    return await withTransaction(async (client) => {
      const run = await client.query(
        `SELECT runs.id FROM aruba_sync_runs runs
         JOIN connections ON connections.provider = 'ARUBA'
          AND connections.environment = CASE WHEN runs.environment = 'PRODUCTION'
            THEN 'PRODUCTION' ELSE 'DEVELOPMENT' END
          AND connections.account_reference = runs.account_reference
         WHERE runs.id = $1 AND runs.status = 'RUNNING' AND runs.authority_mode = 'CANONICAL'
           AND connections.automatic_authority = 'API'
           AND EXISTS (SELECT 1 FROM aruba_remote_documents remote
             JOIN aruba_remote_observations observations ON observations.remote_document_id = remote.id
             WHERE observations.sync_run_id = runs.id AND remote.provider_group_id = $2)
         FOR UPDATE OF runs`,
        [runId.data, groupId.data],
      );
      if (!run.rows[0]) throw new AppError("ARUBA_READ_SESSION_INVALID", 401);
      const concurrent = await client.query<{ sha256: string }>(
        `SELECT storage.sha256 FROM aruba_api_group_files files
         JOIN storage_objects storage ON storage.id = files.storage_object_id
         WHERE files.sync_run_id = $1 AND files.provider_group_id = $2 AND files.kind = $3`,
        [runId.data, groupId.data, kind.data],
      );
      if (concurrent.rows[0]) {
        if (concurrent.rows[0].sha256 !== digest)
          throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
        await unlink(stored.absolutePath).catch(() => undefined);
        return { repeated: true };
      }
      const contentType =
        kind.data === "ARUBA_PDF"
          ? "application/pdf"
          : kind.data === "ARUBA_P7M"
            ? "application/pkcs7-mime"
            : "application/xml";
      const storage = await client.query<{ id: string }>(
        `INSERT INTO storage_objects (kind, relative_path, sha256, size_bytes, content_type)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [kind.data, stored.relativePath, digest, input.bytes.byteLength, contentType],
      );
      await client.query(
        `INSERT INTO aruba_api_group_files
          (sync_run_id, provider_group_id, storage_object_id, kind, provider_filename)
         VALUES ($1, $2, $3, $4, $5)`,
        [runId.data, groupId.data, storage.rows[0]!.id, kind.data, filename.data],
      );
      return { repeated: false };
    });
  } catch (error) {
    await unlink(stored.absolutePath).catch(() => undefined);
    throw error;
  }
}
