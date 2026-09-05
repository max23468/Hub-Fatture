import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../errors.ts";
import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

function tokenResponse(accessToken: string, refreshToken: string) {
  return Response.json({
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "bearer",
    expires_in: 1_800,
    ".issued": "Wed, 03 Sep 2031 12:00:00 GMT",
    ".expires": "Wed, 03 Sep 2031 12:30:00 GMT",
  });
}

function accountResponse(expired = false, usedSpaceKB = 256) {
  return Response.json({
    username: "utente-sintetico",
    pec: "utente-sintetico@pec.example.invalid",
    userDescription: "Impresa sintetica",
    countryCode: "IT",
    vatCode: "00000000000",
    fiscalCode: "00000000000",
    accountStatus: { expired, expirationDate: "2032-09-03" },
    usageStatus: { usedSpaceKB, maxSpaceKB: 1_024 },
  });
}

test("la sessione Aruba condivide signin e refresh senza ripersistire token o falsare userInfo", async () => {
  const database = await temporaryDatabase("aruba_connection_session");
  const originalFetch = globalThis.fetch;
  process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
  process.env.APP_BASE_URL = "http://localhost:8080";
  process.env.APP_ENV = "test";
  process.env.ARUBA_ACCOUNT_REFERENCE = "synthetic-aruba-account";
  process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 37).toString("base64url");
  process.env.DATABASE_URL = database.connectionString;
  try {
    await runMigrations({ connectionString: database.connectionString });
    const { encryptCredential } = await import("../crypto.server.ts");
    const { closePool, getPool } = await import("./client.server.ts");
    const connection = await import("./aruba-api-connection.server.ts");
    const settings = await import("./aruba-api-settings.server.ts");
    await getPool().query(
      `INSERT INTO connections
        (provider, environment, account_reference, encrypted_credentials, status,
         api_paused, inbound_enabled, automatic_authority, credentials_verified_at,
         credentials_rotated_at)
       VALUES ('ARUBA', 'DEVELOPMENT', 'synthetic-aruba-account', $1, 'CONNECTED',
         false, true, 'API', now(), now())`,
      [
        encryptCredential(
          {
            apiEnvironment: "DEMO",
            username: "utente-sintetico",
            password: "password-sintetica",
            expectedTaxId: "00000000000",
          },
          process.env.CREDENTIALS_ENCRYPTION_KEY!,
        ),
      ],
    );

    let passwordSignins = 0;
    let refreshSignins = 0;
    let userInfoReads = 0;
    let rejectRefresh = false;
    let accountExpired = false;
    let usedSpaceKB = 256;
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/userInfo") {
        userInfoReads += 1;
        return accountResponse(accountExpired, usedSpaceKB);
      }
      assert.equal(url.pathname, "/auth/signin");
      const body = new URLSearchParams(String(init.body));
      if (body.get("grant_type") === "refresh_token") {
        refreshSignins += 1;
        assert.equal(body.get("refresh_token"), refreshSignins === 1 ? "refresh-1" : "refresh-2");
        assert.equal(body.has("username"), false);
        assert.equal(body.has("password"), false);
        if (rejectRefresh) {
          return Response.json(
            { error: "invalid_grant", error_description: "refresh scaduto" },
            { status: 400 },
          );
        }
        return tokenResponse("access-2", "refresh-2");
      }
      passwordSignins += 1;
      assert.equal(body.get("username"), "utente-sintetico");
      assert.equal(body.get("password"), "password-sintetica");
      await new Promise((resolve) => setTimeout(resolve, 20));
      return tokenResponse(`access-password-${passwordSignins}`, "refresh-1");
    };

    const [first, concurrent] = await Promise.all([
      connection.authenticateConfiguredArubaApiForOutbound(),
      connection.authenticateConfiguredArubaApiForOutbound(),
    ]);
    assert.equal(first.session.accessToken, "access-password-1");
    assert.equal(concurrent.session.accessToken, "access-password-1");
    assert.equal(passwordSignins, 1);
    assert.equal(userInfoReads, 1);

    const initialSnapshot = await getPool().query<{
      account_info_json: Record<string, unknown>;
      account_info_checked_at: Date;
      encrypted_credentials: string;
    }>(
      `SELECT account_info_json, account_info_checked_at, encrypted_credentials
       FROM connections WHERE provider = 'ARUBA'`,
    );
    const firstCheckedAt = initialSnapshot.rows[0]!.account_info_checked_at.getTime();
    assert.equal(initialSnapshot.rows[0]!.account_info_json.username, "utente-sintetico");
    assert.equal(
      JSON.stringify(initialSnapshot.rows[0]!.account_info_json).includes("access-"),
      false,
    );
    assert.equal(
      initialSnapshot.rows[0]!.encrypted_credentials.includes("password-sintetica"),
      false,
    );
    const visibleAccount = (await settings.getArubaApiConnectionStatus()).account;
    assert.deepEqual(
      visibleAccount && {
        username: visibleAccount.username,
        pec: visibleAccount.pec,
        description: visibleAccount.userDescription,
        countryCode: visibleAccount.countryCode,
        vatCode: visibleAccount.vatCode,
        fiscalCode: visibleAccount.fiscalCode,
        expired: visibleAccount.accountStatus.expired,
        expirationDate: visibleAccount.accountStatus.expirationDate,
        usedSpaceKB: visibleAccount.usageStatus.usedSpaceKB,
        maxSpaceKB: visibleAccount.usageStatus.maxSpaceKB,
        usagePercent: visibleAccount.usagePercent,
        checkedAt: visibleAccount.checkedAt,
      },
      {
        username: "utente-sintetico",
        pec: "utente-sintetico@pec.example.invalid",
        description: "Impresa sintetica",
        countryCode: "IT",
        vatCode: "00000000000",
        fiscalCode: "00000000000",
        expired: false,
        expirationDate: "2032-09-03",
        usedSpaceKB: 256,
        maxSpaceKB: 1_024,
        usagePercent: 25,
        checkedAt: initialSnapshot.rows[0]!.account_info_checked_at.toISOString(),
      },
    );

    await connection.authenticateConfiguredArubaApiForOutbound();
    const cachedCheckedAt = await getPool().query<{ checked_at: Date }>(
      "SELECT account_info_checked_at AS checked_at FROM connections WHERE provider = 'ARUBA'",
    );
    assert.equal(cachedCheckedAt.rows[0]!.checked_at.getTime(), firstCheckedAt);
    assert.equal(passwordSignins, 1);
    assert.equal(userInfoReads, 1);

    await assert.rejects(
      connection.refreshConfiguredArubaApiAfterUnauthorized(),
      (error) => error instanceof AppError && error.code === "ARUBA_API_AUTH_INTERVAL_ACTIVE",
    );
    assert.equal(refreshSignins, 0);
    await getPool().query(
      "UPDATE aruba_api_auth_attempts SET attempted_at = now() - interval '2 minutes'",
    );
    const [refreshed, sharedRefresh] = await Promise.all([
      connection.refreshConfiguredArubaApiAfterUnauthorized(),
      connection.refreshConfiguredArubaApiAfterUnauthorized(),
    ]);
    assert.equal(refreshed.session.accessToken, "access-2");
    assert.equal(sharedRefresh.session.accessToken, "access-2");
    assert.equal(refreshSignins, 1);
    assert.equal(passwordSignins, 1);
    assert.equal(userInfoReads, 1);
    const refreshedCheckedAt = await getPool().query<{ checked_at: Date }>(
      "SELECT account_info_checked_at AS checked_at FROM connections WHERE provider = 'ARUBA'",
    );
    assert.equal(refreshedCheckedAt.rows[0]!.checked_at.getTime(), firstCheckedAt);

    await getPool().query(
      "UPDATE aruba_api_auth_attempts SET attempted_at = now() - interval '2 minutes'",
    );
    rejectRefresh = true;
    await assert.rejects(
      connection.refreshConfiguredArubaApiAfterUnauthorized(),
      (error) => error instanceof AppError && error.code === "ARUBA_API_AUTH_INTERVAL_ACTIVE",
    );
    assert.equal(refreshSignins, 2);
    assert.equal(passwordSignins, 1);
    await getPool().query(
      "UPDATE aruba_api_auth_attempts SET attempted_at = now() - interval '2 minutes'",
    );
    const recovered = await connection.authenticateConfiguredArubaApiForOutbound();
    assert.equal(recovered.session.accessToken, "access-password-2");
    assert.equal(refreshSignins, 2);
    assert.equal(passwordSignins, 2);
    assert.equal(userInfoReads, 2);
    const recoveredSnapshot = await getPool().query<{
      checked_at: Date;
      persisted: string;
    }>(
      `SELECT account_info_checked_at AS checked_at,
              account_info_json::text || encrypted_credentials AS persisted
       FROM connections WHERE provider = 'ARUBA'`,
    );
    assert.equal(recoveredSnapshot.rows[0]!.checked_at.getTime() >= firstCheckedAt, true);
    for (const secret of ["access-password-1", "access-2", "refresh-1", "refresh-2"]) {
      assert.equal(recoveredSnapshot.rows[0]!.persisted.includes(secret), false);
    }

    connection.invalidateConfiguredArubaApiSession();
    await getPool().query(
      "UPDATE aruba_api_auth_attempts SET attempted_at = now() - interval '2 minutes'",
    );
    accountExpired = true;
    await assert.rejects(
      connection.authenticateConfiguredArubaApiForOutbound(),
      (error) => error instanceof AppError && error.code === "AUTH_PROVIDER_EXPIRED",
    );

    connection.invalidateConfiguredArubaApiSession();
    await getPool().query(
      "UPDATE aruba_api_auth_attempts SET attempted_at = now() - interval '2 minutes'",
    );
    accountExpired = false;
    usedSpaceKB = 1_024;
    await assert.rejects(
      connection.authenticateConfiguredArubaApiForOutbound(),
      (error) => error instanceof AppError && error.code === "ARUBA_STORAGE_EXHAUSTED",
    );

    await closePool();
  } finally {
    globalThis.fetch = originalFetch;
    await import("./client.server.ts").then(({ closePool }) => closePool());
    await database.drop();
  }
});
