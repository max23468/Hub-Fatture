import type { Route } from "./+types/shopify-webhook";

import { publicError } from "../../src/errors.ts";
import { readRawBody } from "../../src/http.server.ts";
import { processShopifyWebhook } from "../../src/integrations/shopify.server.ts";

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  try {
    await processShopifyWebhook(request, await readRawBody(request));
    return new Response(null, { status: 204 });
  } catch (error) {
    const response = publicError(error);
    return Response.json({ code: response.code }, { status: response.status });
  }
}
