import { spawnSync } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export const retryDelaysMs = [0, 30_000, 90_000, 180_000];

export function isCompletedAudit(stdout) {
  try {
    const report = JSON.parse(stdout);
    return Boolean(report?.metadata?.vulnerabilities);
  } catch {
    return false;
  }
}

async function main() {
  for (const [index, delay] of retryDelaysMs.entries()) {
    if (delay > 0) await wait(delay);
    const result = spawnSync(
      "npm",
      ["audit", "--audit-level=high", "--json", "--fetch-retries=0", "--fetch-timeout=30000"],
      { encoding: "utf8" },
    );
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    if (result.status === 0) return;
    if (isCompletedAudit(result.stdout ?? "")) {
      process.exitCode = result.status ?? 1;
      return;
    }
    if (index < retryDelaysMs.length - 1) {
      process.stderr.write(
        `Audit provider non disponibile; nuovo tentativo tra ${retryDelaysMs[index + 1] / 1000}s.\n`,
      );
    }
  }
  throw new Error("Audit dipendenze non raggiungibile dopo quattro tentativi");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
