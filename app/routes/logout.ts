import { data, redirect } from "react-router";
import type { Route } from "./+types/logout";

import { clearSessionCookies, logout } from "../../src/auth.server.ts";
import { publicError } from "../../src/errors.ts";
import { readForm } from "../../src/http.server.ts";

export async function action({ request }: Route.ActionArgs) {
  try {
    const form = await readForm(request);
    await logout(request, form.get("csrf") ?? "");
  } catch (error) {
    const result = publicError(error);
    return data(result, { status: result.status });
  }
  const headers = new Headers();
  for (const value of clearSessionCookies()) headers.append("Set-Cookie", value);
  return redirect("/login", { headers });
}
