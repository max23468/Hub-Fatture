import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import pg from "pg";

import { hashToken } from "../crypto.server.ts";
import { AppError } from "../errors.ts";
import { runMigrations } from "./migrations.server.ts";

// Nessuno skip silenzioso: senza database il gate deve dirlo, non passare in verde.
function requireTestDatabase(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL assente: avvia `docker compose --profile test up -d postgres-test` ed esportala.",
    );
  }
  return url;
}

const adminUrl = requireTestDatabase();

async function temporaryDatabase(suffix: string) {
  const name = `hub_fatture_${process.pid}_${suffix}`;
  const url = new URL(adminUrl);
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
  { timeout: 30_000 },
  async () => {
    const clean = await temporaryDatabase("clean");
    const upgrade = await temporaryDatabase("upgrade");
    try {
      assert.deepEqual(await runMigrations({ connectionString: clean.connectionString }), [
        "001_foundations.sql",
        "002_auth_audit.sql",
        "003_login_ip.sql",
        "004_reset_password_hashes.sql",
      ]);
      const cleanClient = new pg.Client({ connectionString: clean.connectionString });
      await cleanClient.connect();
      assert.equal(
        (await cleanClient.query("SELECT count(*) FROM schema_migrations")).rows[0].count,
        "4",
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

      const inserted = await mkdtemp(path.join(os.tmpdir(), "hf-migrations-inserted-"));
      await cp("migrations", inserted, { recursive: true });
      await writeFile(path.join(inserted, "001_inserted.sql"), "SELECT 1;\n");
      await assert.rejects(
        runMigrations({ connectionString: clean.connectionString, directory: inserted }),
        /Migrazione fuori ordine/,
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
      // Il cambio di formato degli hash rimuove gli account invece di conservare un percorso
      // di verifica legacy: senza questo l'installazione esistente resterebbe esclusa.
      assert.equal((await readback.query("SELECT count(*) FROM users")).rows[0].count, "0");
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
        ipHash: "origine-titolare",
        requestId: "test-login",
      });
      const request = new Request("http://localhost:8080", {
        headers: { cookie: sessionCookies.map((value) => value.split(";", 1)[0]).join("; ") },
      });
      assert.equal((await auth.getSessionUser(request))?.username, "matteo");
      const sessionToken = sessionCookies
        .find((value) => value.startsWith("sessione="))!
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
        .find((value) => value.startsWith("csrf="))!
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
        ipHash: "origine-agente",
        requestId: "test-agent-login",
      });

      const attacco = [];
      for (let index = 0; index < 7; index += 1) {
        attacco.push(
          await auth
            .login({
              username: "codex",
              password: `password-errata-${index}`,
              ipHash: "origine-attaccante",
              requestId: `test-rate-limit-${index}`,
            })
            .then(() => null)
            .catch((error: unknown) => error),
        );
      }
      assert.equal(
        attacco.filter(
          (error) => error instanceof AppError && error.code === "AUTH_INVALID_CREDENTIALS",
        ).length,
        5,
      );
      assert.equal(
        attacco.filter((error) => error instanceof AppError && error.code === "AUTH_RATE_LIMITED")
          .length,
        2,
      );
      // Oltre la soglia nemmeno la password giusta viene verificata: il limite è reale.
      await assert.rejects(
        auth.login({
          username: "codex",
          password: "codex888",
          ipHash: "origine-attaccante",
          requestId: "test-rate-limit-credenziale-valida",
        }),
        /Troppi tentativi/,
      );
      // Il titolare arriva da un'altra origine e non viene escluso da quell'attacco.
      assert.equal(
        (
          await auth.login({
            username: "codex",
            password: "codex888",
            ipHash: "origine-agente",
            requestId: "test-rate-limit-titolare",
          })
        ).length,
        2,
      );
      // Il percorso bloccato non scrive: sotto flood la tabella non cresce con le richieste.
      assert.equal(
        (
          await database
            .getPool()
            .query("SELECT count(*) FROM login_attempts WHERE ip_hash = 'origine-attaccante'")
        ).rows[0].count,
        "5",
      );
      // Sotto concorrenza il contatore può scavalcare la soglia senza mai assumerne il valore:
      // la deduplica dell'audit deve reggere anche allora.
      await database
        .getPool()
        .query(
          "INSERT INTO login_attempts (username, ip_hash, successful) SELECT 'matteo', 'origine-parallela', false FROM generate_series(1, 7)",
        );
      await assert.rejects(
        auth.login({
          username: "matteo",
          password: "matteo88",
          ipHash: "origine-parallela",
          requestId: "test-soglia-scavalcata",
        }),
        /Troppi tentativi/,
      );
      assert.equal(
        (
          await database
            .getPool()
            .query(
              "SELECT count(*) FROM audit_events WHERE action = 'LOGIN_RATE_LIMITED' AND metadata_json->>'scope' = 'origine-parallela'",
            )
        ).rows[0].count,
        "1",
      );
      // L'accesso legittimo non deve azzerare il contatore di chi sta attaccando lo stesso
      // username da un'altra origine.
      await assert.rejects(
        auth.login({
          username: "codex",
          password: "codex888",
          ipHash: "origine-attaccante",
          requestId: "test-rate-limit-persiste",
        }),
        /Troppi tentativi/,
      );
      // Una riga per episodio: l'audit resta osservabile senza crescere sotto attacco.
      assert.equal(
        (
          await database
            .getPool()
            .query(
              "SELECT count(*) FROM audit_events WHERE action = 'LOGIN_RATE_LIMITED' AND metadata_json->>'scope' = 'origine-attaccante'",
            )
        ).rows[0].count,
        "1",
      );
      await database.getPool().query(
        `INSERT INTO sessions (id_hash, user_id, csrf_token_hash, expires_at)
           SELECT 'scaduta', id, 'scaduta', now() - interval '1 hour' FROM users WHERE username = 'codex'`,
      );
      const retention = await import("../retention.server.ts");
      await retention.pruneExpired();
      // La potatura di 17.7 dipende dal tempo trascorso, non dall'arrivo del prossimo login.
      assert.equal(
        (await database.getPool().query("SELECT count(*) FROM sessions WHERE id_hash = 'scaduta'"))
          .rows[0].count,
        "0",
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
