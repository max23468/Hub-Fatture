import type { Route } from "./+types/ebay-account-deletion";

import { publicError } from "../../src/errors.ts";
import { readRawBody } from "../../src/http.server.ts";
import { processEbayAccountDeletion } from "../../src/integrations/ebay.server.ts";

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  try {
    await processEbayAccountDeletion(
      await readRawBody(request),
      request.headers.get("x-ebay-signature"),
    );
    return new Response(null, { status: 204 });
  } catch (error) {
    const response = publicError(error);
    return Response.json({ code: response.code }, { status: response.status });
  }
}
