import { redirect } from "react-router";
import type { Route } from "./+types/ebay-auth";

import { requireSessionUser } from "../../src/db/auth.server.ts";
import { createEbayOAuthState, ebayAuthorizationUrl } from "../../src/integrations/ebay.server.ts";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  return redirect(ebayAuthorizationUrl(createEbayOAuthState(user.id)));
}
