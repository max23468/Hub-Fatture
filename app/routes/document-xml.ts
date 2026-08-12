import type { Route } from "./+types/document-xml";

import { requireSessionUser } from "../../src/db/auth.server.ts";
import { readDocumentXml } from "../../src/db/document-storage.server.ts";

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireSessionUser(request);
  const xml = await readDocumentXml(params.documentId);
  if (!xml) throw new Response("Documento non trovato", { status: 404 });
  return new Response(new Uint8Array(xml), {
    headers: {
      "Cache-Control": "no-store, private",
      "Content-Disposition": `attachment; filename="fattura-${params.documentId}.xml"`,
      "Content-Type": "application/xml; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
