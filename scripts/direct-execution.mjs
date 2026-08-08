import { realpathSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

// `import.meta.url` è già risolto e percent-encoded, `process.argv[1]` no: confrontarli
// direttamente rende il guard falso-negativo su percorsi con spazi, accenti o symlink,
// e lo script esce 0 senza aver verificato nulla.
export function isDirectExecution(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === moduleUrl;
  } catch {
    return false;
  }
}
