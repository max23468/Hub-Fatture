import type pg from "pg";

import {
  ARUBA_API_POLICY,
  arubaApiReadIntervalMs,
  type ArubaApiReadScope,
} from "../aruba-api-policy.ts";
import { AppError } from "../errors.ts";
import type { ArubaApiEnvironment } from "../integrations/aruba-api.server.ts";
import { getPool, withTransaction } from "./client.server.ts";

type TrafficScope = ArubaApiReadScope | "GLOBAL_PROVIDER";

interface TrafficLimitRow {
  api_environment: ArubaApiEnvironment;
  scope: TrafficScope;
  next_allowed_at: Date;
  cooldown_until: Date | null;
  last_rate_limited_at: Date | null;
  reserved_request_count: string;
  rate_limited_count: number;
}

const sleep = (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs));

async function lockEnvironment(client: pg.PoolClient, environment: ArubaApiEnvironment) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('aruba-api-traffic:' || $1))", [
    environment,
  ]);
}

async function activeCooldown(client: pg.Pool | pg.PoolClient, environment: ArubaApiEnvironment) {
  const result = await client.query<{ cooldown_until: Date | null }>(
    `SELECT max(cooldown_until) AS cooldown_until
     FROM aruba_api_traffic_limits
     WHERE api_environment = $1 AND cooldown_until > now()`,
    [environment],
  );
  return result.rows[0]?.cooldown_until ?? null;
}

export async function assertArubaApiCooldownInactive(
  environment: ArubaApiEnvironment,
  client: pg.Pool | pg.PoolClient = getPool(),
) {
  if (await activeCooldown(client, environment)) {
    throw new AppError("ARUBA_API_COOLDOWN_ACTIVE", 429);
  }
}

export async function waitForArubaApiReadSlot(
  environment: ArubaApiEnvironment,
  scope: ArubaApiReadScope,
) {
  const scheduledAt = await withTransaction(async (client) => {
    await lockEnvironment(client, environment);
    if (await activeCooldown(client, environment)) {
      throw new AppError("ARUBA_API_COOLDOWN_ACTIVE", 429);
    }
    await client.query(
      `INSERT INTO aruba_api_traffic_limits (api_environment, scope)
       VALUES ($1, 'GLOBAL_PROVIDER'), ($1, $2)
       ON CONFLICT DO NOTHING`,
      [environment, scope],
    );
    const limits = await client.query<{ next_allowed_at: Date }>(
      `SELECT next_allowed_at FROM aruba_api_traffic_limits
       WHERE api_environment = $1 AND scope IN ('GLOBAL_PROVIDER', $2)
       FOR UPDATE`,
      [environment, scope],
    );
    const reservationTime = new Date(
      Math.max(Date.now(), ...limits.rows.map((row) => row.next_allowed_at.getTime())),
    );
    await client.query(
      `UPDATE aruba_api_traffic_limits
       SET next_allowed_at = CASE scope
             WHEN 'GLOBAL_PROVIDER' THEN $3::timestamptz + make_interval(secs => $4::double precision / 1000)
             ELSE $3::timestamptz + make_interval(secs => $5::double precision / 1000)
           END,
           reserved_request_count = reserved_request_count + 1,
           updated_at = now()
       WHERE api_environment = $1 AND scope IN ('GLOBAL_PROVIDER', $2)`,
      [
        environment,
        scope,
        reservationTime,
        ARUBA_API_POLICY.globalProviderIntervalMs,
        arubaApiReadIntervalMs(scope),
      ],
    );
    return reservationTime;
  });
  const delayMs = Math.max(0, scheduledAt.getTime() - Date.now());
  if (delayMs > 0) await sleep(delayMs);
  await assertArubaApiCooldownInactive(environment);
}

export async function waitForArubaApiAuthenticationTrafficSlot(environment: ArubaApiEnvironment) {
  const scheduledAt = await withTransaction(async (client) => {
    await lockEnvironment(client, environment);
    if (await activeCooldown(client, environment)) {
      throw new AppError("ARUBA_API_COOLDOWN_ACTIVE", 429);
    }
    await client.query(
      `INSERT INTO aruba_api_traffic_limits (api_environment, scope)
       VALUES ($1, 'GLOBAL_PROVIDER') ON CONFLICT DO NOTHING`,
      [environment],
    );
    const limit = await client.query<{ next_allowed_at: Date }>(
      `SELECT next_allowed_at FROM aruba_api_traffic_limits
       WHERE api_environment = $1 AND scope = 'GLOBAL_PROVIDER' FOR UPDATE`,
      [environment],
    );
    const reservationTime = new Date(
      Math.max(Date.now(), limit.rows[0]?.next_allowed_at.getTime() ?? 0),
    );
    await client.query(
      `UPDATE aruba_api_traffic_limits
       SET next_allowed_at = $2::timestamptz + make_interval(
             secs => $3::double precision * 2 / 1000
           ),
           reserved_request_count = reserved_request_count + 2,
           updated_at = now()
       WHERE api_environment = $1 AND scope = 'GLOBAL_PROVIDER'`,
      [environment, reservationTime, ARUBA_API_POLICY.globalProviderIntervalMs],
    );
    return reservationTime;
  });
  const delayMs = Math.max(0, scheduledAt.getTime() - Date.now());
  if (delayMs > 0) await sleep(delayMs);
  await assertArubaApiCooldownInactive(environment);
}

export async function recordArubaApiRateLimited(environment: ArubaApiEnvironment) {
  await withTransaction(async (client) => {
    await lockEnvironment(client, environment);
    await client.query(
      `INSERT INTO aruba_api_traffic_limits (api_environment, scope)
       VALUES ($1, 'GLOBAL_PROVIDER'), ($1, 'INVOICE_READ'), ($1, 'NOTIFICATION_READ')
       ON CONFLICT DO NOTHING`,
      [environment],
    );
    await client.query(
      `UPDATE aruba_api_traffic_limits
       SET cooldown_until = greatest(
             coalesce(cooldown_until, '-infinity'::timestamptz),
             now() + make_interval(secs => $2::double precision / 1000)
           ),
           last_rate_limited_at = now(),
           rate_limited_count = rate_limited_count + 1,
           updated_at = now()
       WHERE api_environment = $1`,
      [environment, ARUBA_API_POLICY.providerCooldownMs],
    );
  });
}

export async function getArubaApiTrafficStatus(environment: ArubaApiEnvironment) {
  const result = await getPool().query<TrafficLimitRow>(
    `SELECT api_environment, scope, next_allowed_at, cooldown_until,
            last_rate_limited_at, reserved_request_count, rate_limited_count
     FROM aruba_api_traffic_limits
     WHERE api_environment = $1 ORDER BY scope`,
    [environment],
  );
  const now = Date.now();
  const summary = result.rows.reduce(
    (current, row) => ({
      cooldownUntil:
        row.cooldown_until &&
        row.cooldown_until.getTime() > now &&
        (!current.cooldownUntil || row.cooldown_until > current.cooldownUntil)
          ? row.cooldown_until
          : current.cooldownUntil,
      lastRateLimitedAt:
        row.last_rate_limited_at &&
        (!current.lastRateLimitedAt || row.last_rate_limited_at > current.lastRateLimitedAt)
          ? row.last_rate_limited_at
          : current.lastRateLimitedAt,
      reservedProviderRequests:
        row.scope === "GLOBAL_PROVIDER"
          ? Math.max(current.reservedProviderRequests, Number(row.reserved_request_count))
          : current.reservedProviderRequests,
      rateLimitedCount: Math.max(current.rateLimitedCount, row.rate_limited_count),
    }),
    {
      cooldownUntil: null as Date | null,
      lastRateLimitedAt: null as Date | null,
      reservedProviderRequests: 0,
      rateLimitedCount: 0,
    },
  );
  return {
    cooldownUntil: summary.cooldownUntil?.toISOString() ?? null,
    lastRateLimitedAt: summary.lastRateLimitedAt?.toISOString() ?? null,
    reservedProviderRequests: summary.reservedProviderRequests,
    rateLimitedCount: summary.rateLimitedCount,
  };
}
