import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Route } from "./+types/aruba-synthetic-file";

import { getConfig } from "../../src/config.server.ts";

export async function loader({ params }: Route.LoaderArgs) {
  if (getConfig().APP_ENV === "production") throw new Response("Non disponibile", { status: 404 });
  const filename =
    params.kind === "invoice"
      ? "accepted-invoice.anonymized.xml"
      : params.kind === "credit-note"
        ? "accepted-credit-note.anonymized.xml"
        : null;
  if (!filename) throw new Response("Non disponibile", { status: 404 });
  return new Response(await readFile(path.resolve("tests/fixtures/fatturapa", filename)), {
    headers: { "Content-Type": "application/xml", "Cache-Control": "no-store" },
  });
}
