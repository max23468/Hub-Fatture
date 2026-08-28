import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";

import type pg from "pg";

import { arubaFiscalPayload, type ArubaFileKind, validateUntrustedXml } from "../aruba.ts";
import { AppError } from "../errors.ts";
import { validateFatturaXml } from "../fatturapa.server.ts";
import { storeImportedFile } from "./aruba.server.ts";

export async function validatedArubaFiscalXml(kind: ArubaFileKind, bytes: Buffer) {
  if (kind !== "ARUBA_XML" && kind !== "ARUBA_P7M") return null;
  try {
    const xmlBytes = arubaFiscalPayload(kind, bytes);
    const xml = validateUntrustedXml(xmlBytes);
    await validateFatturaXml(xml);
    return {
      bytes: xmlBytes,
      xml,
      sha256: createHash("sha256").update(xmlBytes).digest("hex"),
    };
  } catch {
    throw new AppError("ARUBA_INVENTORY_INVALID", 422);
  }
}

export async function prepareArubaOfficialEvidence(
  remoteDocumentId: string,
  kind: ArubaFileKind,
  bytes: Buffer,
) {
  const fiscalXml = await validatedArubaFiscalXml(kind, bytes);
  // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- Il file originale va scritto soltanto dopo aver validato il payload fiscale.
  const stored = await storeImportedFile(`remote-${remoteDocumentId}`, kind, bytes);
  try {
    const extractedXml =
      kind === "ARUBA_P7M" && fiscalXml
        ? await storeImportedFile(`remote-${remoteDocumentId}-p7m`, "ARUBA_XML", fiscalXml.bytes)
        : null;
    return { fiscalXml, stored, extractedXml };
  } catch (error) {
    await unlink(stored.absolutePath).catch(() => undefined);
    throw error;
  }
}

export async function ensureExtractedP7mXml(
  client: pg.PoolClient,
  input: {
    remoteDocumentId: string;
    relativePath: string;
    sha256: string;
    sizeBytes: number;
    source: "API" | "BROWSER";
    p7mSha256: string;
    filename: string | null;
  },
) {
  const existing = await client.query<{ id: string; storage_object_id: string }>(
    `SELECT files.id, files.storage_object_id FROM aruba_files AS files
     JOIN storage_objects AS storage ON storage.id = files.storage_object_id
     WHERE files.remote_document_id = $1 AND files.kind = 'ARUBA_XML'
       AND storage.sha256 = $2 LIMIT 1`,
    [input.remoteDocumentId, input.sha256],
  );
  if (existing.rows[0]) {
    return { fileId: existing.rows[0].id, storageObjectId: existing.rows[0].storage_object_id };
  }
  const storage = await client.query<{ id: string }>(
    `INSERT INTO storage_objects (kind, relative_path, sha256, size_bytes, content_type)
     VALUES ('ARUBA_XML', $1, $2, $3, 'application/xml') RETURNING id`,
    [input.relativePath, input.sha256, input.sizeBytes],
  );
  const file = await client.query<{ id: string }>(
    `INSERT INTO aruba_files
      (remote_document_id, storage_object_id, kind, metadata_json)
     VALUES ($1, $2, 'ARUBA_XML',
       jsonb_build_object('sha256', $3::text, 'source', $4::text,
         'derivedFromP7mSha256', $5::text, 'filename', $6::text))
     RETURNING id`,
    [
      input.remoteDocumentId,
      storage.rows[0]!.id,
      input.sha256,
      input.source,
      input.p7mSha256,
      input.filename,
    ],
  );
  return { fileId: file.rows[0]!.id, storageObjectId: storage.rows[0]!.id };
}

export async function persistArubaOfficialEvidence(
  client: pg.PoolClient,
  input: {
    remoteDocumentId: string;
    kind: ArubaFileKind;
    relativePath: string;
    sha256: string;
    sizeBytes: number;
    source: "API" | "BROWSER";
    filename: string | null;
    existing: { id: string; storage_object_id: string } | null;
    extractedXml: { relativePath: string; sha256: string; sizeBytes: number } | null;
  },
) {
  const contentType =
    input.kind === "ARUBA_PDF"
      ? "application/pdf"
      : input.kind === "ARUBA_P7M"
        ? "application/pkcs7-mime"
        : "application/xml";
  const storageObjectId = input.existing
    ? input.existing.storage_object_id
    : (
        await client.query<{ id: string }>(
          `INSERT INTO storage_objects (kind, relative_path, sha256, size_bytes, content_type)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [input.kind, input.relativePath, input.sha256, input.sizeBytes, contentType],
        )
      ).rows[0]!.id;
  let fiscalStorageObjectId = storageObjectId;
  let derivedXmlFileId: string | null = null;
  if (input.extractedXml) {
    const derived = await ensureExtractedP7mXml(client, {
      remoteDocumentId: input.remoteDocumentId,
      relativePath: input.extractedXml.relativePath,
      sha256: input.extractedXml.sha256,
      sizeBytes: input.extractedXml.sizeBytes,
      source: input.source,
      p7mSha256: input.sha256,
      filename: input.filename,
    });
    derivedXmlFileId = derived.fileId;
    fiscalStorageObjectId = derived.storageObjectId;
  }
  const fileId = input.existing
    ? input.existing.id
    : (
        await client.query<{ id: string }>(
          `INSERT INTO aruba_files
            (remote_document_id, storage_object_id, kind, metadata_json)
           VALUES ($1, $2, $3,
             jsonb_build_object('sha256', $4::text, 'source', $5::text, 'filename', $6::text))
           RETURNING id`,
          [
            input.remoteDocumentId,
            storageObjectId,
            input.kind,
            input.sha256,
            input.source,
            input.filename,
          ],
        )
      ).rows[0]!.id;
  return { fileId, derivedXmlFileId, fiscalStorageObjectId, storageObjectId };
}

export async function findArubaStoredEvidence(
  client: pg.PoolClient,
  remoteDocumentId: string,
  kind: ArubaFileKind,
  sha256: string,
) {
  return (
    await client.query<{ id: string; document_id: string | null; storage_object_id: string }>(
      `SELECT files.id, files.document_id, files.storage_object_id FROM aruba_files AS files
       JOIN storage_objects AS storage ON storage.id = files.storage_object_id
       WHERE files.remote_document_id = $1 AND files.kind = $2
         AND storage.sha256 = $3 LIMIT 1`,
      [remoteDocumentId, kind, sha256],
    )
  ).rows[0];
}

export async function findArubaStoredEvidenceForAccount(
  database: pg.Pool | pg.PoolClient,
  input: {
    remoteDocumentId: string;
    environment: string;
    accountReference: string;
    kind: ArubaFileKind;
    sha256: string;
  },
) {
  return (
    await database.query<{ id: string; document_id: string | null; storage_object_id: string }>(
      `SELECT files.id, files.document_id, files.storage_object_id FROM aruba_files AS files
       JOIN aruba_remote_documents AS remote ON remote.id = files.remote_document_id
       JOIN storage_objects AS storage ON storage.id = files.storage_object_id
       WHERE remote.id = $1 AND remote.environment = $2 AND remote.account_reference = $3
         AND files.kind = $4 AND storage.sha256 = $5 LIMIT 1`,
      [input.remoteDocumentId, input.environment, input.accountReference, input.kind, input.sha256],
    )
  ).rows[0];
}

export async function cleanupEvidence(
  database: pg.Pool | pg.PoolClient,
  input: {
    storedPath: string;
    extracted: { absolutePath: string; relativePath: string } | null;
    removeStored: boolean;
  },
) {
  if (input.removeStored) await unlink(input.storedPath).catch(() => undefined);
  if (!input.extracted) return;
  const retained = await database
    .query<{ retained: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM storage_objects WHERE relative_path = $1
       ) AS retained`,
      [input.extracted.relativePath],
    )
    .catch(() => null);
  if (!retained) return;
  if (!retained.rows[0]?.retained)
    await unlink(input.extracted.absolutePath).catch(() => undefined);
}

export async function removeEvidence(storedPath: string, extractedPath: string | null) {
  await unlink(storedPath).catch(() => undefined);
  if (extractedPath) await unlink(extractedPath).catch(() => undefined);
}
