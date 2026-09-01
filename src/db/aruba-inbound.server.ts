import type pg from "pg";
import { z } from "zod";

import {
  ARUBA_MATCHER_VERSION,
  inventoryPageSchema,
  isEmissionConfirmed,
  normalizedMatchText,
  remoteMetadataDigest,
  remoteStatusTransition,
  type ArubaRemoteStatus,
} from "../aruba-inbound.ts";
import { AppError } from "../errors.ts";
import {
  consolidateArubaRemoteCollision,
  findArubaRemoteCollision,
  resolveRejectedAttemptIdentityConflicts,
} from "./aruba-rejected-attempt.server.ts";
import {
  arubaCursorStream as cursorStream,
  arubaPayloadDigest as payloadDigest,
} from "./aruba-inventory-context.server.ts";
import { reconcileRemoteDocument } from "./aruba-reconciliation.server.ts";
import { storedMetadataIsCanonicallyEquivalent } from "./aruba-metadata-equivalence.server.ts";
import {
  latestObservedRemote,
  loadLatestOfficialXml,
  materializeLatestOfficialXml,
  officialEvidence,
  reconcileAutomaticAmbiguousInvoices,
} from "./aruba-document-materialization.server.ts";

async function needsOfficialXmlForReconciliation(client: pg.PoolClient, remoteDocumentId: string) {
  const result = await client.query<{ needed: boolean }>(
    `SELECT NOT EXISTS (
       SELECT 1 FROM aruba_files
       WHERE remote_document_id = $1 AND kind = 'ARUBA_XML'
     ) AND EXISTS (
       SELECT 1
       FROM aruba_document_matches matches
       CROSS JOIN LATERAL jsonb_array_elements(matches.candidates_json) candidate
       WHERE matches.remote_document_id = $1
         AND matches.method <> 'MANUAL'
         AND matches.status IN ('UNMATCHED', 'AMBIGUOUS', 'PROFILE_CONFLICT')
         AND (
           coalesce((candidate ->> 'probe')::boolean, false)
           OR coalesce((candidate ->> 'potential')::boolean, false)
           OR coalesce((candidate ->> 'compatible')::boolean, false)
           OR coalesce((candidate ->> 'reviewable')::boolean, false)
           OR coalesce((candidate -> 'signals' ->> 'explicitReference')::boolean, false)
         )
     ) AS needed`,
    [remoteDocumentId],
  );
  return result.rows[0]?.needed === true;
}

export type ArubaPageIngestContext = {
  id: string;
  environment: "MOCK" | "PRODUCTION";
  account_reference: string;
  sourceKind?: "MANUAL" | "API";
  providerGroupIds?: ReadonlyMap<string, string>;
  groupCount?: number;
};

async function restoreResolvedRejectedAttempts(
  client: pg.PoolClient,
  session: ArubaPageIngestContext,
  incomingRemoteId: string,
) {
  const remoteDocumentIds = await resolveRejectedAttemptIdentityConflicts(
    client,
    {
      environment: session.environment,
      accountReference: session.account_reference,
    },
    incomingRemoteId,
  );
  for (const remoteDocumentId of remoteDocumentIds) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Osserva la rimozione corrente.
    const remote = await latestObservedRemote(client, remoteDocumentId);
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Usa il file del tentativo ripristinato.
    const official = await loadLatestOfficialXml(client, remoteDocumentId);
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Riconcilia in ordine.
    await reconcileRemoteDocument(
      client,
      remoteDocumentId,
      official ? officialEvidence(remote, official.xml) : remote,
      Boolean(official),
    );
  }
}

export async function ingestParsedArubaPage(
  client: pg.PoolClient,
  session: ArubaPageIngestContext,
  page: z.infer<typeof inventoryPageSchema>,
  updateCursor = true,
) {
  const requestedFiles: Array<{
    remoteId: string;
    kind: "ARUBA_XML" | "ARUBA_P7M" | "ARUBA_PDF" | "SDI_NOTIFICATION";
  }> = [];
  const resolvedDocuments: Array<{
    remoteId: string;
    remoteDocumentId: string;
    officialFilesBlocked?: true;
  }> = [];
  const touchedRemoteDocumentIds: string[] = [];
  const apiSource = session.sourceKind === "API";
  const sessionMode = apiSource
    ? await client.query<{
        is_full_scan: boolean;
        has_pages: boolean;
        account_verified: boolean;
        source: "API";
      }>(
        `SELECT runs.kind IN ('BACKFILL', 'FULL') AS is_full_scan, 'API'::text AS source,
           EXISTS (SELECT 1 FROM aruba_sync_run_pages pages
             WHERE pages.sync_run_id = runs.id) AS has_pages,
           true AS account_verified
         FROM aruba_sync_runs runs
         JOIN connections ON connections.provider = 'ARUBA'
           AND connections.environment = CASE WHEN runs.environment = 'PRODUCTION'
             THEN 'PRODUCTION' ELSE 'DEVELOPMENT' END
           AND connections.account_reference = runs.account_reference
         WHERE runs.id = $1 AND runs.status = 'RUNNING'
           AND runs.authority_mode = 'CANONICAL'
           AND connections.automatic_authority = 'API'`,
        [session.id],
      )
    : await client.query<{
        is_full_scan: boolean;
        has_pages: boolean;
        account_verified: boolean;
        source: "MANUAL";
      }>(
        `SELECT sessions.is_full_scan, sessions.source,
           EXISTS (SELECT 1 FROM aruba_sync_pages pages
             WHERE pages.sync_session_id = sessions.id
               AND pages.stream ~ '^(invoices|credit-notes):') AS has_pages,
           EXISTS (SELECT 1 FROM aruba_sync_pages pages
             WHERE pages.sync_session_id = sessions.id
               AND pages.stream = '__account_proof__') AS account_verified
         FROM aruba_sync_sessions sessions
         WHERE sessions.id = $1 AND (
           sessions.source = 'MANUAL'
         )`,
        [session.id],
      );
  const currentMode = sessionMode.rows[0];
  if (!currentMode) throw new AppError("ARUBA_READ_SESSION_INVALID", 401);
  const digest = payloadDigest(page);
  const existingPage = apiSource
    ? await client.query<{ payload_digest: string }>(
        `SELECT payload_digest FROM aruba_sync_run_pages
         WHERE sync_run_id = $1
           AND window_start = (SELECT checkpoint_start FROM aruba_sync_runs WHERE id = $1)
           AND window_end = (SELECT checkpoint_end FROM aruba_sync_runs WHERE id = $1)
           AND page_ordinal = $2`,
        [session.id, page.pageOrdinal],
      )
    : await client.query<{ payload_digest: string }>(
        `SELECT payload_digest FROM aruba_sync_pages
         WHERE sync_session_id = $1 AND stream = $2 AND scan_ordinal = $3 AND page_ordinal = $4`,
        [session.id, page.stream, page.scanOrdinal, page.pageOrdinal],
      );
  if (existingPage.rows[0]) {
    if (existingPage.rows[0].payload_digest !== digest) {
      throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
    }
    for (const remote of page.documents) {
      const stored = apiSource
        ? await client.query<{ id: string }>(
            `SELECT DISTINCT remote.id
             FROM aruba_remote_observations observations
             JOIN aruba_remote_documents remote ON remote.id = observations.remote_document_id
             WHERE observations.sync_run_id = $1 AND observations.page_ordinal = $2
               AND observations.payload_digest = $3 AND remote.environment = $4
               AND remote.account_reference = $5 AND remote.provider_group_id = $6`,
            [
              session.id,
              page.pageOrdinal,
              remoteMetadataDigest(remote),
              session.environment,
              session.account_reference,
              session.providerGroupIds?.get(remote.remoteId),
            ],
          )
        : await client.query<{ id: string }>(
            `SELECT id FROM aruba_remote_documents
             WHERE environment = $1 AND account_reference = $2 AND remote_id = $3`,
            [session.environment, session.account_reference, remote.remoteId],
          );
      if (stored.rowCount !== 1) throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
      resolvedDocuments.push({
        remoteId: remote.remoteId,
        remoteDocumentId: stored.rows[0]!.id,
      });
      const files = await client.query<{ kind: string }>(
        `SELECT kind FROM aruba_files WHERE remote_document_id = $1`,
        [stored.rows[0]!.id],
      );
      const knownKinds = new Set(files.rows.map((file) => file.kind));
      if (
        !knownKinds.has("ARUBA_XML") &&
        (await needsOfficialXmlForReconciliation(client, stored.rows[0]!.id))
      ) {
        requestedFiles.push({ remoteId: remote.remoteId, kind: "ARUBA_XML" });
      }
      for (const kind of ["ARUBA_P7M", "ARUBA_PDF"] as const) {
        if (!knownKinds.has(kind)) requestedFiles.push({ remoteId: remote.remoteId, kind });
      }
      if (!knownKinds.has("SDI_NOTIFICATION") || !isEmissionConfirmed(remote.status)) {
        requestedFiles.push({
          remoteId: remote.remoteId,
          kind: "SDI_NOTIFICATION",
        });
      }
    }
    return {
      repeated: true,
      documents: page.documents.length,
      requestedFiles,
      resolvedDocuments: apiSource ? resolvedDocuments : undefined,
    };
  }
  for (const remote of page.documents) {
    const metadataDigest = remoteMetadataDigest(remote);
    const existing = await client.query<{
      id: string;
      remote_status: ArubaRemoteStatus;
      metadata_digest: string;
    }>(
      `SELECT id, remote_status, metadata_digest FROM aruba_remote_documents
         WHERE environment = $1 AND account_reference = $2 AND remote_id = $3
         FOR UPDATE`,
      [session.environment, session.account_reference, remote.remoteId],
    );
    const current = existing.rows[0];
    const transition = remoteStatusTransition(current?.remote_status ?? null, remote.status);
    const metadataChanged = Boolean(current && current.metadata_digest !== metadataDigest);
    const canonicallyEquivalentMetadata =
      current && metadataChanged
        ? await storedMetadataIsCanonicallyEquivalent(
            client,
            current.id,
            current.metadata_digest,
            metadataDigest,
          )
        : false;
    let conflicted = false;
    if (
      transition === "CONFLICT" ||
      (current &&
        metadataChanged &&
        !canonicallyEquivalentMetadata &&
        isEmissionConfirmed(current.remote_status))
    ) {
      conflicted = true;
      if (current) {
        await client.query(
          `INSERT INTO aruba_document_matches
              (remote_document_id, status, method, matcher_version, signals_json, candidates_json)
             VALUES ($1, 'UNKNOWN_REMOTE_STATE', 'NONE', $2, '{}', '[]')
             ON CONFLICT (remote_document_id) DO UPDATE SET
               status = 'UNKNOWN_REMOTE_STATE', method = 'NONE', updated_at = now()`,
          [current.id, ARUBA_MATCHER_VERSION],
        );
      }
    }
    let storedId = current?.id;
    if (!current) {
      const collided = await findArubaRemoteCollision(client, {
        environment: session.environment,
        accountReference: session.account_reference,
        series: remote.series,
        fiscalYear: remote.fiscalYear,
        fiscalNumber: remote.fiscalNumber,
        documentType: remote.documentType,
        xmlSha256: remote.xmlSha256,
        remoteStatus: remote.status,
      });
      if (
        collided &&
        (apiSource || collided.api || collided.remote_id.startsWith("historical-document-"))
      ) {
        const consolidation = await consolidateArubaRemoteCollision(
          client,
          collided,
          remote,
          page.fullScan,
          metadataDigest,
        );
        storedId = consolidation.id;
        conflicted = consolidation.conflicted;
        if (consolidation.immutableConflict) {
          await client.query(
            apiSource
              ? `INSERT INTO aruba_deduplication_conflicts
                   (environment, account_reference, existing_remote_document_id,
                    incoming_remote_id, collision_key, incoming_payload_digest, sync_run_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT DO NOTHING`
              : `INSERT INTO aruba_deduplication_conflicts
                   (environment, account_reference, existing_remote_document_id,
                    incoming_remote_id, collision_key, incoming_payload_digest, sync_session_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT DO NOTHING`,
            [
              session.environment,
              session.account_reference,
              collided.id,
              remote.remoteId,
              consolidation.collisionKey,
              metadataDigest,
              session.id,
            ],
          );
        }
      } else if (collided) {
        conflicted = true;
        storedId = collided.id;
        await client.query(
          apiSource
            ? `INSERT INTO aruba_deduplication_conflicts
                 (environment, account_reference, existing_remote_document_id, incoming_remote_id,
                  collision_key, incoming_payload_digest, sync_run_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT DO NOTHING`
            : `INSERT INTO aruba_deduplication_conflicts
                 (environment, account_reference, existing_remote_document_id, incoming_remote_id,
                  collision_key, incoming_payload_digest, sync_session_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT DO NOTHING`,
          [
            session.environment,
            session.account_reference,
            collided.id,
            remote.remoteId,
            remote.xmlSha256 ? "XML_SHA256" : "FISCAL_IDENTITY",
            metadataDigest,
            session.id,
          ],
        );
        await client.query(
          `INSERT INTO aruba_document_matches
             (remote_document_id, status, method, matcher_version, signals_json, candidates_json)
           VALUES ($1, 'ERROR', 'NONE', $2, '{"deduplicationCollision":true}', '[]')
           ON CONFLICT (remote_document_id) DO UPDATE SET
             status = 'ERROR', method = 'NONE', updated_at = now()`,
          [collided.id, ARUBA_MATCHER_VERSION],
        );
      }
    }
    if (!storedId) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO aruba_remote_documents
            (environment, account_reference, remote_id, document_type, fiscal_year, series,
             fiscal_number, document_date, recipient_name_normalized,
             recipient_tax_id_normalized, recipient_country_code,
             recipient_address_normalized, total_amount, currency, remote_status,
             remote_status_observed_at, xml_sha256, origin, last_full_scan_at, metadata_digest)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                   $15, coalesce($16::timestamptz, now()), $17, 'UNKNOWN',
                   CASE WHEN $18 THEN now() ELSE NULL END, $19)
           RETURNING id`,
        [
          session.environment,
          session.account_reference,
          remote.remoteId,
          remote.documentType,
          remote.fiscalYear,
          remote.series,
          remote.fiscalNumber,
          remote.documentDate,
          normalizedMatchText(remote.recipientName),
          normalizedMatchText(remote.recipientTaxId),
          remote.recipientCountryCode,
          normalizedMatchText(remote.recipientAddress),
          remote.totalAmount,
          remote.currency,
          remote.status,
          remote.providerObservedAt,
          remote.xmlSha256,
          page.fullScan,
          metadataDigest,
        ],
      );
      storedId = inserted.rows[0]!.id;
    } else if (current && transition === "APPLY" && !conflicted) {
      await client.query(
        `UPDATE aruba_remote_documents SET
             document_type = $2, fiscal_year = $3, series = $4, fiscal_number = $5,
             document_date = $6, recipient_name_normalized = $7,
             recipient_tax_id_normalized = $8, recipient_country_code = $9,
             recipient_address_normalized = $10, total_amount = $11, currency = $12,
             remote_status = $13, remote_status_observed_at = coalesce($14::timestamptz, now()),
             xml_sha256 = coalesce($15, xml_sha256), last_observed_at = now(),
             last_full_scan_at = CASE WHEN $16 THEN now() ELSE last_full_scan_at END,
             inventory_version = inventory_version + 1, metadata_digest = $17
           WHERE id = $1`,
        [
          current.id,
          remote.documentType,
          remote.fiscalYear,
          remote.series,
          remote.fiscalNumber,
          remote.documentDate,
          normalizedMatchText(remote.recipientName),
          normalizedMatchText(remote.recipientTaxId),
          remote.recipientCountryCode,
          normalizedMatchText(remote.recipientAddress),
          remote.totalAmount,
          remote.currency,
          remote.status,
          remote.providerObservedAt,
          remote.xmlSha256,
          page.fullScan,
          metadataDigest,
        ],
      );
    }
    if (apiSource) {
      await client.query(
        `UPDATE aruba_remote_documents SET provider_group_id = $2, automatic_source = 'API'
         WHERE id = $1`,
        [storedId, session.providerGroupIds?.get(remote.remoteId) ?? null],
      );
      resolvedDocuments.push({
        remoteId: remote.remoteId,
        remoteDocumentId: storedId!,
        ...(conflicted ? { officialFilesBlocked: true as const } : {}),
      });
    }
    touchedRemoteDocumentIds.push(storedId!);
    if (!conflicted) {
      await restoreResolvedRejectedAttempts(client, session, remote.remoteId);
    }
    await client.query(
      apiSource
        ? `INSERT INTO aruba_remote_observations
            (remote_document_id, sync_run_id, remote_status, provider_observed_at,
             stream, scan_ordinal, page_ordinal, cursor, payload_digest, payload_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT DO NOTHING`
        : `INSERT INTO aruba_remote_observations
            (remote_document_id, sync_session_id, remote_status, provider_observed_at,
             stream, scan_ordinal, page_ordinal, cursor, payload_digest, payload_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT DO NOTHING`,
      [
        storedId,
        session.id,
        remote.status,
        remote.providerObservedAt,
        page.stream,
        page.scanOrdinal,
        page.pageOrdinal,
        page.cursor,
        remoteMetadataDigest(remote),
        JSON.stringify(remote),
      ],
    );
    if (!conflicted) {
      const official = await loadLatestOfficialXml(client, storedId!);
      await reconcileRemoteDocument(
        client,
        storedId!,
        official ? officialEvidence(remote, official.xml) : remote,
        Boolean(official),
      );
      if (isEmissionConfirmed(remote.status)) {
        await materializeLatestOfficialXml(client, storedId!);
      }
    }
    const files = await client.query<{ kind: string }>(
      `SELECT kind FROM aruba_files WHERE remote_document_id = $1`,
      [storedId],
    );
    const knownKinds = new Set(files.rows.map((file) => file.kind));
    const changed = !current || current.metadata_digest !== metadataDigest;
    if (
      !knownKinds.has("ARUBA_XML") &&
      (await needsOfficialXmlForReconciliation(client, storedId!))
    ) {
      requestedFiles.push({ remoteId: remote.remoteId, kind: "ARUBA_XML" });
    }
    if (changed || !knownKinds.has("ARUBA_P7M")) {
      requestedFiles.push({ remoteId: remote.remoteId, kind: "ARUBA_P7M" });
    }
    if (changed || !knownKinds.has("ARUBA_PDF")) {
      requestedFiles.push({ remoteId: remote.remoteId, kind: "ARUBA_PDF" });
    }
    if (!isEmissionConfirmed(remote.status) || changed) {
      requestedFiles.push({
        remoteId: remote.remoteId,
        kind: "SDI_NOTIFICATION",
      });
    }
  }
  await reconcileAutomaticAmbiguousInvoices(client, touchedRemoteDocumentIds);
  const watermark = await client.query<{ value: string }>(
    `SELECT nextval('aruba_inventory_watermark_seq')::text AS value`,
  );
  if (apiSource && updateCursor) {
    await client.query(
      `INSERT INTO aruba_sync_run_pages
        (sync_run_id, window_start, window_end, page_ordinal, terminal,
         group_count, document_count, payload_digest)
       SELECT id, checkpoint_start, checkpoint_end, $2, $3, $4, $5, $6
       FROM aruba_sync_runs WHERE id = $1 AND status = 'RUNNING'`,
      [
        session.id,
        page.pageOrdinal,
        page.terminal,
        session.groupCount ?? page.documents.length,
        page.documents.length,
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
        session.id,
        session.groupCount ?? page.documents.length,
        page.documents.length,
        page.terminal,
        page.pageOrdinal + 1,
      ],
    );
  } else if (!apiSource) {
    await client.query(
      `INSERT INTO aruba_sync_pages
          (sync_session_id, stream, scan_ordinal, page_ordinal, cursor, terminal, full_scan,
           row_count, documents_json, payload_digest)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        session.id,
        page.stream,
        page.scanOrdinal,
        page.pageOrdinal,
        page.cursor,
        page.terminal,
        page.fullScan,
        page.documents.length,
        JSON.stringify(page.documents),
        digest,
      ],
    );
    await client.query(
      `UPDATE aruba_sync_sessions SET status = 'SCANNING', last_heartbeat_at = now(),
           lease_expires_at = least(absolute_expires_at, now() + interval '2 minutes'),
           page_count = page_count + 1, document_count = document_count + $2,
           final_cursor = $3, inventory_watermark = $4
         WHERE id = $1`,
      [session.id, page.documents.length, page.cursor, Number(watermark.rows[0]!.value)],
    );
  }
  if (updateCursor && !apiSource) {
    await client.query(
      `INSERT INTO sync_cursors
       (provider, stream, cursor, overlap_from, last_page_ordinal, updated_at)
     VALUES ('ARUBA', $1, $2, now() - interval '7 days', $3, now())
     ON CONFLICT (provider, stream) DO UPDATE SET
       cursor = EXCLUDED.cursor, overlap_from = EXCLUDED.overlap_from,
       last_page_ordinal = EXCLUDED.last_page_ordinal, updated_at = now()`,
      [
        cursorStream(session.environment, session.account_reference, page.stream),
        page.cursor,
        page.pageOrdinal,
      ],
    );
  }
  return {
    repeated: false,
    documents: page.documents.length,
    requestedFiles,
    resolvedDocuments: apiSource ? resolvedDocuments : undefined,
  };
}
