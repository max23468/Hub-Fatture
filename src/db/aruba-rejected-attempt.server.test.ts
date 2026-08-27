import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";
import {
  findArubaRemoteCollision,
  resolveRejectedAttemptIdentityConflicts,
} from "./aruba-rejected-attempt.server.ts";

test("un tentativo rifiutato non occupa l'identità fiscale del tentativo successivo", async () => {
  const fixture = await temporaryDatabase("aruba_rejected_attempt_identity");
  const client = new pg.Client({ connectionString: fixture.connectionString });
  let connected = false;
  try {
    await runMigrations({ connectionString: fixture.connectionString });
    await client.connect();
    connected = true;
    await client.query(
      `INSERT INTO aruba_sync_sessions
        (id, environment, account_reference, device_id, token_hash, status,
         absolute_expires_at, completed_at)
       VALUES ('10000000-0000-4000-8000-000000000001', 'MOCK', 'synthetic-account',
         'synthetic-device-01', repeat('1', 64), 'COMPLETED', now() + interval '1 hour', now())`,
    );
    const rejected = await client.query<{ id: string }>(
      `INSERT INTO aruba_remote_documents
        (environment, account_reference, remote_id, document_type, fiscal_year, series,
         fiscal_number, document_date, total_amount, remote_status, remote_status_observed_at,
         metadata_digest)
       VALUES ('MOCK', 'synthetic-account', 'rejected-attempt', 'TD01', 2026, 'FPR',
         '99', '2026-08-27', 1000, 'REJECTED', now(), repeat('2', 64))
       RETURNING id`,
    );

    assert.equal(
      await findArubaRemoteCollision(client, {
        environment: "MOCK",
        accountReference: "synthetic-account",
        series: "FPR",
        fiscalYear: 2026,
        fiscalNumber: "99",
        documentType: "TD01",
        xmlSha256: null,
        remoteStatus: "NOT_DELIVERED",
      }),
      null,
    );

    const replacement = await client.query<{ id: string }>(
      `INSERT INTO aruba_remote_documents
        (environment, account_reference, remote_id, document_type, fiscal_year, series,
         fiscal_number, document_date, total_amount, remote_status, remote_status_observed_at,
         metadata_digest)
       VALUES ('MOCK', 'synthetic-account', 'replacement-attempt', 'TD01', 2026, 'FPR',
         '99', '2026-08-27', 1000, 'NOT_DELIVERED', now(), repeat('3', 64))
       RETURNING id`,
    );
    assert.deepEqual(
      await findArubaRemoteCollision(client, {
        environment: "MOCK",
        accountReference: "synthetic-account",
        series: "FPR",
        fiscalYear: 2026,
        fiscalNumber: "99",
        documentType: "TD01",
        xmlSha256: null,
        remoteStatus: "DELIVERED",
      }),
      { id: replacement.rows[0]!.id, remote_id: "replacement-attempt" },
    );
    await assert.rejects(
      client.query(
        `INSERT INTO aruba_remote_documents
          (environment, account_reference, remote_id, document_type, fiscal_year, series,
           fiscal_number, document_date, total_amount, remote_status,
           remote_status_observed_at, metadata_digest)
         VALUES ('MOCK', 'synthetic-account', 'duplicate-active-attempt', 'TD01', 2026, 'FPR',
           '99', '2026-08-27', 1000, 'DELIVERED', now(), repeat('4', 64))`,
      ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "23505",
    );

    await client.query(
      `INSERT INTO aruba_deduplication_conflicts
        (environment, account_reference, existing_remote_document_id, incoming_remote_id,
         collision_key, incoming_payload_digest, sync_session_id)
       VALUES ('MOCK', 'synthetic-account', $1, 'replacement-attempt',
         'FISCAL_IDENTITY', repeat('5', 64), '10000000-0000-4000-8000-000000000001')`,
      [rejected.rows[0]!.id],
    );
    await client.query(
      `INSERT INTO aruba_document_matches
        (remote_document_id, status, method, matcher_version, signals_json, candidates_json)
       VALUES ($1, 'ERROR', 'NONE', 1, '{"deduplicationCollision":true}', '[]')`,
      [rejected.rows[0]!.id],
    );
    assert.deepEqual(
      await resolveRejectedAttemptIdentityConflicts(
        client,
        { environment: "MOCK", accountReference: "synthetic-account" },
        "replacement-attempt",
      ),
      [rejected.rows[0]!.id],
    );
    assert.deepEqual(
      (
        await client.query(
          `SELECT conflicts.resolved_at IS NOT NULL AS resolved,
                  NOT EXISTS (
                    SELECT 1 FROM aruba_document_matches matches
                    WHERE matches.remote_document_id = conflicts.existing_remote_document_id
                  ) AS stale_match_removed
           FROM aruba_deduplication_conflicts conflicts`,
        )
      ).rows[0],
      { resolved: true, stale_match_removed: true },
    );
  } finally {
    if (connected) {
      await client.end();
    }
    await fixture.drop();
  }
});
