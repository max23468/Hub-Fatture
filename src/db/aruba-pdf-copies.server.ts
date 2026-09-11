import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";

import { getConfig } from "../config.server.ts";
import { writeAudit } from "./audit.server.ts";
import {
  arubaAccountReference,
  arubaRuntimeEnvironment,
  lockArubaInventory,
} from "./aruba-inventory-context.server.ts";
import { getPool, withTransaction } from "./client.server.ts";
import { assertRetentionBackupVerified } from "./retention.server.ts";
import { readBackupReceipt } from "./system.server.ts";
import { storageObjectPath } from "./storage-object.server.ts";

export type ArubaPdfCopiesSummary = {
  remoteDocuments: number;
  redundantFiles: number;
  redundantBytes: number;
};

interface RedundantPdf {
  file_id: string;
  storage_object_id: string;
  remote_document_id: string;
  relative_path: string;
  size_bytes: number;
}

// Aruba rigenera il PDF a ogni download: si conserva la copia più recente di ogni documento,
// la stessa scelta dalle e-mail, insieme a XML, P7M e notifiche. Le copie referenziate restano.
const redundantPdfSql = `
  WITH ranked AS (
    SELECT files.id, files.storage_object_id, files.remote_document_id, files.document_id,
           files.submission_id,
           row_number() OVER (
             PARTITION BY files.remote_document_id ORDER BY files.imported_at DESC, files.id DESC
           ) AS position
    FROM aruba_files AS files
    JOIN aruba_remote_documents AS remote ON remote.id = files.remote_document_id
    WHERE files.kind = 'ARUBA_PDF' AND remote.environment = $1 AND remote.account_reference = $2
  )
  SELECT ranked.id::text AS file_id, ranked.storage_object_id::text,
         ranked.remote_document_id::text, storage.relative_path, storage.size_bytes
  FROM ranked
  JOIN storage_objects AS storage ON storage.id = ranked.storage_object_id
  WHERE ranked.position > 1 AND ranked.document_id IS NULL AND ranked.submission_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM documents WHERE documents.storage_object_id = storage.id)
    AND NOT EXISTS (SELECT 1 FROM email_deliveries
      WHERE email_deliveries.attachment_storage_object_id = storage.id)
    AND NOT EXISTS (SELECT 1 FROM sdi_notifications
      WHERE sdi_notifications.storage_object_id = storage.id)
    AND NOT EXISTS (SELECT 1 FROM aruba_api_group_files
      WHERE aruba_api_group_files.storage_object_id = storage.id)
  ORDER BY ranked.remote_document_id, ranked.id`;

function summarize(rows: RedundantPdf[]): ArubaPdfCopiesSummary {
  return {
    remoteDocuments: new Set(rows.map((row) => row.remote_document_id)).size,
    redundantFiles: rows.length,
    redundantBytes: rows.reduce((total, row) => total + Number(row.size_bytes), 0),
  };
}

export async function planRedundantArubaPdfCopies(): Promise<ArubaPdfCopiesSummary> {
  const result = await getPool().query<RedundantPdf>(redundantPdfSql, [
    arubaRuntimeEnvironment(),
    arubaAccountReference(),
  ]);
  return summarize(result.rows);
}

/**
 * Elimina prima i metadati e soltanto dopo il commit i file: un'interruzione può lasciare
 * file orfani non referenziati, mai righe che puntano a file assenti.
 */
export async function pruneRedundantArubaPdfCopies(): Promise<
  ArubaPdfCopiesSummary & { unlinkFailures: number }
> {
  assertRetentionBackupVerified(getConfig().APP_ENV, await readBackupReceipt());
  const pruned = await withTransaction(async (client) => {
    await lockArubaInventory(client);
    const redundant = await client.query<RedundantPdf>(redundantPdfSql, [
      arubaRuntimeEnvironment(),
      arubaAccountReference(),
    ]);
    const rows = redundant.rows;
    if (!rows.length) return rows;
    await client.query("DELETE FROM aruba_files WHERE id = ANY($1::bigint[])", [
      rows.map((row) => row.file_id),
    ]);
    await client.query("DELETE FROM storage_objects WHERE id = ANY($1::bigint[])", [
      rows.map((row) => row.storage_object_id),
    ]);
    await writeAudit(client, {
      actorType: "SYSTEM",
      action: "ARUBA_PDF_COPIES_PRUNED",
      eventClass: "CRITICAL",
      entityType: "JOB",
      metadata: { provider: "ARUBA", fileKind: "ARUBA_PDF", affectedCount: rows.length },
      after: summarize(rows),
      requestId: `aruba-pdf-copies:${randomUUID()}`,
    });
    return rows;
  });
  let unlinkFailures = 0;
  for (const row of pruned) {
    try {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Le rimozioni seguono il commit una alla volta per contare con precisione gli eventuali file residui.
      await unlink(storageObjectPath(row.relative_path));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        unlinkFailures += 1;
      }
    }
  }
  return { ...summarize(pruned), unlinkFailures };
}
