import { getArubaInboundClosureReport } from "../db/aruba-api-closure-report.server.ts";
import { closePool } from "../db/client.server.ts";

try {
  process.stdout.write(`${JSON.stringify(await getArubaInboundClosureReport(), null, 2)}\n`);
} catch {
  process.stderr.write(
    `${JSON.stringify({ status: "FAILED", code: "ARUBA_CLOSURE_REPORT_FAILED" })}\n`,
  );
  process.exitCode = 1;
} finally {
  await closePool();
}
