import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import pg from "pg";

import { hashToken } from "../crypto.server.ts";
import { AppError } from "../errors.ts";
import { runMigrations } from "./migrations.server.ts";

const adminUrl = process.env.TEST_DATABASE_URL;

async function temporaryDatabase(suffix: string) {
  const name = `hub_fatture_${process.pid}_${suffix}`;
  const url = new URL(adminUrl!);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  url.pathname = `/${name}`;
  return {
    connectionString: url.toString(),
    async drop() {
      const client = new pg.Client({ connectionString: adminUrl });
      await client.connect();
      await client.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await client.end();
    },
  };
}

test(
  "installazione vuota, checksum e upgrade preservano lo snapshot",
  { skip: !adminUrl, timeout: 30_000 },
  async () => {
    const clean = await temporaryDatabase("clean");
    const upgrade = await temporaryDatabase("upgrade");
    try {
      assert.deepEqual(await runMigrations({ connectionString: clean.connectionString }), [
        "001_foundations.sql",
        "002_auth_audit.sql",
      ]);
      const cleanClient = new pg.Client({ connectionString: clean.connectionString });
      await cleanClient.connect();
      assert.equal(
        (await cleanClient.query("SELECT count(*) FROM schema_migrations")).rows[0].count,
        "2",
      );
      await cleanClient.end();

      const changed = await mkdtemp(path.join(os.tmpdir(), "hf-migrations-changed-"));
      await cp("migrations", changed, { recursive: true });
      await writeFile(
        path.join(changed, "001_foundations.sql"),
        `${await readFile(path.join(changed, "001_foundations.sql"), "utf8")}\n-- modifica vietata\n`,
      );
      await assert.rejects(
        runMigrations({ connectionString: clean.connectionString, directory: changed }),
        /Migrazione applicata modificata/,
      );
      await rm(path.join(changed, "001_foundations.sql"));
      await assert.rejects(
        runMigrations({ connectionString: clean.connectionString, directory: changed }),
        /Migrazione applicata rimossa/,
      );

      const firstOnly = await mkdtemp(path.join(os.tmpdir(), "hf-migrations-first-"));
      await cp("migrations/001_foundations.sql", path.join(firstOnly, "001_foundations.sql"));
      await runMigrations({ connectionString: upgrade.connectionString, directory: firstOnly });
      const upgradeClient = new pg.Client({ connectionString: upgrade.connectionString });
      await upgradeClient.connect();
      await upgradeClient.query(
        "INSERT INTO users (username, password_hash) VALUES ('matteo', 'synthetic')",
      );
      await upgradeClient.end();
      await runMigrations({ connectionString: upgrade.connectionString });
      const readback = new pg.Client({ connectionString: upgrade.connectionString });
      await readback.connect();
      assert.equal((await readback.query("SELECT username FROM users")).rows[0].username, "matteo");
      assert.equal(
        (await readback.query("SELECT to_regclass('audit_events') AS table_name")).rows[0]
          .table_name,
        "audit_events",
      );
      await readback.end();

      process.env.APP_ENV = "test";
      process.env.APP_BASE_URL = "http://localhost:8080";
      process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
      process.env.DATABASE_URL = clean.connectionString;
      const auth = await import("../auth.server.ts");
      const settings = await import("./settings.server.ts");
      const database = await import("./client.server.ts");
      assert.equal(
        await auth.getSessionUser(
          new Request("http://localhost:8080", { headers: { cookie: "invalid=%E0%A4%A" } }),
        ),
        null,
      );
      await assert.rejects(
        auth.setupAccounts({
          bootstrapToken: process.env.ADMIN_BOOTSTRAP_TOKEN,
          ownerPassword: "sette77",
          agentPassword: "codex888",
          requestId: "test-invalid-setup",
        }),
        /8 a 128 caratteri/,
      );
      await auth.setupAccounts({
        bootstrapToken: process.env.ADMIN_BOOTSTRAP_TOKEN,
        ownerPassword: "matteo88",
        agentPassword: "codex888",
        requestId: "test-setup",
      });
      const sessionCookies = await auth.login({
        username: "matteo",
        password: "matteo88",
        requestId: "test-login",
      });
      const request = new Request("http://localhost:8080", {
        headers: { cookie: sessionCookies.map((value) => value.split(";", 1)[0]).join("; ") },
      });
      assert.equal((await auth.getSessionUser(request))?.username, "matteo");
      const sessionToken = sessionCookies
        .find((value) => value.startsWith("hf_session="))!
        .split("=", 2)[1]!
        .split(";", 1)[0]!;
      assert.equal(
        (
          await database
            .getPool()
            .query("SELECT count(*) FROM sessions WHERE id_hash = $1", [sessionToken])
        ).rows[0].count,
        "0",
      );
      assert.equal(
        (
          await database
            .getPool()
            .query("SELECT count(*) FROM sessions WHERE id_hash = $1", [hashToken(sessionToken)])
        ).rows[0].count,
        "1",
      );
      const csrf = sessionCookies
        .find((value) => value.startsWith("hf_csrf="))!
        .split("=", 2)[1]!
        .split(";", 1)[0]!;
      await auth.logout(request, csrf);
      assert.equal(await auth.getSessionUser(request), null);
      assert.equal(
        (
          await database
            .getPool()
            .query("SELECT count(*) FROM audit_events WHERE action = 'LOGOUT_SUCCEEDED'")
        ).rows[0].count,
        "1",
      );

      await auth.login({
        username: "codex",
        password: "codex888",
        requestId: "test-agent-login",
      });

      const limited = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          auth
            .login({
              username: `intruso-${index}`,
              password: "password-errata",
              requestId: `test-rate-limit-${index}`,
            })
            .then(() => null)
            .catch((error: unknown) => error),
        ),
      );
      assert.equal(
        limited.filter(
          (error) => error instanceof AppError && error.code === "AUTH_INVALID_CREDENTIALS",
        ).length,
        5,
      );
      assert.equal(
        limited.filter((error) => error instanceof AppError && error.code === "AUTH_RATE_LIMITED")
          .length,
        1,
      );

      assert.deepEqual(await settings.updateSetting("example", { enabled: true }, 0), {
        value: { enabled: true },
        version: 1,
      });
      await assert.rejects(
        settings.updateSetting("example", { enabled: false }, 0),
        /I dati sono cambiati/,
      );
      assert.deepEqual(await settings.getSetting("example"), {
        value: { enabled: true },
        version: 1,
      });
      const concurrentSettings = await Promise.allSettled([
        settings.updateSetting("concurrent", { writer: 1 }, 0),
        settings.updateSetting("concurrent", { writer: 2 }, 0),
      ]);
      assert.equal(concurrentSettings.filter(({ status }) => status === "fulfilled").length, 1);
      assert.equal(
        concurrentSettings.filter(
          (result) =>
            result.status === "rejected" &&
            result.reason instanceof AppError &&
            result.reason.code === "CONFLICT_REVISION",
        ).length,
        1,
      );
      assert.equal(
        (
          await database
            .getPool()
            .query(
              "SELECT count(DISTINCT actor_id) FROM audit_events WHERE action = 'LOGIN_SUCCEEDED'",
            )
        ).rows[0].count,
        "2",
      );
      await database.closePool();
    } finally {
      await import("./client.server.ts").then(({ closePool }) => closePool());
      await clean.drop();
      await upgrade.drop();
    }
  },
);
