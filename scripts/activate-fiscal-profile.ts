import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { fiscalProfileFromAcceptedInvoiceXml } from "../src/documents.ts";
import { validateFatturaXml } from "../src/fatturapa.server.ts";
import { activateFiscalProfile } from "../src/db/documents.server.ts";
import { closePool, getPool } from "../src/db/client.server.ts";

const sourcePath = process.argv[2];
if (!sourcePath) throw new Error("Indica il percorso dell’XML TD01 accettato");
if ((await stat(sourcePath)).size > 4_900_000) throw new Error("XML oltre il limite consentito");

const xml = await readFile(sourcePath, "utf8");
await validateFatturaXml(xml);
const latestDocumentPath = process.argv[3];
if (latestDocumentPath && (await stat(latestDocumentPath)).size > 4_900_000) {
  throw new Error("XML del progressivo oltre il limite consentito");
}
const latestDocumentXml = latestDocumentPath ? await readFile(latestDocumentPath, "utf8") : xml;
if (latestDocumentPath) await validateFatturaXml(latestDocumentXml);
const profile = fiscalProfileFromAcceptedInvoiceXml(
  xml,
  new Date().toISOString(),
  latestDocumentXml,
);

try {
  const owner = (
    await getPool().query<{ id: number; can_approve: boolean }>(
      "SELECT id, can_approve FROM users WHERE username = 'Massimo'",
    )
  ).rows[0];
  if (!owner?.can_approve) throw new Error("L’account del titolare non è configurato");
  const version = await activateFiscalProfile(
    profile,
    createHash("sha256").update(xml).digest("hex"),
    {
      id: owner.id,
      canApprove: owner.can_approve,
      requestId: randomUUID(),
    },
  );
  process.stdout.write(`Profilo fiscale attivato: versione ${version}.\n`);
} finally {
  await closePool();
}
