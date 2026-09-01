import { closePool } from "../db/client.server.ts";
import { releaseCandidateReadinessState } from "../db/release-candidate-readiness.server.ts";

try {
  process.stdout.write(`${JSON.stringify(await releaseCandidateReadinessState())}\n`);
} catch {
  process.stderr.write("READINESS_STATE_UNAVAILABLE\n");
  process.exitCode = 1;
} finally {
  await closePool();
}
