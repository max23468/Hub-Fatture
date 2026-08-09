import { Form, redirect, useActionData } from "react-router";
import type { Route } from "./+types/login";

import { actionResult } from "../action";
import { BrandLockup } from "../components/brand-lockup";
import { copy } from "../copy.it";
import { clientIpHash, getSessionUser, login, requestId } from "../../src/db/auth.server.ts";
import { readForm } from "../../src/http.server.ts";

export async function loader({ request }: Route.LoaderArgs) {
  if (await getSessionUser(request)) throw redirect("/");
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  return actionResult(async () => {
    const form = await readForm(request);
    const sessionCookies = await login({
      username: form.get("username") ?? "",
      password: form.get("password") ?? "",
      ipHash: clientIpHash(request),
      requestId: requestId(request),
    });
    const headers = new Headers();
    for (const value of sessionCookies) headers.append("Set-Cookie", value);
    return redirect("/", { headers });
  });
}

export default function Login() {
  const error = useActionData<typeof action>();
  return (
    <main className="auth-shell">
      <BrandLockup />
      <section className="card" aria-labelledby="login-title">
        <p className="eyebrow">{copy.login.eyebrow}</p>
        <h1 id="login-title">{copy.login.title}</h1>
        <Form method="post">
          <label>
            {copy.login.username}
            <input
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              maxLength={64}
              spellCheck={false}
              required
            />
          </label>
          <label>
            {copy.login.password}
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          {error ? (
            <p className="error" role="alert">
              {error.message}
            </p>
          ) : null}
          <button className="button" type="submit">
            {copy.login.submit}
          </button>
        </Form>
      </section>
    </main>
  );
}
