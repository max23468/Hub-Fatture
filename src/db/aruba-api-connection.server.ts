import { z } from "zod";

import { ARUBA_API_POLICY } from "../aruba-api-policy.ts";
import { getConfig } from "../config.server.ts";
import { decryptCredential } from "../crypto.server.ts";
import { AppError } from "../errors.ts";
import {
  authenticateArubaApi,
  type ArubaApiEnvironment,
} from "../integrations/aruba-api.server.ts";
import { assertArubaApiCooldownInactive } from "./aruba-api-traffic.server.ts";
import { getPool, withTransaction } from "./client.server.ts";

const credentialsSchema = z.object({
  apiEnvironment: z.enum(["DEMO", "PRODUCTION"]),
  username: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(500),
  expectedTaxId: z.string().trim().min(1).max(64),
});

function credentialsKey(): string {
  const value = getConfig().CREDENTIALS_ENCRYPTION_KEY;
  if (!value) throw new AppError("PROVIDER_NOT_CONFIGURED", 503);
  return value;
}

async function reserveAuthentication(environment: ArubaApiEnvironment) {
  await assertArubaApiCooldownInactive(environment);
  await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('aruba-api-authentication'))");
    await assertArubaApiCooldownInactive(environment, client);
    const latest = await client.query<{ attempted_at: Date }>(
      "SELECT attempted_at FROM aruba_api_auth_attempts ORDER BY attempted_at DESC LIMIT 1",
    );
    if (
      latest.rows[0] &&
      Date.now() - latest.rows[0].attempted_at.getTime() < ARUBA_API_POLICY.authenticationIntervalMs
    ) {
      throw new AppError("ARUBA_API_AUTH_INTERVAL_ACTIVE", 429);
    }
    await client.query("INSERT INTO aruba_api_auth_attempts DEFAULT VALUES");
    await client.query(
      "DELETE FROM aruba_api_auth_attempts WHERE attempted_at < now() - interval '1 day'",
    );
  });
}

export async function authenticateConfiguredArubaApiForOutbound() {
  const environment = getConfig().APP_ENV === "production" ? "PRODUCTION" : "DEVELOPMENT";
  const result = await getPool().query<{
    account_reference: string;
    encrypted_credentials: string | null;
    status: string;
    api_paused: boolean;
    credentials_verified_at: Date | null;
  }>(
    `SELECT account_reference, encrypted_credentials, status, api_paused,
            credentials_verified_at
     FROM connections WHERE provider = 'ARUBA' AND environment = $1`,
    [environment],
  );
  const current = result.rows[0];
  if (
    !current?.encrypted_credentials ||
    !current.credentials_verified_at ||
    current.api_paused ||
    current.status !== "CONNECTED"
  ) {
    throw new AppError("PROVIDER_NOT_CONFIGURED", 503);
  }
  let credentials: z.infer<typeof credentialsSchema>;
  try {
    credentials = credentialsSchema.parse(
      decryptCredential<unknown>(current.encrypted_credentials, credentialsKey()),
    );
  } catch {
    throw new AppError("PROVIDER_NOT_CONFIGURED", 503);
  }
  await reserveAuthentication(credentials.apiEnvironment);
  return {
    accountReference: current.account_reference,
    session: await authenticateArubaApi({
      environment: credentials.apiEnvironment,
      credentials,
    }),
  };
}
