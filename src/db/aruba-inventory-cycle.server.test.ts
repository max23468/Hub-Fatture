import assert from "node:assert/strict";
import test from "node:test";

import { hashToken } from "../crypto.server.ts";
import { AppError } from "../errors.ts";
import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

test("il perimetro Aruba resta immutabile, copre il cambio anno e persiste INCOMPLETE", async () => {
  const fixture = await temporaryDatabase("aruba_inventory_cycle");
  const firstToken = `synthetic-device-0001.${"a".repeat(43)}`;
  const secondToken = `synthetic-device-0002.${"b".repeat(43)}`;
  try {
    await runMigrations({ connectionString: fixture.connectionString });
    process.env.APP_ENV = "test";
    process.env.APP_BASE_URL = "http://localhost:8080";
    process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
    process.env.DATABASE_URL = fixture.connectionString;
    process.env.ARUBA_ACCOUNT_REFERENCE = "synthetic-aruba-account";

    const database = await import("./client.server.ts");
    const cycle = await import("./aruba-inventory-cycle.server.ts");
    const inbound = await import("./aruba-inbound.server.ts");
    const user = await database.getPool().query<{ id: number }>(
      `INSERT INTO users (username, password_hash, can_approve)
       VALUES ('Massimo', 'synthetic', true) RETURNING id`,
    );
    const issued = await inbound.issueArubaReadSession("synthetic-device-atomic", {
      id: user.rows[0]!.id,
      canApprove: true,
      requestId: "aruba-inventory-atomic-test",
    });
    const frozenManifest = await database.getPool().query<{ terminal: boolean }>(
      `SELECT terminal FROM aruba_sync_pages
       WHERE sync_session_id = $1 AND stream = '__manifest__'`,
      [issued.sessionId],
    );
    assert.deepEqual(frozenManifest.rows, [{ terminal: true }]);
    await database
      .getPool()
      .query("DELETE FROM aruba_sync_sessions WHERE id = $1", [issued.sessionId]);
    await database.getPool().query(
      `INSERT INTO aruba_sync_sessions
        (id, environment, account_reference, device_id, token_hash, status,
         started_at, absolute_expires_at, lease_expires_at)
       VALUES ('00000000-0000-4000-8000-000000000021', 'MOCK', 'synthetic-aruba-account',
         'synthetic-device-0001', $1, 'ACTIVE', '2026-12-31T20:00:00Z',
         '2027-01-01T02:00:00Z', '2027-01-01T02:00:00Z')`,
      [hashToken(firstToken)],
    );

    const initial = await cycle.arubaInventoryManifest(firstToken);
    assert.equal(initial.oldestReconciliationDate, "2026-12-31");
    assert.deepEqual(
      initial.streams.map((stream) => stream.name),
      ["invoices:2027", "credit-notes:2027", "invoices:2026", "credit-notes:2026"],
    );

    await database.getPool().query(
      `INSERT INTO aruba_remote_documents
        (environment, account_reference, remote_id, document_type, fiscal_year, series,
         fiscal_number, document_date, total_amount, remote_status, remote_status_observed_at,
         origin, metadata_digest)
       VALUES ('MOCK', 'synthetic-aruba-account', 'late-2025', 'TD01', 2025, 'FPR', '1',
         '2025-12-31', 100, 'SUBMITTED', now(), 'UNKNOWN', repeat('c', 64))`,
    );
    const afterDomainChange = await cycle.arubaInventoryManifest(firstToken);
    assert.deepEqual(
      afterDomainChange.streams.map((stream) => stream.name),
      initial.streams.map((stream) => stream.name),
    );

    const firstStreams = initial.streams.map((stream) => stream.name);
    await database.getPool().query(
      `INSERT INTO aruba_sync_pages
        (sync_session_id, stream, scan_ordinal, page_ordinal, cursor, terminal, full_scan,
         row_count, documents_json, payload_digest)
       SELECT '00000000-0000-4000-8000-000000000021', stream, 1, 1, stream || ':1',
              true, true, 0, '[]'::jsonb, md5(stream) || md5(stream)
       FROM unnest($1::text[]) AS stream`,
      [firstStreams],
    );
    assert.deepEqual(
      await cycle.completeStableArubaInventory(firstToken, firstStreams.toReversed(), 1, true),
      { completed: true },
    );
    assert.deepEqual(await inbound.failArubaInventory(firstToken, "READ_SYNC_FAILED"), {
      failed: false,
      ignored: true,
    });
    assert.deepEqual(await cycle.finishStableArubaInventory(firstToken), { completed: true });
    assert.deepEqual(
      (
        await database.getPool().query<{ status: string; error_code: string | null }>(
          `SELECT status, error_code FROM aruba_sync_sessions
           WHERE id = '00000000-0000-4000-8000-000000000021'`,
        )
      ).rows[0],
      { status: "COMPLETED", error_code: null },
    );
    await database.getPool().query(
      `INSERT INTO aruba_sync_sessions
        (id, environment, account_reference, device_id, token_hash, status,
         absolute_expires_at, lease_expires_at)
       VALUES ('00000000-0000-4000-8000-000000000022', 'MOCK', 'synthetic-aruba-account',
         'synthetic-device-0002', $1, 'ACTIVE', now() + interval '1 hour',
         now() + interval '30 minutes')`,
      [hashToken(secondToken)],
    );
    const second = await cycle.arubaInventoryManifest(secondToken);
    const secondStreams = second.streams.map((stream) => stream.name);
    assert.ok(secondStreams.includes("invoices:2025"));
    assert.equal(
      second.streams.find((stream) => stream.name === "invoices:2025")?.nonTerminalFrom,
      "2025-12-31",
    );
    await database.getPool().query(
      `INSERT INTO aruba_sync_sessions
        (id, environment, account_reference, device_id, token_hash, status, started_at,
         absolute_expires_at, lease_expires_at, failed_at, error_code)
       VALUES ('00000000-0000-4000-8000-000000000023', 'MOCK',
               'synthetic-aruba-account', 'synthetic-failed-incremental',
               repeat('f', 64), 'FAILED', now(), now() + interval '1 hour', NULL,
               now(), 'READ_SYNC_FAILED')`,
    );
    await database.getPool().query(
      `INSERT INTO aruba_sync_pages
        (sync_session_id, stream, scan_ordinal, page_ordinal, cursor, terminal, full_scan,
         row_count, documents_json, payload_digest)
       SELECT '00000000-0000-4000-8000-000000000022', stream, 1, 1, stream || ':1',
              true, false, 0, '[]'::jsonb, md5(stream) || md5(stream)
       FROM unnest($1::text[]) AS stream`,
      [secondStreams],
    );
    assert.deepEqual(
      await cycle.completeStableArubaInventory(secondToken, secondStreams, 1, false),
      { completed: true },
    );
    assert.notEqual((await inbound.getArubaInventoryHealth()).blockingReason, "FAILURE");
    await database.getPool().query(
      `INSERT INTO aruba_sync_pages
        (sync_session_id, stream, scan_ordinal, page_ordinal, cursor, terminal, full_scan,
         row_count, documents_json, payload_digest)
       SELECT '00000000-0000-4000-8000-000000000022', stream, 2, 1, stream || ':2',
              true, true, 0, '[]'::jsonb, md5(stream) || md5(stream)
       FROM unnest($1::text[]) AS stream`,
      [secondStreams.slice(0, -1)],
    );
    await assert.rejects(
      () => cycle.completeStableArubaInventory(secondToken, secondStreams, 2, true),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === "ARUBA_INVENTORY_INCOMPLETE" &&
        error.status === 409,
    );
    const failed = await database.getPool().query<{ status: string; error_code: string | null }>(
      `SELECT status, error_code FROM aruba_sync_sessions
       WHERE id = '00000000-0000-4000-8000-000000000022'`,
    );
    assert.deepEqual(failed.rows[0], {
      status: "INCOMPLETE",
      error_code: "ARUBA_INVENTORY_INCOMPLETE",
    });
  } finally {
    await import("./client.server.ts").then(({ closePool }) => closePool());
    await fixture.drop();
  }
});
