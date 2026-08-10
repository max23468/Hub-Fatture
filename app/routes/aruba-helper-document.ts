import { data } from "react-router";
import type { Route } from "./+types/aruba-helper-document";

import { helperBearer, helperDocumentXml } from "../../src/db/aruba.server.ts";
import { publicError } from "../../src/errors.ts";

export async function loader({ request, params }: Route.LoaderArgs) {
  try {
    const xml = await helperDocumentXml(helperBearer(request), params.documentId);
    return new Response(new Uint8Array(xml), {
      headers: {
        "Cache-Control": "no-store, private",
        "Content-Type": "application/xml; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const result = publicError(error);
    return data(result, { status: result.status });
  }
}
