import { redirect } from "react-router";
import type { Route } from "./+types/shopify-callback";

import { requireSessionUser } from "../../src/db/auth.server.ts";
import { completeShopifyOAuth } from "../../src/integrations/shopify.server.ts";

export async function loader({ request }: Route.LoaderArgs) {
  await requireSessionUser(request);
  const headers = await completeShopifyOAuth(request);
  return redirect("/impostazioni?shopify=collegato", { headers });
}
