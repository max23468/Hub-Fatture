import type { Route } from "./+types/shopify-auth";

import { requireSessionUser } from "../../src/db/auth.server.ts";
import { beginShopifyOAuth } from "../../src/integrations/shopify.server.ts";

export async function loader({ request }: Route.LoaderArgs) {
  await requireSessionUser(request);
  return beginShopifyOAuth(request);
}
