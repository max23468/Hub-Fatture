import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { getConfig } from "../config.server.ts";
import { AppError } from "../errors.ts";

export interface StoredObjectEvidence {
  relativePath: string;
  sha256: string;
  sizeBytes: number;
}

export async function readVerifiedStorageObject(row: StoredObjectEvidence): Promise<Buffer> {
  const root = path.resolve(getConfig().DOCUMENT_STORAGE_ROOT);
  const absolutePath = path.resolve(root, row.relativePath);
  if (!absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new AppError("DOCUMENT_STORAGE_FAILED", 500);
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(absolutePath);
  } catch {
    throw new AppError("DOCUMENT_STORAGE_FAILED", 500);
  }
  if (
    bytes.byteLength !== row.sizeBytes ||
    createHash("sha256").update(bytes).digest("hex") !== row.sha256
  ) {
    throw new AppError("DOCUMENT_STORAGE_FAILED", 500);
  }
  return bytes;
}
