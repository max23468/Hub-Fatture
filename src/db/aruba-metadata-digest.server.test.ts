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
    await ingestParsedArubaPage(
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
