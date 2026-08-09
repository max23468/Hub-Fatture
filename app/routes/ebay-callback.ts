import { redirect } from "react-router";
import type { Route } from "./+types/ebay-callback";

import { requestId, requireSessionUser } from "../../src/db/auth.server.ts";
import { completeEbayOAuth, verifyEbayOAuthState } from "../../src/integrations/ebay.server.ts";
import { AppError } from "../../src/errors.ts";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  if (!code || !verifyEbayOAuthState(state, user.id)) {
    throw new AppError("AUTH_PROVIDER_EXPIRED", 401);
  }
  await completeEbayOAuth(code, {
    type: "ADMIN",
    id: user.id,
    requestId: requestId(request),
  });
  return redirect("/impostazioni?ebay=collegato");
}
