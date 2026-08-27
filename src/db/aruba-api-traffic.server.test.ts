import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../errors.ts";
import { closePool, getPool } from "./client.server.ts";
import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

test("un 429 Aruba coordina il cooldown e impedisce retry ravvicinati", async () => {
  const database = await temporaryDatabase("aruba_traffic_guard");
  process.env.DATABASE_URL = database.connectionString;
  process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
  process.env.APP_BASE_URL = "http://localhost:8080";
  process.env.APP_ENV = "test";
  process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 31).toString("base64url");
  try {
    await runMigrations({ connectionString: database.connectionString });
    const traffic = await import("./aruba-api-traffic.server.ts");
    const connectors = await import("./connectors.server.ts");
    await traffic.recordArubaApiRateLimited("DEMO");
    await assert.rejects(
      traffic.assertArubaApiCooldownInactive("DEMO"),
      (error) => error instanceof AppError && error.code === "ARUBA_API_COOLDOWN_ACTIVE",
    );
    const status = await traffic.getArubaApiTrafficStatus("DEMO");
    assert.equal(status.cooldownUntil !== null, true);
    assert.equal(status.rateLimitedCount, 1);

    await getPool().query(
      `INSERT INTO jobs (type, status, run_at)
       VALUES ('aruba_backfill_inventory', 'PENDING', now())`,
    );
    const job = await connectors.claimJob("aruba-cooldown-test-worker");
    assert.equal(job?.type, "aruba_backfill_inventory");
    assert.equal(await connectors.failJob(job!, "PROVIDER_RATE_LIMITED"), false);
    const scheduled = await getPool().query<{
      status: string;
      delay_seconds: number;
      last_error_code: string;
    }>(
      `SELECT status, extract(epoch FROM run_at - now())::int AS delay_seconds,
              last_error_code
       FROM jobs WHERE id = $1`,
      [job!.id],
    );
    assert.equal(scheduled.rows[0]!.status, "PENDING");
    assert.equal(scheduled.rows[0]!.last_error_code, "PROVIDER_RATE_LIMITED");
    assert.equal(scheduled.rows[0]!.delay_seconds >= 3_895, true);
    assert.equal(scheduled.rows[0]!.delay_seconds <= 3_900, true);
    await getPool().query(
      `UPDATE jobs SET status = 'RUNNING', run_at = now(), locked_by = 'worker-spento',
         claim_token = gen_random_uuid(), lease_expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [job!.id],
    );
    const recovered = await connectors.claimJob("aruba-recovery-test-worker");
    assert.equal(recovered?.id, job!.id);
    assert.equal(recovered?.attempts, 2);
    assert.equal(recovered?.claimToken === job!.claimToken, false);
  } finally {
    await closePool();
    await database.drop();
  }
});
