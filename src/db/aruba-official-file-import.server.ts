import { createHash } from "node:crypto";

import { z } from "zod";

import {
  isEmissionConfirmed,
  remoteStatusTransition,
  type ArubaRemoteStatus,
} from "../aruba-inbound.ts";
import {
  ARUBA_IMPORT_MAX_BYTES,
  arubaFileKindSchema,
  notificationBelongsToDocument,
  notificationStatus,
  validateOfficialFile,
  validateUntrustedXml,
} from "../aruba.ts";
import { AppError } from "../errors.ts";
import { writeAudit } from "./audit.server.ts";
import {
  loadArubaApiFileSession,
  matchesArubaApiDocumentIdentity,
  type ArubaApiFileAuthorization,
} from "./aruba-api-run-session.server.ts";
import { getJoinedTransactionClient, getPool, withTransaction } from "./client.server.ts";
import {
  arubaAccountReference as accountReference,
  arubaRuntimeEnvironment as environment,
  lockArubaInventory,
  type ArubaReadActor,
} from "./aruba-inventory-context.server.ts";
import {
  cleanupEvidence,
  findArubaStoredEvidence,
  findArubaStoredEvidenceForAccount,
  persistArubaOfficialEvidence,
  prepareArubaOfficialEvidence,
  removeEvidence,
} from "./aruba-p7m-evidence.server.ts";
import { reconcileRemoteDocument } from "./aruba-reconciliation.server.ts";
import {
  latestObservedRemote,
  materializeLatestOfficialXml,
  materializeMatchedExternalDocument,
  officialEvidence,
  reconcileAutomaticAmbiguousInvoices,
} from "./aruba-document-materialization.server.ts";

async function hasUnresolvedArubaIdentityCollision(
  client: Parameters<typeof latestObservedRemote>[0],
  remoteDocumentId: string,
) {
  const result = await client.query(
    `SELECT 1
     FROM aruba_remote_documents remote
     WHERE remote.id = $1
       AND EXISTS (
         SELECT 1 FROM aruba_deduplication_conflicts conflicts
         WHERE conflicts.environment = remote.environment
           AND conflicts.account_reference = remote.account_reference
           AND conflicts.resolved_at IS NULL
           AND (conflicts.existing_remote_document_id = remote.id
             OR conflicts.incoming_remote_id = remote.remote_id)
       )
     LIMIT 1`,
    [remoteDocumentId],
  );
  return Boolean(result.rows[0]);
}

async function importArubaRemoteOfficialFileAuthorized(
  authorization: ArubaReadActor | ArubaApiFileAuthorization,
  remoteReference: string,
  rawKind: unknown,
  bytes: Buffer,
) {
  const kind = arubaFileKindSchema.safeParse(rawKind);
  const reference = z.string().trim().min(1).max(200).safeParse(remoteReference);
  if (!kind.success || !reference.success || bytes.byteLength > ARUBA_IMPORT_MAX_BYTES) {
    throw new AppError("ARUBA_INVENTORY_INVALID", 422);
  }
  try {
    validateOfficialFile(kind.data, bytes);
  } catch {
    throw new AppError("ARUBA_INVENTORY_INVALID", 422);
  }
  const apiAuthorization =
    "type" in authorization && authorization.type === "API" ? authorization : null;
  const actorAuthorization = !apiAuthorization ? (authorization as ArubaReadActor) : null;
  const database = getJoinedTransactionClient() ?? getPool();
  const session = apiAuthorization
    ? await loadArubaApiFileSession(database, apiAuthorization)
    : {
        id: `manual:${actorAuthorization!.id}`,
        environment: environment(),
        account_reference: accountReference(),
      };
  if (!session) throw new AppError("ARUBA_READ_SESSION_INVALID", 401);
  if (actorAuthorization && !actorAuthorization.canApprove) {
    throw new AppError("ARUBA_READ_SESSION_FORBIDDEN", 403);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  const resolved = await database.query<{ id: string }>(
    `SELECT id FROM aruba_remote_documents
     WHERE environment = $1 AND account_reference = $2
       AND (id::text = $3 OR remote_id = $3) LIMIT 1`,
    [session.environment, session.account_reference, reference.data],
  );
  const remoteDocumentId = resolved.rows[0]?.id;
  if (!remoteDocumentId) throw new AppError("ARUBA_INVENTORY_INVALID", 404);
  if (apiAuthorization) {
    if (
      !(await matchesArubaApiDocumentIdentity(
        database,
        remoteDocumentId,
        session,
        apiAuthorization,
      ))
    ) {
      throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
    }
    if (
      kind.data === "SDI_NOTIFICATION" &&
      (!apiAuthorization.expectedDocumentFilename ||
        (apiAuthorization.requiresInvoiceNumber &&
          apiAuthorization.notificationInvoiceNumber !== apiAuthorization.expectedInvoiceNumber) ||
        !notificationBelongsToDocument(bytes.toString("utf8"), {
          filename: apiAuthorization.expectedDocumentFilename.replace(/\.p7m$/i, ""),
        }))
    ) {
      throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
    }
  } else if (kind.data === "SDI_NOTIFICATION") {
    const expected = await database.query<{
      remote_id: string;
      filename: string | null;
    }>(
      `SELECT remote.remote_id, submitted.filename
       FROM aruba_remote_documents AS remote
       LEFT JOIN LATERAL (
         SELECT batch_documents.filename
         FROM aruba_submissions
         JOIN aruba_batches ON aruba_batches.id = aruba_submissions.batch_id
         JOIN aruba_batch_documents AS batch_documents
           ON batch_documents.batch_id = aruba_submissions.batch_id
          AND batch_documents.document_id = aruba_submissions.document_id
         WHERE aruba_submissions.remote_id = remote.remote_id
           AND aruba_submissions.environment = remote.environment
           AND aruba_batches.account_reference = remote.account_reference
         ORDER BY aruba_submissions.id DESC LIMIT 1
       ) AS submitted ON true
       WHERE remote.id = $1`,
      [remoteDocumentId],
    );
    if (
      !expected.rows[0] ||
      !notificationBelongsToDocument(bytes.toString("utf8"), {
        filename: expected.rows[0].filename,
        remoteId: expected.rows[0].remote_id,
      })
    ) {
      throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
    }
  }
  const duplicate = await findArubaStoredEvidenceForAccount(database, {
    remoteDocumentId,
    environment: session.environment,
    accountReference: session.account_reference,
    kind: kind.data,
    sha256: digest,
  });
  if (duplicate && (kind.data !== "ARUBA_P7M" || duplicate.document_id)) {
    let documentId = duplicate.document_id;
    if (kind.data === "ARUBA_XML" && !documentId) {
      const xml = validateUntrustedXml(bytes);
      documentId = await withTransaction(async (client) => {
        await lockArubaInventory(client, session.environment, session.account_reference);
        if (await hasUnresolvedArubaIdentityCollision(client, remoteDocumentId)) return null;
        const evidence = officialEvidence(
          await latestObservedRemote(client, remoteDocumentId),
          xml,
        );
        await reconcileRemoteDocument(client, remoteDocumentId, evidence, true);
        await reconcileAutomaticAmbiguousInvoices(client, [remoteDocumentId]);
        return materializeMatchedExternalDocument(
          client,
          remoteDocumentId,
          duplicate.storage_object_id,
          xml,
        );
      });
      if (documentId) {
        await database.query(`UPDATE aruba_files SET document_id = $2 WHERE id = $1`, [
          duplicate.id,
          documentId,
        ]);
      }
    }
    return {
      id: duplicate.id,
      repeated: true,
      documentId,
    };
  }
  const { fiscalXml, stored, extractedXml } = await prepareArubaOfficialEvidence(
    remoteDocumentId,
    kind.data,
    bytes,
  );
  try {
    const outcome = await withTransaction(async (client) => {
      const lockedSession = apiAuthorization
        ? await loadArubaApiFileSession(client, apiAuthorization, true)
        : session;
      if (!lockedSession) throw new AppError("ARUBA_READ_SESSION_INVALID", 401);
      await lockArubaInventory(client, lockedSession.environment, lockedSession.account_reference);
      const remote = await client.query<{
        id: string;
        xml_sha256: string | null;
      }>(
        `SELECT id, xml_sha256 FROM aruba_remote_documents
         WHERE id = $1 AND environment = $2 AND account_reference = $3 FOR UPDATE`,
        [remoteDocumentId, lockedSession.environment, lockedSession.account_reference],
      );
      if (!remote.rows[0]) throw new AppError("ARUBA_INVENTORY_INVALID", 404);
      if (
        fiscalXml &&
        remote.rows[0].xml_sha256 &&
        remote.rows[0].xml_sha256 !== fiscalXml.sha256
      ) {
        throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
      }
      const concurrentDuplicate = await findArubaStoredEvidence(
        client,
        remoteDocumentId,
        kind.data,
        digest,
      );
      if (concurrentDuplicate && (kind.data !== "ARUBA_P7M" || concurrentDuplicate.document_id)) {
        return {
          id: concurrentDuplicate.id,
          repeated: true,
          documentId: concurrentDuplicate.document_id,
        };
      }
      const persisted = await persistArubaOfficialEvidence(client, {
        remoteDocumentId,
        kind: kind.data,
        relativePath: stored.relativePath,
        sha256: digest,
        sizeBytes: bytes.byteLength,
        source: apiAuthorization ? "API" : "MANUAL",
        filename: apiAuthorization?.providerFilename ?? null,
        existing: concurrentDuplicate ?? null,
        extractedXml:
          extractedXml && fiscalXml
            ? {
                relativePath: extractedXml.relativePath,
                sha256: fiscalXml.sha256,
                sizeBytes: fiscalXml.bytes.byteLength,
              }
            : null,
      });
      let documentId: string | null = concurrentDuplicate?.document_id ?? null;
      const identityCollision = await hasUnresolvedArubaIdentityCollision(client, remoteDocumentId);
      if (fiscalXml && !identityCollision) {
        const evidence = officialEvidence(
          await latestObservedRemote(client, remoteDocumentId),
          fiscalXml.xml,
        );
        await reconcileRemoteDocument(client, remoteDocumentId, evidence, true);
        await reconcileAutomaticAmbiguousInvoices(client, [remoteDocumentId]);
        documentId =
          (await materializeMatchedExternalDocument(
            client,
            remoteDocumentId,
            persisted.fiscalStorageObjectId,
            fiscalXml.xml,
          )) ?? documentId;
      }
      if (documentId && concurrentDuplicate?.document_id !== documentId) {
        await client.query(`UPDATE aruba_files SET document_id = $2 WHERE id = $1`, [
          persisted.fileId,
          documentId,
        ]);
      }
      if (documentId && persisted.derivedXmlFileId) {
        await client.query(`UPDATE aruba_files SET document_id = $2 WHERE id = $1`, [
          persisted.derivedXmlFileId,
          documentId,
        ]);
      }
      if (kind.data === "ARUBA_XML" || kind.data === "ARUBA_P7M") {
        await client.query(
          `UPDATE aruba_remote_documents SET xml_sha256 = $2,
             last_observed_at = now() WHERE id = $1`,
          [remoteDocumentId, fiscalXml!.sha256],
        );
      }
      if (kind.data === "SDI_NOTIFICATION") {
        const status = notificationStatus(bytes.toString("utf8"));
        const transition = await client.query<{
          remote_status: ArubaRemoteStatus;
        }>(`SELECT remote_status FROM aruba_remote_documents WHERE id = $1 FOR UPDATE`, [
          remoteDocumentId,
        ]);
        const statusTransition = remoteStatusTransition(transition.rows[0]!.remote_status, status);
        if (statusTransition === "CONFLICT") {
          await client.query(
            `UPDATE aruba_document_matches SET status = 'UNKNOWN_REMOTE_STATE', method = 'NONE',
               updated_at = now() WHERE remote_document_id = $1`,
            [remoteDocumentId],
          );
        } else if (statusTransition === "APPLY") {
          await client.query(
            `UPDATE aruba_remote_documents SET remote_status = $2,
               remote_status_observed_at = now(), last_observed_at = now() WHERE id = $1`,
            [remoteDocumentId, status],
          );
          if (isEmissionConfirmed(status)) {
            await materializeLatestOfficialXml(client, remoteDocumentId);
          }
        }
        await client.query(
          `INSERT INTO sdi_notifications
            (remote_document_id, remote_notification_id, type, status, storage_object_id, metadata_json)
           VALUES ($1, $2, $3, $3, $4, '{}')
           ON CONFLICT (remote_document_id, remote_notification_id)
             WHERE remote_document_id IS NOT NULL
           DO NOTHING`,
          [
            remoteDocumentId,
            apiAuthorization?.notificationId ?? digest,
            status,
            persisted.storageObjectId,
          ],
        );
      }
      await writeAudit(client, {
        actorType: "SYSTEM",
        action: "ARUBA_FILE_IMPORTED",
        eventClass: "CRITICAL",
        entityType: "DOCUMENT",
        entityId: remoteDocumentId,
        metadata: { fileKind: kind.data },
        requestId: apiAuthorization
          ? `aruba-api:${apiAuthorization.runId}`
          : actorAuthorization!.requestId,
      });
      return {
        id: persisted.fileId,
        repeated: Boolean(concurrentDuplicate),
        documentId,
      };
    });
    await cleanupEvidence(database, {
      storedPath: stored.absolutePath,
      extracted: extractedXml
        ? {
            absolutePath: extractedXml.absolutePath,
            relativePath: extractedXml.relativePath,
          }
        : null,
      removeStored: outcome.repeated,
    });
    return outcome;
  } catch (error) {
    await removeEvidence(stored.absolutePath, extractedXml?.absolutePath ?? null);
    throw error;
  }
}

export async function importArubaRemoteOfficialFileAsActor(
  remoteReference: string,
  rawKind: unknown,
  bytes: Buffer,
  actor: ArubaReadActor,
) {
  return importArubaRemoteOfficialFileAuthorized(actor, remoteReference, rawKind, bytes);
}

export async function importArubaRemoteOfficialFileFromApi(
  remoteReference: string,
  rawKind: unknown,
  bytes: Buffer,
  authorization: ArubaApiFileAuthorization,
) {
  return importArubaRemoteOfficialFileAuthorized(authorization, remoteReference, rawKind, bytes);
}
