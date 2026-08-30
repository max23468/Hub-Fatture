import { z } from "zod";

import { getConfig } from "../config.server.ts";
import { decryptCredential } from "../crypto.server.ts";
import { AppError } from "../errors.ts";
import { authenticateArubaApi } from "../integrations/aruba-api.server.ts";
import { reserveArubaApiAuthentication } from "./aruba-api-authentication.server.ts";
import { getPool } from "./client.server.ts";

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
  await reserveArubaApiAuthentication(credentials.apiEnvironment);
  return {
    accountReference: current.account_reference,
    session: await authenticateArubaApi({
      environment: credentials.apiEnvironment,
      credentials,
    }),
  };
}
