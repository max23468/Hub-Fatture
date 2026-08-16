import assert from "node:assert/strict";
import test from "node:test";

import { hashToken } from "../crypto.server.ts";
import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

test("lo stato INCOMPLETE sopravvive al rollback del completamento Aruba", async () => {
  const fixture = await temporaryDatabase("aruba_incomplete_state");
  const token = `synthetic-device-0001.${"a".repeat(43)}`;
  try {
    await runMigrations({ connectionString: fixture.connectionString });
    process.env.APP_ENV = "test";
    process.env.APP_BASE_URL = "http://localhost:8080";
    process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
    process.env.DATABASE_URL = fixture.connectionString;
    process.env.ARUBA_ACCOUNT_REFERENCE = "synthetic-aruba-account";

    const database = await import("./client.server.ts");
    const state = await import("./aruba-session-state.server.ts");
    await database.getPool().query(
      `INSERT INTO aruba_sync_sessions
        (id, environment, account_reference, device_id, token_hash, status,
         absolute_expires_at, lease_expires_at)
       VALUES ('00000000-0000-4000-8000-000000000011', 'MOCK', 'synthetic-aruba-account',
         'synthetic-device-0001', $1, 'SCANNING', now() + interval '1 hour',
         now() + interval '2 minutes')`,
      [hashToken(token)],
    );

    assert.equal(await state.markArubaInventoryIncomplete(token), true);
    const result = await database.getPool().query<{
      status: string;
      lease_expires_at: Date | null;
      failed_at: Date | null;
      error_code: string | null;
    }>(
      `SELECT status, lease_expires_at, failed_at, error_code
       FROM aruba_sync_sessions WHERE token_hash = $1`,
      [hashToken(token)],
    );
    assert.equal(result.rows[0]?.status, "INCOMPLETE");
    assert.equal(result.rows[0]?.lease_expires_at, null);
    assert.ok(result.rows[0]?.failed_at instanceof Date);
    assert.equal(result.rows[0]?.error_code, "ARUBA_INVENTORY_INCOMPLETE");
    assert.equal(await state.markArubaInventoryIncomplete(token), false);
  } finally {
    await import("./client.server.ts").then(({ closePool }) => closePool());
    await fixture.drop();
  }
});
