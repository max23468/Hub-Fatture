import { redirect } from "react-router";
import type { Route } from "./+types/logout";

import { actionResult } from "../action";
import { clearSessionCookies, logout } from "../../src/auth.server.ts";
import { readForm } from "../../src/http.server.ts";

export async function action({ request }: Route.ActionArgs) {
  return actionResult(async () => {
    const form = await readForm(request);
    await logout(request, form.get("csrf") ?? "");
    const headers = new Headers();
    for (const value of clearSessionCookies()) headers.append("Set-Cookie", value);
    return redirect("/login", { headers });
  });
}
