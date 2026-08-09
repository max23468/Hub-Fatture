import { redirect } from "react-router";
import type { Route } from "./+types/shopify-callback";

import { requestId, requireSessionUser } from "../../src/db/auth.server.ts";
import { completeShopifyOAuth } from "../../src/integrations/shopify.server.ts";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const headers = await completeShopifyOAuth(request, {
    type: "ADMIN",
    id: user.id,
    requestId: requestId(request),
  });
  return redirect("/impostazioni?shopify=collegato", { headers });
}
