import assert from "node:assert/strict";
import test from "node:test";

import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

test("le Impostazioni mostrano l’attività del helper di lettura Aruba", async () => {
  const fixture = await temporaryDatabase("aruba_settings");
  try {
    await runMigrations({ connectionString: fixture.connectionString });
    process.env.APP_ENV = "test";
    process.env.APP_BASE_URL = "http://localhost:8080";
    process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
    process.env.DATABASE_URL = fixture.connectionString;
    process.env.ARUBA_ACCOUNT_REFERENCE = "synthetic-aruba-account";

    const database = await import("./client.server.ts");
    const aruba = await import("./aruba.server.ts");
    await database.getPool().query(
      `INSERT INTO aruba_sync_sessions
        (id, environment, account_reference, device_id, token_hash, status,
         helper_version, browser_name, absolute_expires_at, last_heartbeat_at,
         started_at, completed_at, full_scan_completed_at, inventory_watermark)
       VALUES
        ('00000000-0000-4000-8000-000000000001', 'MOCK', 'synthetic-aruba-account',
         'synthetic-device-0001', repeat('a', 64), 'COMPLETED', '0.1.0', 'chrome',
         '2026-08-15T20:00:00Z', '2026-08-15T12:18:00Z',
         '2026-08-15T12:00:00Z', '2026-08-15T12:19:00Z',
         '2026-08-15T12:19:00Z', 1),
        ('00000000-0000-4000-8000-000000000002', 'MOCK', 'un altro account',
         'synthetic-device-0002', repeat('b', 64), 'COMPLETED', '9.9.9', 'msedge',
         '2026-08-15T21:00:00Z', '2026-08-15T13:18:00Z',
         '2026-08-15T13:00:00Z', '2026-08-15T13:19:00Z',
         '2026-08-15T13:19:00Z', 2)`,
    );

    const settings = await aruba.getArubaSettings();
    assert.deepEqual(settings.helper, {
      lastSeenAt: "2026-08-15T12:18:00.000Z",
      version: "0.1.0",
      browser: "chrome",
      lastReadbackAt: "2026-08-15T12:19:00.000Z",
    });
  } finally {
    await import("./client.server.ts").then(({ closePool }) => closePool());
    await fixture.drop();
  }
});
