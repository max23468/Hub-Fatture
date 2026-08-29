import {
  getArubaApiConnectionStatus,
  rebuildLatestArubaInboundParityDossier,
} from "../db/aruba-api-inbound.server.ts";
import { closePool } from "../db/client.server.ts";

try {
  const closure = await rebuildLatestArubaInboundParityDossier();
  const connection = await getArubaApiConnectionStatus();
  process.stdout.write(
    `${JSON.stringify({ status: "COMPLETED", parity: connection.parity, gates: closure.gates }, null, 2)}\n`,
  );
} catch {
  process.stderr.write(
    `${JSON.stringify({ status: "FAILED", code: "ARUBA_PARITY_REBUILD_FAILED" })}\n`,
  );
  process.exitCode = 1;
} finally {
  await closePool();
}
