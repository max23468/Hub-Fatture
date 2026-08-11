import assert from "node:assert/strict";
import test from "node:test";

import { hashToken } from "../crypto.server.ts";
import { AppError } from "../errors.ts";
import { runMigrations } from "./migrations.server.ts";
import { temporaryDatabase } from "./database-fixture.ts";

test(
  "autenticazione, rate limiting e retention usano PostgreSQL reale",
  { timeout: 30_000 },
  async () => {
    const clean = await temporaryDatabase("auth");
    try {
      await runMigrations({ connectionString: clean.connectionString });
      process.env.APP_ENV = "test";
      process.env.APP_BASE_URL = "http://localhost:8080";
      process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
      process.env.DATABASE_URL = clean.connectionString;
      const auth = await import("./auth.server.ts");
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
      await assert.rejects(
        auth.setupAccounts({
          bootstrapToken: process.env.ADMIN_BOOTSTRAP_TOKEN,
          ownerPassword: "matteo88",
          agentPassword: "codex888",
          requestId: "test-setup-ripetuto",
        }),
        (error) => error instanceof AppError && error.code === "AUTH_SETUP_DISABLED",
      );
      const generatedRequestId = auth.requestId(
        new Request("http://localhost:8080", { headers: { "x-request-id": "controllato" } }),
      );
      assert.match(generatedRequestId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
      assert.notEqual(generatedRequestId, "controllato");
      const sessionCookies = await auth.login({
        username: "matteo",
        password: "matteo88",
        ipHash: "origine-titolare",
        requestId: "test-login",
      });
      assert.ok(sessionCookies.every((value) => value.includes("SameSite=Lax; HttpOnly")));
      const request = new Request("http://localhost:8080", {
        headers: { cookie: sessionCookies.map((value) => value.split(";", 1)[0]).join("; ") },
      });
      const sessionUser = (await auth.getSessionUser(request))!;
      assert.equal(sessionUser.username, "matteo");
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
      const secondSessionCookies = await auth.login({
        username: "matteo",
        password: "matteo88",
        ipHash: "origine-titolare-seconda",
        requestId: "test-login-seconda-sessione",
      });
      const secondRequest = new Request("http://localhost:8080", {
        headers: {
          cookie: secondSessionCookies.map((value) => value.split(";", 1)[0]).join("; "),
        },
      });
      assert.equal((await auth.getAccountProfile(request, sessionUser)).sessions.length, 2);
      await assert.rejects(
        auth.changePassword(
          request,
          {
            currentPassword: "sbagliata",
            newPassword: "matteo99",
            confirmation: "matteo99",
          },
          sessionUser,
          "test-password-errata",
        ),
        (error) => error instanceof AppError && error.code === "AUTH_CURRENT_PASSWORD_INVALID",
      );
      assert.equal(
        await auth.changePassword(
          request,
          {
            currentPassword: "matteo88",
            newPassword: "matteo99",
            confirmation: "matteo99",
          },
          sessionUser,
          "test-password-cambiata",
        ),
        1,
      );
      assert.equal(await auth.getSessionUser(secondRequest), null);
      assert.equal((await auth.getAccountProfile(request, sessionUser)).sessions.length, 1);
      await assert.rejects(
        auth.login({
          username: "matteo",
          password: "matteo88",
          ipHash: "origine-password-precedente",
          requestId: "test-password-precedente",
        }),
        /Nome utente o password non validi/,
      );
      const thirdSessionCookies = await auth.login({
        username: "matteo",
        password: "matteo99",
        ipHash: "origine-password-nuova",
        requestId: "test-password-nuova",
      });
      const thirdRequest = new Request("http://localhost:8080", {
        headers: { cookie: thirdSessionCookies.map((value) => value.split(";", 1)[0]).join("; ") },
      });
      assert.equal((await auth.getAccountProfile(request, sessionUser)).sessions.length, 2);
      assert.equal(await auth.revokeOtherSessions(request, sessionUser, "test-revoca-sessioni"), 1);
      assert.equal(await auth.getSessionUser(thirdRequest), null);
      assert.equal(
        (
          await database
            .getPool()
            .query(
              "SELECT count(*) FROM audit_events WHERE action IN ('ACCOUNT_PASSWORD_CHANGED', 'ACCOUNT_SESSIONS_REVOKED')",
            )
        ).rows[0].count,
        "2",
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
      const retention = await import("./retention.server.ts");
      await retention.pruneExpired();
      // La potatura di 17.7 dipende dal tempo trascorso, non dall'arrivo del prossimo login.
      assert.equal(
        (await database.getPool().query("SELECT count(*) FROM sessions WHERE id_hash = 'scaduta'"))
          .rows[0].count,
        "0",
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
    }
  },
);
