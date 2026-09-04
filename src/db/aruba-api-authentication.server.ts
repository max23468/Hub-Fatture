import { ARUBA_API_POLICY } from "../aruba-api-policy.ts";
import { AppError } from "../errors.ts";
import type { ArubaApiEnvironment } from "../integrations/aruba-api.server.ts";
import { assertArubaApiCooldownInactive } from "./aruba-api-traffic.server.ts";
import { withTransaction } from "./client.server.ts";

export async function reserveArubaApiAuthentication(environment: ArubaApiEnvironment) {
  await assertArubaApiCooldownInactive(environment, undefined, "AUTH");
  await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('aruba-api-authentication'))");
    await assertArubaApiCooldownInactive(environment, client, "AUTH");
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
