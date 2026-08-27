import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { decryptCredential, encryptCredential } from "../crypto.server.ts";
import { temporaryDatabase, withClient } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

const execute = promisify(execFile);

function containerConnectionString(connectionString: string) {
  const url = new URL(connectionString);
  url.hostname = "127.0.0.1";
  url.port = "5432";
  return url.toString();
}

async function postgresContainerFor(connectionString: string) {
  const port = new URL(connectionString).port || "5432";
  const containers = await execute("docker", ["ps", "--format", "{{.ID}}\t{{.Ports}}"]);
  const match = containers.stdout.split("\n").find((line) => line.includes(`:${port}->5432/tcp`));
  const containerId = match?.split("\t", 1)[0];
  if (!containerId) throw new Error(`Container PostgreSQL non trovato sulla porta ${port}`);
  return containerId;
}

async function dumpAndRestoreWithServerClient(
  containerId: string,
  sourceConnectionString: string,
  targetConnectionString: string,
  backupPath: string,
) {
  const containerBackupPath = `/tmp/${path.basename(path.dirname(backupPath))}.dump`;
  try {
    await execute("docker", [
      "exec",
      containerId,
      "pg_dump",
      "--format=custom",
      "--file",
      containerBackupPath,
      containerConnectionString(sourceConnectionString),
    ]);
    await execute("docker", ["cp", `${containerId}:${containerBackupPath}`, backupPath]);
    await execute("docker", [
      "exec",
      containerId,
      "pg_restore",
      "--no-owner",
      "--no-privileges",
      "--dbname",
      containerConnectionString(targetConnectionString),
      containerBackupPath,
    ]);
  } finally {
    await execute("docker", ["exec", containerId, "rm", "-f", containerBackupPath]).catch(
      () => undefined,
    );
  }
}

async function dumpAndRestore(
  sourceConnectionString: string,
  targetConnectionString: string,
  backupPath: string,
) {
  const containerId = await postgresContainerFor(sourceConnectionString).catch(() => null);
  if (containerId) {
    await dumpAndRestoreWithServerClient(
      containerId,
      sourceConnectionString,
      targetConnectionString,
      backupPath,
    );
    return;
  }
  try {
    await execute("pg_dump", ["--format=custom", "--file", backupPath, sourceConnectionString]);
    await execute("pg_restore", [
      "--no-owner",
      "--no-privileges",
      "--dbname",
      targetConnectionString,
      backupPath,
    ]);
  } catch (error) {
    throw new Error("Client PostgreSQL compatibile non disponibile per la prova di restore", {
      cause: error,
    });
  }
}

test("backup e restore preservano la credenziale Aruba cifrata e il checkpoint", async () => {
  const source = await temporaryDatabase("aruba_restore_source");
  const target = await temporaryDatabase("aruba_restore_target");
  const directory = await mkdtemp(path.join(tmpdir(), "hub-fatture-aruba-restore-"));
  const backupPath = path.join(directory, "synthetic.dump");
  const key = Buffer.alloc(32, 23).toString("base64url");
  const credentials = {
    apiEnvironment: "DEMO",
    username: "utente-restore-sintetico",
    password: "password-restore-sintetica",
    expectedTaxId: "00000000000",
  } as const;
  const encrypted = encryptCredential(credentials, key);
  try {
    await runMigrations({ connectionString: source.connectionString });
    await withClient(source.connectionString, async (client) => {
      await client.query(
        `INSERT INTO connections
          (provider, environment, account_reference, encrypted_credentials, status,
           api_paused, inbound_enabled, automatic_authority, credentials_verified_at)
         VALUES ('ARUBA', 'DEVELOPMENT', 'synthetic-restore-account', $1, 'PAUSED',
           true, false, 'BROWSER', now())`,
        [encrypted],
      );
      await client.query(
        `INSERT INTO aruba_sync_runs
          (id, environment, api_environment, account_reference, kind, authority_mode,
           status, window_start, window_end, checkpoint_start, checkpoint_end,
           checkpoint_page, request_count, lease_expires_at)
         VALUES ('20000000-0000-4000-8000-000000000001', 'MOCK', 'DEMO',
           'synthetic-restore-account', 'BACKFILL', 'SHADOW', 'RUNNING',
           '2026-01-01T00:00:00Z', '2026-01-05T00:00:00Z',
           '2026-01-03T00:00:00Z', '2026-01-05T00:00:00Z', 3, 42, now())`,
      );
    });
    await dumpAndRestore(source.connectionString, target.connectionString, backupPath);
    await withClient(target.connectionString, async (client) => {
      const restored = await client.query<{
        encrypted_credentials: string;
        checkpoint_start: Date;
        checkpoint_page: number;
        request_count: number;
      }>(
        `SELECT connections.encrypted_credentials, runs.checkpoint_start,
                runs.checkpoint_page, runs.request_count
         FROM connections
         JOIN aruba_sync_runs AS runs
           ON runs.account_reference = connections.account_reference
         WHERE connections.provider = 'ARUBA'`,
      );
      assert.equal(restored.rows[0]!.encrypted_credentials, encrypted);
      assert.equal(restored.rows[0]!.encrypted_credentials.includes(credentials.password), false);
      assert.deepEqual(
        decryptCredential(restored.rows[0]!.encrypted_credentials, key),
        credentials,
      );
      assert.deepEqual(
        {
          checkpointStart: restored.rows[0]!.checkpoint_start.toISOString(),
          checkpointPage: restored.rows[0]!.checkpoint_page,
          requestCount: restored.rows[0]!.request_count,
        },
        {
          checkpointStart: "2026-01-03T00:00:00.000Z",
          checkpointPage: 3,
          requestCount: 42,
        },
      );
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
    await source.drop();
    await target.drop();
  }
});
