import { arubaCanaryReadinessState } from "../db/aruba-canary-readiness.server.ts";
import { closePool } from "../db/client.server.ts";

try {
  process.stdout.write(`${JSON.stringify(await arubaCanaryReadinessState())}\n`);
} catch {
  process.stderr.write("ARUBA_CANARY_STATE_UNAVAILABLE\n");
  process.exitCode = 1;
} finally {
  await closePool();
}
