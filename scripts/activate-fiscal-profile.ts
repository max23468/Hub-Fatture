import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { closePool, getPool } from "../src/db/client.server.ts";
import { getFiscalProfileSettings } from "../src/db/documents.server.ts";
import {
  activateFiscalProfileFromAcceptedXml,
  FISCAL_PROFILE_XML_MAX_BYTES,
} from "../src/operations/fiscal-profile-activation.ts";

const sourcePath = process.argv[2];
if (!sourcePath) throw new Error("Indica il percorso dell’XML TD01 accettato");
const latestDocumentPath = process.argv[3];

async function readXml(path: string) {
  const details = await stat(path);
  if (!details.isFile() || details.size === 0 || details.size > FISCAL_PROFILE_XML_MAX_BYTES) {
    throw new Error(`L’XML ${path} è vuoto, non è un file regolare o supera 4,9 MB`);
  }
  return readFile(path);
}

const [profileXml, latestDocumentXml] = await Promise.all([
  readXml(sourcePath),
  latestDocumentPath ? readXml(latestDocumentPath) : undefined,
]);

try {
  const owner = (
    await getPool().query<{ id: number; can_approve: boolean }>(
      "SELECT id, can_approve FROM users WHERE username = 'Massimo'",
    )
  ).rows[0];
  if (!owner?.can_approve) throw new Error("L’account del titolare non è configurato");
  const currentProfile = await getFiscalProfileSettings();
  const activation = await activateFiscalProfileFromAcceptedXml(
    { profileXml, latestDocumentXml, expectedVersion: currentProfile?.version ?? 0 },
    {
      id: owner.id,
      canApprove: owner.can_approve,
      requestId: randomUUID(),
    },
  );
  process.stdout.write(
    activation.created
      ? `Profilo fiscale attivato: versione ${activation.version}.\n`
      : `Profilo fiscale già attivo: versione ${activation.version}.\n`,
  );
} finally {
  await closePool();
}
