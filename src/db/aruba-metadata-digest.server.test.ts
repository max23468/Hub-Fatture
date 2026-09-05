import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import { remoteMetadataDigest, type RemoteInventoryDocument } from "../aruba-inbound.ts";
import { temporaryDatabase } from "./database-fixture.ts";
import { ingestParsedArubaPage } from "./aruba-inbound.server.ts";
import { runMigrations } from "./migrations.server.ts";

async function openManualSession(client: pg.PoolClient, id: string) {
  await client.query(
    `INSERT INTO aruba_sync_sessions
      (id, environment, account_reference, status, source, absolute_expires_at)
     VALUES ($1, 'MOCK', 'synthetic-account', 'ACTIVE', 'MANUAL', now() + interval '1 hour')`,
    [id],
  );
  await client.query(
    `INSERT INTO aruba_sync_pages
      (sync_session_id, stream, scan_ordinal, page_ordinal, terminal, full_scan,
       row_count, documents_json, payload_digest)
     VALUES ($1, '__account_proof__', 1, 1, true, false, 0, '[]', repeat('1', 64))`,
    [id],
  );
}

test("un vecchio digest che differisce solo per il timestamp Aruba si riallinea", async () => {
  const fixture = await temporaryDatabase("aruba_metadata_digest");
  process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
  process.env.APP_BASE_URL = "http://localhost:8080";
  process.env.APP_ENV = "test";
  process.env.DATABASE_URL = fixture.connectionString;
  process.env.ARUBA_ACCOUNT_REFERENCE = "synthetic-account";
  const pool = new pg.Pool({ connectionString: fixture.connectionString });
  let client: pg.PoolClient | undefined;
  try {
    await runMigrations({ connectionString: fixture.connectionString });
    client = await pool.connect();
    const remote: RemoteInventoryDocument = {
      remoteId: "timestamp-only",
      documentType: "TD01",
      fiscalYear: 2026,
      series: "FPR",
      fiscalNumber: "10",
      documentDate: "2026-08-31",
      recipientName: "Mario Rossi",
      recipientTaxId: "RSSMRA80A01H501U",
      recipientTaxIdentifiers: [
        { type: "CODICE_FISCALE", countryCode: "IT", value: "RSSMRA80A01H501U" },
      ],
      recipientCountryCode: "IT",
      recipientAddress: "Via Roma 1",
      totalAmount: 10_000,
      currency: "EUR",
      status: "DELIVERED",
      providerObservedAt: "2026-08-31T10:00:00.000Z",
      xmlSha256: null,
      orderReferences: [],
    };
    const firstSession = "10000000-0000-4000-8000-000000000101";
    await openManualSession(client, firstSession);
    await ingestParsedArubaPage(
      client,
      {
        id: firstSession,
        environment: "MOCK",
        account_reference: "synthetic-account",
        sourceKind: "MANUAL",
      },
      {
        stream: "invoices:2026",
        scanOrdinal: 1,
        pageOrdinal: 1,
        cursor: null,
        terminal: true,
        fullScan: false,
        documents: [remote],
      },
      false,
    );
    const document = await client.query<{ id: string }>(
      "SELECT id::text FROM aruba_remote_documents WHERE remote_id = 'timestamp-only'",
    );
    const documentId = document.rows[0]!.id;
    await client.query(
      `WITH stored AS (
         INSERT INTO storage_objects (kind, relative_path, sha256, size_bytes, content_type)
         VALUES ('ARUBA_PDF', 'synthetic/timestamp-only.pdf', repeat('c', 64), 32,
           'application/pdf')
         RETURNING id
       )
       INSERT INTO aruba_files (remote_document_id, storage_object_id, kind)
       SELECT $1, stored.id, 'ARUBA_PDF' FROM stored`,
      [documentId],
    );
    await client.query(
      "UPDATE aruba_remote_documents SET metadata_digest = repeat('a', 64) WHERE id = $1",
      [documentId],
    );
    await client.query(
      `UPDATE aruba_remote_observations SET payload_digest = repeat('a', 64)
       WHERE remote_document_id = $1`,
      [documentId],
    );
    await client.query(
      `UPDATE aruba_document_matches SET status = 'UNKNOWN_REMOTE_STATE', method = 'NONE'
       WHERE remote_document_id = $1`,
      [documentId],
    );
    await client.query(
      `UPDATE aruba_sync_sessions SET status = 'COMPLETED', completed_at = now()
       WHERE id = $1`,
      [firstSession],
    );

    const secondSession = "10000000-0000-4000-8000-000000000102";
    await openManualSession(client, secondSession);
    const observedAgain = {
      ...remote,
      providerObservedAt: "2026-08-31T10:05:00.000Z",
    };
    const refreshed = await ingestParsedArubaPage(
      client,
      {
        id: secondSession,
        environment: "MOCK",
        account_reference: "synthetic-account",
        sourceKind: "MANUAL",
      },
      {
        stream: "invoices:2026",
        scanOrdinal: 1,
        pageOrdinal: 1,
        cursor: null,
        terminal: true,
        fullScan: false,
        documents: [observedAgain],
      },
      false,
    );
    assert.equal(
      refreshed.requestedFiles.some((file) => file.kind === "ARUBA_PDF"),
      false,
    );

    assert.deepEqual(
      (
        await client.query(
          `SELECT remote.metadata_digest, matches.status
           FROM aruba_remote_documents remote
           JOIN aruba_document_matches matches ON matches.remote_document_id = remote.id
           WHERE remote.id = $1`,
          [documentId],
        )
      ).rows[0],
      { metadata_digest: remoteMetadataDigest(observedAgain), status: "UNMATCHED" },
    );
    await client.query(
      `UPDATE aruba_sync_sessions SET status = 'COMPLETED', completed_at = now()
       WHERE id = $1`,
      [secondSession],
    );
    const thirdSession = "10000000-0000-4000-8000-000000000103";
    await openManualSession(client, thirdSession);
    await ingestParsedArubaPage(
      client,
      {
        id: thirdSession,
        environment: "MOCK",
        account_reference: "synthetic-account",
        sourceKind: "MANUAL",
      },
      {
        stream: "invoices:2026",
        scanOrdinal: 1,
        pageOrdinal: 1,
        cursor: null,
        terminal: true,
        fullScan: false,
        documents: [{ ...observedAgain, totalAmount: observedAgain.totalAmount + 1 }],
      },
      false,
    );
    assert.equal(
      (
        await client.query(
          `SELECT status FROM aruba_document_matches WHERE remote_document_id = $1`,
          [documentId],
        )
      ).rows[0].status,
      "UNKNOWN_REMOTE_STATE",
    );
  } finally {
    client?.release();
    await pool.end();
    await fixture.drop();
  }
});

test("una collisione emersa aggiornando un’identità remota resta separata e bloccata", async () => {
  const fixture = await temporaryDatabase("aruba_late_identity_collision");
  process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
  process.env.APP_BASE_URL = "http://localhost:8080";
  process.env.APP_ENV = "test";
  process.env.DATABASE_URL = fixture.connectionString;
  process.env.ARUBA_ACCOUNT_REFERENCE = "synthetic-account";
  const pool = new pg.Pool({ connectionString: fixture.connectionString });
  let client: pg.PoolClient | undefined;
  try {
    await runMigrations({ connectionString: fixture.connectionString });
    client = await pool.connect();
    const existing = await client.query<{ id: string }>(
      `INSERT INTO aruba_remote_documents
         (environment, account_reference, remote_id, document_type, fiscal_year, series,
          fiscal_number, document_date, total_amount, remote_status,
          remote_status_observed_at, metadata_digest)
       VALUES ('MOCK', 'synthetic-account', 'already-canonical', 'TD01', 2026, 'FPR',
               '1713', '2026-08-30', 9810, 'NOT_DELIVERED', now(), repeat('a', 64))
       RETURNING id::text`,
    );
    const incomplete = await client.query<{ id: string }>(
      `INSERT INTO aruba_remote_documents
         (environment, account_reference, remote_id, document_type, fiscal_year, series,
          fiscal_number, document_date, total_amount, remote_status,
          remote_status_observed_at, metadata_digest)
       VALUES ('MOCK', 'synthetic-account', 'late-identity', 'TD01', 2026, NULL,
               NULL, '2026-08-30', 15850, 'UNKNOWN', now(), repeat('b', 64))
       RETURNING id::text`,
    );
    const sessionId = "10000000-0000-4000-8000-000000000104";
    await openManualSession(client, sessionId);
    await client.query(
      `WITH customer AS (
         INSERT INTO customers (kind, match_key, display_name, billing_address_json,
           source_confidence, review_required)
         SELECT 'PRIVATE_IT', name, name, '{}', 'TAX_ID', false
         FROM unnest(ARRAY['Mario Sintetico', 'Paolo Estraneo']) name
         RETURNING id, display_name
       ), cases AS (
         INSERT INTO billing_cases (customer_id, local_order_date, currency, status,
           customer_snapshot_json)
         SELECT customer.id, '2026-08-30', 'EUR', 'READY',
           jsonb_build_object('displayName', display_name, 'reviewRequired', false)
         FROM customer
         RETURNING id, customer_id, customer_snapshot_json
       )
       INSERT INTO orders (provider, external_account_id, external_order_id, display_number,
         created_at_source, updated_at_source, local_order_date, currency, gross_amount,
         payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
         raw_snapshot_json, normalized_snapshot_json)
       SELECT 'SHOPIFY', 'collision-test', id::text,
         CASE WHEN customer_snapshot_json ->> 'displayName' = 'Mario Sintetico'
           THEN '#12345' ELSE '#67890' END,
         now(), now(), '2026-08-30', 'EUR',
         CASE WHEN customer_snapshot_json ->> 'displayName' = 'Mario Sintetico'
           THEN 15850 ELSE 20000 END, 'PAID', 'FULFILLED', 'GROUPED',
         customer_id, id, '{}', '{"totalsReconciled":true}' FROM cases`,
    );
    const remote: RemoteInventoryDocument = {
      remoteId: "late-identity",
      documentType: "TD01",
      fiscalYear: 2026,
      series: "FPR",
      fiscalNumber: "1713",
      documentDate: "2026-08-30",
      recipientName: "Mario Sintetico",
      recipientTaxId: null,
      recipientTaxIdentifiers: [],
      recipientCountryCode: "IT",
      recipientAddress: null,
      totalAmount: 15_850,
      currency: "EUR",
      status: "SUBMITTED",
      providerStatusLabel: "Inviata",
      providerInvoiceNumber: "1713",
      providerObservedAt: "2026-08-30T10:00:00.000Z",
      xmlSha256: null,
      orderReferences: ["#12345"],
    };
    await ingestParsedArubaPage(
      client,
      {
        id: sessionId,
        environment: "MOCK",
        account_reference: "synthetic-account",
        sourceKind: "MANUAL",
      },
      {
        stream: "invoices:2026",
        scanOrdinal: 1,
        pageOrdinal: 1,
        cursor: null,
        terminal: true,
        fullScan: false,
        documents: [remote],
      },
      false,
    );
    assert.deepEqual(
      (
        await client.query(
          `SELECT
             (SELECT count(*)::integer FROM aruba_remote_documents
              WHERE remote_id IN ('already-canonical', 'late-identity')) AS documents,
             (SELECT count(*)::integer FROM aruba_deduplication_conflicts
              WHERE sync_session_id = $1) AS conflicts,
             (SELECT array_agg(status ORDER BY remote_document_id)
              FROM aruba_document_matches
              WHERE remote_document_id = ANY($2::bigint[])) AS statuses`,
          [sessionId, [existing.rows[0]!.id, incomplete.rows[0]!.id]],
        )
      ).rows[0],
      {
        documents: 2,
        conflicts: 1,
        statuses: ["UNKNOWN_REMOTE_STATE", "UNKNOWN_REMOTE_STATE"],
      },
    );

    const { getArubaInventoryHealth } = await import("./aruba-inventory-health.server.ts");
    const { arubaInventoryBlocksAllApprovals } = await import("../aruba-inventory.ts");
    const { arubaPotentialMatchSql } = await import("./billing-case-sql.server.ts");
    assert.equal((await getArubaInventoryHealth(client)).uncertainRemoteStates, 2);
    const original: RemoteInventoryDocument = {
      ...remote,
      remoteId: "already-canonical",
      totalAmount: 9810,
      status: "NOT_DELIVERED",
    };
    await client.query("UPDATE aruba_remote_documents SET metadata_digest = $2 WHERE id = $1", [
      existing.rows[0]!.id,
      remoteMetadataDigest(original),
    ]);
    await ingestParsedArubaPage(
      client,
      {
        id: sessionId,
        environment: "MOCK",
        account_reference: "synthetic-account",
        sourceKind: "MANUAL",
      },
      {
        stream: "invoices:2026",
        scanOrdinal: 1,
        pageOrdinal: 2,
        cursor: null,
        terminal: true,
        fullScan: false,
        documents: [original],
      },
      false,
    );
    const health = await getArubaInventoryHealth(client);
    assert.equal(health.conflicts, 2);
    assert.equal(health.uncertainRemoteStates, 0);
    assert.equal(
      arubaInventoryBlocksAllApprovals({
        ...health,
        blockingReason: "CONFLICT",
        ageMinutes: 0,
        activeSession: false,
      }),
      false,
    );
    assert.deepEqual(
      (
        await client.query(
          `SELECT ${arubaPotentialMatchSql} AS blocked FROM billing_cases ORDER BY id`,
        )
      ).rows,
      [{ blocked: true }, { blocked: false }],
    );
    assert.equal(
      (await client.query("SELECT count(*)::int AS count FROM documents")).rows[0].count,
      0,
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM aruba_deduplication_conflicts WHERE resolved_at IS NULL",
        )
      ).rows[0].count,
      1,
    );

    // Un vero stato ignoto o una controparte non confrontata riapre il blocco globale.
    await client.query(
      "UPDATE aruba_remote_documents SET remote_status = 'UNKNOWN' WHERE id = $1",
      [incomplete.rows[0]!.id],
    );
    assert.equal((await getArubaInventoryHealth(client)).uncertainRemoteStates, 2);
    await client.query(
      "UPDATE aruba_remote_documents SET remote_status = 'SUBMITTED' WHERE id = $1",
      [incomplete.rows[0]!.id],
    );
    await client.query(
      `UPDATE aruba_document_matches SET signals_json = signals_json ||
         '{"remoteObservationConflict":true}' WHERE remote_document_id = $1`,
      [existing.rows[0]!.id],
    );
    assert.equal((await getArubaInventoryHealth(client)).uncertainRemoteStates, 2);
  } finally {
    client?.release();
    await pool.end();
    await fixture.drop();
  }
});
