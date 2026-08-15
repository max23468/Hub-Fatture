import { readFile } from "node:fs/promises";

import { z } from "zod";

import { getConfig } from "../config.server.ts";
import { getPool } from "./client.server.ts";

export const BACKUP_RECEIPT_MAX_AGE_MS = 36 * 60 * 60 * 1000;

const backupReceiptSchema = z.object({
  completedAt: z.iso.datetime(),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  objectName: z.string().min(1),
  reason: z.string().min(1),
  schema: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().positive(),
  status: z.literal("ok"),
  version: z.string().min(1),
});

export type BackupReceipt = z.infer<typeof backupReceiptSchema>;

export function isBackupReceiptCurrent(
  receipt: BackupReceipt | null,
  now = new Date(),
): receipt is BackupReceipt {
  if (!receipt) return false;
  const completedAt = new Date(receipt.completedAt).getTime();
  const age = now.getTime() - completedAt;
  return age >= 0 && age < BACKUP_RECEIPT_MAX_AGE_MS;
}

export async function readBackupReceipt(): Promise<BackupReceipt | null> {
  const path = getConfig().BACKUP_RECEIPT_PATH;
  if (!path) return null;
  try {
    return backupReceiptSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return null;
  }
}

export async function getSystemStatus() {
  const [schema, jobs, backup] = await Promise.all([
    getPool().query<{ count: string; latest: string | null }>(
      "SELECT count(*)::text AS count, max(name) AS latest FROM schema_migrations",
    ),
    getPool().query<{ active: string; failed: string }>(
      `SELECT count(*) FILTER (WHERE status IN ('PENDING', 'RUNNING'))::text AS active,
              count(*) FILTER (WHERE status = 'FAILED')::text AS failed
       FROM jobs`,
    ),
    readBackupReceipt(),
  ]);
  const config = getConfig();
  return {
    application: {
      version: config.APP_VERSION,
      commit: config.APP_COMMIT_SHA,
      imageDigest: config.APP_IMAGE_DIGEST,
    },
    schema: {
      count: Number(schema.rows[0]?.count ?? 0),
      latest: schema.rows[0]?.latest ?? null,
    },
    jobs: {
      active: Number(jobs.rows[0]?.active ?? 0),
      failed: Number(jobs.rows[0]?.failed ?? 0),
    },
    backup,
    arubaSubmissionEnabled: config.ARUBA_SUBMISSION_ENABLED,
  };
}
