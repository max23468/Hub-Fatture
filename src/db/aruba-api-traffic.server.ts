import type pg from "pg";

import {
  ARUBA_API_POLICY,
  type ArubaApiReadScope,
  type ArubaApiTrafficScope,
} from "../aruba-api-policy.ts";
import { AppError } from "../errors.ts";
import type { ArubaApiEnvironment } from "../integrations/aruba-api.server.ts";
import { getPool, withTransaction } from "./client.server.ts";

type TrafficScope = ArubaApiTrafficScope;

interface TrafficLimitRow {
  api_environment: ArubaApiEnvironment;
  scope: TrafficScope;
  next_allowed_at: Date;
  cooldown_until: Date | null;
  last_rate_limited_at: Date | null;
  rate_limited_count: number;
}

const sleep = (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs));

async function lockEnvironment(client: pg.PoolClient, environment: ArubaApiEnvironment) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('aruba-api-traffic:' || $1))", [
    environment,
  ]);
}

async function activeCooldown(
  client: pg.Pool | pg.PoolClient,
  environment: ArubaApiEnvironment,
  scope?: ArubaApiTrafficScope,
) {
  const result = await client.query<{ cooldown_until: Date | null }>(
    `SELECT max(cooldown_until) AS cooldown_until
     FROM aruba_api_traffic_limits
     WHERE api_environment = $1 AND cooldown_until > now()
       AND ($2::text IS NULL OR scope = $2)`,
    [environment, scope ?? null],
  );
  return result.rows[0]?.cooldown_until ?? null;
}

export async function assertArubaApiCooldownInactive(
  environment: ArubaApiEnvironment,
  client: pg.Pool | pg.PoolClient = getPool(),
  scope?: ArubaApiTrafficScope,
) {
  if (await activeCooldown(client, environment, scope)) {
    throw new AppError("ARUBA_API_COOLDOWN_ACTIVE", 429);
  }
}

export async function waitForArubaApiReadSlot(
  environment: ArubaApiEnvironment,
  scope: ArubaApiReadScope,
) {
  const scheduledAt = await withTransaction(async (client) => {
    await lockEnvironment(client, environment);
    if (await activeCooldown(client, environment, scope)) {
      throw new AppError("ARUBA_API_COOLDOWN_ACTIVE", 429);
    }
    await client.query(
      `INSERT INTO aruba_api_traffic_limits (api_environment, scope)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [environment, scope],
    );
    const limit = await client.query<{ next_allowed_at: Date }>(
      `SELECT next_allowed_at FROM aruba_api_traffic_limits
       WHERE api_environment = $1 AND scope = $2
       FOR UPDATE`,
      [environment, scope],
    );
    const reservationTime = new Date(
      Math.max(Date.now(), limit.rows[0]?.next_allowed_at.getTime() ?? 0),
    );
    await client.query(
      `UPDATE aruba_api_traffic_limits
       SET next_allowed_at = $3::timestamptz
             + make_interval(secs => $4::double precision / 1000),
           reserved_request_count = reserved_request_count + 1,
           updated_at = now()
       WHERE api_environment = $1 AND scope = $2`,
      [
        environment,
        scope,
        reservationTime,
        scope === "INVOICE_READ"
          ? ARUBA_API_POLICY.invoiceReadIntervalMs
          : ARUBA_API_POLICY.notificationReadIntervalMs,
      ],
    );
    return reservationTime;
  });
  const delayMs = Math.max(0, scheduledAt.getTime() - Date.now());
  if (delayMs > 0) await sleep(delayMs);
  await assertArubaApiCooldownInactive(environment, getPool(), scope);
}

export async function waitForArubaApiSendSlot(environment: ArubaApiEnvironment) {
  const scheduledAt = await withTransaction(async (client) => {
    await lockEnvironment(client, environment);
    if (await activeCooldown(client, environment, "SEND")) {
      throw new AppError("ARUBA_API_COOLDOWN_ACTIVE", 429);
    }
    await client.query(
      `INSERT INTO aruba_api_traffic_limits (api_environment, scope)
       VALUES ($1, 'SEND') ON CONFLICT DO NOTHING`,
      [environment],
    );
    const current = await client.query<{ next_allowed_at: Date }>(
      `SELECT next_allowed_at FROM aruba_api_traffic_limits
       WHERE api_environment = $1 AND scope = 'SEND' FOR UPDATE`,
      [environment],
    );
    const reservationTime = new Date(
      Math.max(Date.now(), current.rows[0]?.next_allowed_at.getTime() ?? 0),
    );
    await client.query(
      `UPDATE aruba_api_traffic_limits SET
         next_allowed_at = $2::timestamptz + make_interval(secs => $3::double precision / 1000),
         reserved_request_count = reserved_request_count + 1, updated_at = now()
       WHERE api_environment = $1 AND scope = 'SEND'`,
      [environment, reservationTime, ARUBA_API_POLICY.sendIntervalMs],
    );
    return reservationTime;
  });
  const delayMs = Math.max(0, scheduledAt.getTime() - Date.now());
  if (delayMs > 0) await sleep(delayMs);
  await assertArubaApiCooldownInactive(environment, getPool(), "SEND");
}

export async function recordArubaApiRateLimited(
  environment: ArubaApiEnvironment,
  scope?: ArubaApiTrafficScope,
) {
  await withTransaction(async (client) => {
    await lockEnvironment(client, environment);
    await client.query(
      `INSERT INTO aruba_api_traffic_limits (api_environment, scope)
       SELECT $1, scope FROM unnest(
         CASE WHEN $2::text IS NULL THEN ARRAY['INVOICE_READ', 'NOTIFICATION_READ']::text[]
              ELSE ARRAY[$2::text] END
       ) AS scope
       ON CONFLICT DO NOTHING`,
      [environment, scope ?? null],
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
       WHERE api_environment = $1 AND ($3::text IS NULL OR scope = $3)`,
      [environment, ARUBA_API_POLICY.providerCooldownMs, scope ?? null],
    );
  });
}

export async function arubaApiCooldownDelayMs(
  environment: ArubaApiEnvironment,
  scope: ArubaApiTrafficScope,
  minimumMs = 15 * 60_000,
) {
  const cooldownUntil = await activeCooldown(getPool(), environment, scope);
  const jitterMs = Math.floor(Math.random() * 5_001);
  return Math.min(
    24 * 60 * 60_000,
    Math.max(minimumMs, (cooldownUntil?.getTime() ?? 0) - Date.now()) + jitterMs,
  );
}

export async function getArubaApiTrafficStatus(environment: ArubaApiEnvironment) {
  const result = await getPool().query<TrafficLimitRow>(
    `SELECT api_environment, scope, next_allowed_at, cooldown_until,
            last_rate_limited_at, rate_limited_count
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
      rateLimitedCount: Math.max(current.rateLimitedCount, row.rate_limited_count),
    }),
    {
      cooldownUntil: null as Date | null,
      lastRateLimitedAt: null as Date | null,
      rateLimitedCount: 0,
    },
  );
  return {
    cooldownUntil: summary.cooldownUntil?.toISOString() ?? null,
    lastRateLimitedAt: summary.lastRateLimitedAt?.toISOString() ?? null,
    rateLimitedCount: summary.rateLimitedCount,
  };
}
