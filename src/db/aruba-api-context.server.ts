import type pg from "pg";
import { z } from "zod";

import { ARUBA_API_POLICY, type ArubaApiTrafficScope } from "../aruba-api-policy.ts";
import { getConfig } from "../config.server.ts";
import { decryptCredential } from "../crypto.server.ts";
import { AppError } from "../errors.ts";
import type { ArubaApiEnvironment } from "../integrations/aruba-api.server.ts";
import { recordArubaApiRateLimited } from "./aruba-api-traffic.server.ts";
import type { JobType } from "./connector-types.server.ts";

export const WINDOW_MS = ARUBA_API_POLICY.backfillWindowMs;
export const INCREMENTAL_OVERLAP_MS = 7 * 24 * 60 * 60_000;
export const REQUEST_LIMIT = ARUBA_API_POLICY.requestLimitPerRun;

export const storedCredentialsSchema = z.object({
  apiEnvironment: z.enum(["DEMO", "PRODUCTION"]),
  username: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(500),
  expectedTaxId: z.string().trim().min(1).max(64),
});

export type StoredCredentials = z.infer<typeof storedCredentialsSchema>;
export type RunKind = "BACKFILL" | "INCREMENTAL" | "TARGETED" | "FULL";
export type AuthorityMode = "CANONICAL";

export interface ArubaApiActor {
  id: number;
  canApprove: boolean;
  requestId: string;
}

export interface ArubaApiConnectionRow {
  id: string;
  environment: "DEVELOPMENT" | "PRODUCTION";
  account_reference: string;
  encrypted_credentials: string | null;
  status: "PAUSED" | "CONNECTED" | "REAUTH_REQUIRED" | "REVOKED" | "ERROR";
  api_paused: boolean;
  inbound_enabled: boolean;
  automatic_authority: "API";
  credentials_verified_at: Date | null;
  credentials_rotated_at: Date | null;
  credentials_revoked_at: Date | null;
  last_synced_at: Date | null;
  last_full_sync_at: Date | null;
  last_error_code: string | null;
  account_info_json: unknown;
  account_info_checked_at: Date | null;
}

export interface ArubaSyncRunRow {
  id: string;
  continued_from_run_id: string | null;
  environment: "MOCK" | "PRODUCTION";
  api_environment: ArubaApiEnvironment;
  account_reference: string;
  kind: RunKind;
  authority_mode: AuthorityMode;
  status: "RUNNING" | "COMPLETED" | "FAILED" | "INCOMPLETE" | "CANCELLED";
  window_start: Date;
  window_end: Date;
  checkpoint_start: Date;
  checkpoint_end: Date;
  checkpoint_page: number;
  page_count: number;
  group_count: number;
  document_count: number;
  file_count: number;
  notification_count: number;
  request_count: number;
  request_limit: number;
  started_at: Date;
  completed_at: Date | null;
  lineage_started_at?: Date;
}

export function connectionEnvironment(): ArubaApiConnectionRow["environment"] {
  return getConfig().APP_ENV === "production" ? "PRODUCTION" : "DEVELOPMENT";
}

export function inventoryEnvironment(): ArubaSyncRunRow["environment"] {
  return getConfig().APP_ENV === "production" ? "PRODUCTION" : "MOCK";
}

export function arubaApiInventoryFloor(): Date {
  return new Date(ARUBA_API_POLICY.inventoryStart);
}

export function credentialsKey(): string {
  const value = getConfig().CREDENTIALS_ENCRYPTION_KEY;
  if (!value) throw new AppError("PROVIDER_NOT_CONFIGURED", 503);
  return value;
}

export function requireOwner(actor: ArubaApiActor) {
  if (!actor.canApprove) throw new AppError("ARUBA_OPERATION_FORBIDDEN", 403);
}

export type ArubaInboundJobType = Extract<
  JobType,
  | "aruba_backfill_inventory"
  | "aruba_sync_inventory"
  | "aruba_refresh_nonterminal"
  | "aruba_full_inventory"
>;

export function runKind(type: ArubaInboundJobType): RunKind {
  if (type === "aruba_backfill_inventory") return "BACKFILL";
  if (type === "aruba_refresh_nonterminal") return "TARGETED";
  if (type === "aruba_full_inventory") return "FULL";
  if (type === "aruba_sync_inventory") return "INCREMENTAL";
  throw new AppError("PROVIDER_RESPONSE_INVALID", 422);
}

export function runJobType(type: JobType): type is ArubaInboundJobType {
  return [
    "aruba_backfill_inventory",
    "aruba_sync_inventory",
    "aruba_refresh_nonterminal",
    "aruba_full_inventory",
  ].includes(type);
}

export function parseStoredCredentials(value: string): StoredCredentials {
  try {
    const parsed = storedCredentialsSchema.safeParse(
      decryptCredential<unknown>(value, credentialsKey()),
    );
    if (!parsed.success) throw new Error("invalid");
    return parsed.data;
  } catch {
    throw new AppError("PROVIDER_NOT_CONFIGURED", 503);
  }
}

export function storedApiEnvironment(current: ArubaApiConnectionRow): ArubaApiEnvironment {
  if (current.encrypted_credentials) {
    try {
      return parseStoredCredentials(current.encrypted_credentials).apiEnvironment;
    } catch {
      // Lo stato deve restare consultabile anche con una credenziale non decifrabile.
    }
  }
  return getConfig().APP_ENV === "production" ? "PRODUCTION" : "DEMO";
}

export async function arubaProviderCall<T>(
  environment: ArubaApiEnvironment,
  scope: ArubaApiTrafficScope,
  call: () => Promise<T>,
) {
  try {
    return await call();
  } catch (error) {
    if (error instanceof AppError && error.code === "PROVIDER_RATE_LIMITED") {
      await recordArubaApiRateLimited(environment, scope);
    }
    throw error;
  }
}

export async function connection(client: pg.Pool | pg.PoolClient, lock = false) {
  const result = lock
    ? await client.query<ArubaApiConnectionRow>(
        `SELECT id, environment, account_reference, encrypted_credentials, status,
                api_paused, inbound_enabled, automatic_authority, credentials_verified_at,
                credentials_rotated_at, credentials_revoked_at, last_synced_at,
                last_full_sync_at, last_error_code
                , account_info_json, account_info_checked_at
         FROM connections
         WHERE provider = 'ARUBA' AND environment = $1
         FOR UPDATE`,
        [connectionEnvironment()],
      )
    : await client.query<ArubaApiConnectionRow>(
        `SELECT id, environment, account_reference, encrypted_credentials, status,
                api_paused, inbound_enabled, automatic_authority, credentials_verified_at,
                credentials_rotated_at, credentials_revoked_at, last_synced_at,
                last_full_sync_at, last_error_code
                , account_info_json, account_info_checked_at
         FROM connections
         WHERE provider = 'ARUBA' AND environment = $1`,
        [connectionEnvironment()],
      );
  return result.rows[0] ?? null;
}
