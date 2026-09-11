import { closePool } from "../db/client.server.ts";
import {
  planRedundantArubaPdfCopies,
  pruneRedundantArubaPdfCopies,
} from "../db/aruba-pdf-copies.server.ts";

const args = process.argv.slice(2);
const apply = args.length === 1 && args[0] === "--apply";

try {
  if (args.length > 0 && !apply) throw new Error("ARUBA_PDF_COPIES_USAGE");
  const result = apply
    ? await pruneRedundantArubaPdfCopies()
    : { ...(await planRedundantArubaPdfCopies()), dryRun: true };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if ("unlinkFailures" in result && result.unlinkFailures > 0) process.exitCode = 1;
} catch {
  process.stderr.write(
    "Pulizia dei PDF Aruba non riuscita. Senza argomenti esegue la simulazione; --apply elimina.\n",
  );
  process.exitCode = 1;
} finally {
  await closePool();
}
