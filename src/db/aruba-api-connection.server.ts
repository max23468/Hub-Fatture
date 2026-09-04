import { z } from "zod";

import { getConfig } from "../config.server.ts";
import { decryptCredential } from "../crypto.server.ts";
import { AppError } from "../errors.ts";
import {
  authenticateArubaApiWithAccount,
  readArubaApiAccountInfo,
  refreshArubaApiSession,
  type ArubaApiAccountInfo,
  type ArubaApiSession,
} from "../integrations/aruba-api.server.ts";
import { reserveArubaApiAuthentication } from "./aruba-api-authentication.server.ts";
import { recordArubaApiRateLimited } from "./aruba-api-traffic.server.ts";
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

interface CachedConnection {
  session: ArubaApiSession;
  account: ArubaApiAccountInfo;
  accountCheckedAt: number;
}

const sessions = new Map<string, CachedConnection>();
const flights = new Map<string, Promise<CachedConnection>>();
const REFRESH_MARGIN_MS = 5 * 60_000;
const ACCOUNT_MAX_AGE_MS = 5 * 60_000;

function assertUsableAccount(account: ArubaApiAccountInfo) {
  if (account.accountStatus.expired) throw new AppError("AUTH_PROVIDER_EXPIRED", 401);
  if (account.usageStatus.usedSpaceKB >= account.usageStatus.maxSpaceKB) {
    throw new AppError("ARUBA_STORAGE_EXHAUSTED", 409);
  }
}

async function refreshCachedConnection(input: {
  cacheKey: string;
  connectionId: string;
  credentials: z.infer<typeof credentialsSchema>;
}) {
  const now = Date.now();
  let cached = sessions.get(input.cacheKey);
  try {
    if (cached && cached.session.expiresAt <= now + REFRESH_MARGIN_MS) {
      cached =
        cached.session.refreshExpiresAt > now + REFRESH_MARGIN_MS
          ? await refreshConnectionSession(cached)
          : undefined;
    }
    if (!cached) {
      await reserveArubaApiAuthentication(input.credentials.apiEnvironment);
      const authenticated = await authenticateArubaApiWithAccount({
        environment: input.credentials.apiEnvironment,
        credentials: input.credentials,
        now,
      });
      cached = {
        session: authenticated.session,
        account: authenticated.account,
        accountCheckedAt: Date.now(),
      };
    } else if (cached.accountCheckedAt <= now - ACCOUNT_MAX_AGE_MS) {
      cached = {
        ...cached,
        account: await readArubaApiAccountInfo(cached.session),
        accountCheckedAt: Date.now(),
      };
    }
  } catch (error) {
    if (error instanceof AppError && error.code === "PROVIDER_RATE_LIMITED") {
      await recordArubaApiRateLimited(input.credentials.apiEnvironment, "AUTH");
    }
    throw error;
  }
  assertUsableAccount(cached.account);
  sessions.set(input.cacheKey, cached);
  await getPool().query(
    `UPDATE connections SET account_info_json = $2::jsonb,
       account_info_checked_at = $3, last_checked_at = now(), updated_at = now()
     WHERE id = $1`,
    [input.connectionId, JSON.stringify(cached.account), new Date(cached.accountCheckedAt)],
  );
  return cached;
}

async function refreshConnectionSession(cached: CachedConnection) {
  try {
    return { ...cached, session: await refreshArubaApiSession({ session: cached.session }) };
  } catch (error) {
    if (error instanceof AppError && error.code === "AUTH_PROVIDER_REFRESH_INVALID")
      return undefined;
    throw error;
  }
}

export function invalidateConfiguredArubaApiSession() {
  sessions.clear();
  flights.clear();
}

export async function refreshConfiguredArubaApiAfterUnauthorized() {
  for (const [key, cached] of sessions) {
    sessions.set(key, { ...cached, session: { ...cached.session, expiresAt: 0 } });
  }
  return authenticateConfiguredArubaApiForOutbound();
}

export async function authenticateConfiguredArubaApiForOutbound() {
  const environment = getConfig().APP_ENV === "production" ? "PRODUCTION" : "DEVELOPMENT";
  const result = await getPool().query<{
    id: string;
    account_reference: string;
    encrypted_credentials: string | null;
    status: string;
    api_paused: boolean;
    credentials_verified_at: Date | null;
    credentials_rotated_at: Date | null;
  }>(
    `SELECT id, account_reference, encrypted_credentials, status, api_paused,
            credentials_verified_at, credentials_rotated_at
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
  const cacheKey = `${current.id}:${current.credentials_rotated_at?.toISOString() ?? "initial"}`;
  const existingFlight = flights.get(cacheKey);
  const flight =
    existingFlight ?? refreshCachedConnection({ cacheKey, connectionId: current.id, credentials });
  if (!existingFlight) flights.set(cacheKey, flight);
  try {
    const cached = await flight;
    return { accountReference: current.account_reference, ...cached };
  } finally {
    if (!existingFlight) flights.delete(cacheKey);
  }
}
