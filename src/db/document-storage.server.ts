import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import type pg from "pg";

import { getConfig } from "../config.server.ts";
import { documentInputSchema, fiscalProfileSchema, generateFatturaXml } from "../documents.ts";
import { AppError } from "../errors.ts";
import { getPool } from "./client.server.ts";
import { isDatabaseId } from "./database-id.ts";

export interface StoredDocumentRow {
  id: string;
  origin: "HUB" | "ARUBA_HISTORY";
  billing_case_id: string;
  series: string;
  fiscal_year: number;
  fiscal_number: number;
  immutable_snapshot_json: unknown;
  fiscal_profile_snapshot_json: unknown;
  relative_path: string;
  sha256: string;
  size_bytes: number;
}

function errno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function storagePath(relativePath: string): { root: string; absolutePath: string } {
  const root = path.resolve(getConfig().DOCUMENT_STORAGE_ROOT);
  const absolutePath = path.resolve(root, relativePath);
  if (!absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new AppError("DOCUMENT_STORAGE_FAILED", 500);
  }
  return { root, absolutePath };
}

export function ensureDocumentStoragePath(relativePath: string): void {
  storagePath(relativePath);
}

async function verifiedFile(
  filePath: string,
  sha256: string,
  sizeBytes: number,
): Promise<Buffer | null> {
  let contents;
  try {
    contents = await readFile(filePath);
  } catch (error) {
    if (errno(error, "ENOENT")) return null;
    throw new AppError("DOCUMENT_STORAGE_FAILED", 500);
  }
  if (
    contents.byteLength !== sizeBytes ||
    createHash("sha256").update(contents).digest("hex") !== sha256
  ) {
    throw new AppError("DOCUMENT_STORAGE_FAILED", 500);
  }
  return contents;
}

function regenerateStoredXml(row: StoredDocumentRow): string {
  if (row.origin === "ARUBA_HISTORY") throw new AppError("DOCUMENT_STORAGE_FAILED", 500);
  const snapshot = row.immutable_snapshot_json as Record<string, unknown>;
  const input = documentInputSchema.parse(snapshot);
  const profile = fiscalProfileSchema.parse(row.fiscal_profile_snapshot_json);
  const xml = generateFatturaXml(
    profile,
    input,
    { year: row.fiscal_year, number: row.fiscal_number },
    {
      legacyEuFirstTaxIdentifier:
        snapshot.generatorVersion !== 2 && snapshot.generatorVersion !== 3,
      uppercaseRecipient: snapshot.generatorVersion === 3,
    },
  );
  if (
    Buffer.byteLength(xml) !== row.size_bytes ||
    createHash("sha256").update(xml).digest("hex") !== row.sha256
  ) {
    throw new AppError("DOCUMENT_STORAGE_FAILED", 500);
  }
  return xml;
}

export async function materializeStoredXml(
  row: StoredDocumentRow,
  approvedXml?: string,
): Promise<boolean> {
  const { root, absolutePath } = storagePath(row.relative_path);
  const stageDirectory = path.join(root, ".staging");
  const stagePath = path.join(stageDirectory, `${row.id}-${row.sha256}.xml`);
  await mkdir(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
  await mkdir(stageDirectory, { recursive: true, mode: 0o700 });
  if (await verifiedFile(absolutePath, row.sha256, row.size_bytes)) {
    await unlink(stagePath).catch((error: unknown) => {
      if (!errno(error, "ENOENT")) throw error;
    });
    return false;
  }
  const xml = approvedXml ?? regenerateStoredXml(row);
  if (!(await verifiedFile(stagePath, row.sha256, row.size_bytes))) {
    const temporaryPath = `${stagePath}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(xml);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, stagePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error instanceof AppError ? error : new AppError("DOCUMENT_STORAGE_FAILED", 500);
    }
  }
  try {
    await link(stagePath, absolutePath);
    await unlink(stagePath).catch((error: unknown) => {
      if (!errno(error, "ENOENT")) throw error;
    });
    return true;
  } catch (error) {
    if (!errno(error, "EEXIST")) throw new AppError("DOCUMENT_STORAGE_FAILED", 500);
    if (!(await verifiedFile(absolutePath, row.sha256, row.size_bytes))) {
      throw new AppError("DOCUMENT_STORAGE_FAILED", 500);
    }
  }
  await unlink(stagePath).catch((error: unknown) => {
    if (!errno(error, "ENOENT")) throw error;
  });
  return false;
}

export async function loadStoredDocuments(
  where = "",
  value?: string,
): Promise<StoredDocumentRow[]> {
  const result = await getPool().query<StoredDocumentRow>(
    `SELECT documents.id, documents.origin, documents.billing_case_id, documents.series,
            documents.fiscal_year, documents.fiscal_number,
            documents.immutable_snapshot_json, documents.fiscal_profile_snapshot_json,
            storage_objects.relative_path, storage_objects.sha256, storage_objects.size_bytes
     FROM documents
     JOIN storage_objects ON storage_objects.id = documents.storage_object_id
     WHERE documents.status = 'APPROVED' ${where}`,
    value ? [value] : [],
  );
  return result.rows;
}

export async function reconcileDocumentStorage(): Promise<void> {
  await Promise.all((await loadStoredDocuments()).map((row) => materializeStoredXml(row)));
}

export async function materializeDocumentStorage(documentId: string, xml?: string): Promise<void> {
  const row = (await loadStoredDocuments("AND documents.id = $1", documentId))[0];
  if (!row) throw new AppError("DOCUMENT_STORAGE_FAILED", 500);
  await materializeStoredXml(row, xml);
}

export async function archiveImportedInvoiceXml(
  client: pg.PoolClient,
  relativePath: string,
  xml: string,
) {
  const sha256 = createHash("sha256").update(xml).digest("hex");
  const sizeBytes = Buffer.byteLength(xml);
  const { reference, created } = await client
    .query<{ referenced_before: boolean }>(
      `WITH locked AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(hashtext($1))
       )
       SELECT EXISTS (
         SELECT 1 FROM storage_objects WHERE relative_path = $2
       ) AS referenced_before
       FROM locked`,
      [`document-storage:${relativePath}`, relativePath],
    )
    .then(async (reference) => ({
      reference,
      created: await materializeStoredXml(
        {
          id: `history-${sha256}`,
          origin: "ARUBA_HISTORY",
          billing_case_id: "0",
          series: "FPR",
          fiscal_year: 0,
          fiscal_number: 0,
          immutable_snapshot_json: null,
          fiscal_profile_snapshot_json: null,
          relative_path: relativePath,
          sha256,
          size_bytes: sizeBytes,
        },
        xml,
      ),
    }));
  return {
    sha256,
    sizeBytes,
    async cleanupIfUnreferenced() {
      if (created && !reference.rows[0]!.referenced_before) {
        await unlink(storagePath(relativePath).absolutePath).catch((error: unknown) => {
          if (!errno(error, "ENOENT")) throw error;
        });
      }
    },
  };
}

export function startDocumentStorageReconciliation(): void {
  void reconcileDocumentStorage().catch((error: unknown) => console.error(error));
}

export async function readDocumentXml(documentId: string): Promise<Buffer | null> {
  if (!isDatabaseId(documentId)) return null;
  const row = (await loadStoredDocuments("AND documents.id = $1", documentId))[0];
  if (!row || row.size_bytes > 4_900_000) return null;
  await materializeStoredXml(row);
  return verifiedFile(storagePath(row.relative_path).absolutePath, row.sha256, row.size_bytes);
}
