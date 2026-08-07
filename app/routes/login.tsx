import { data, Form, redirect, useActionData } from "react-router";
import type { Route } from "./+types/login";

import { BrandLockup } from "../components/brand-lockup";
import { copy } from "../copy.it";
import { getSessionUser, login, requestId } from "../../src/auth.server.ts";
import { publicError } from "../../src/errors.ts";
import { readForm } from "../../src/http.server.ts";

export async function loader({ request }: Route.LoaderArgs) {
  if (await getSessionUser(request)) throw redirect("/");
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  try {
    const form = await readForm(request);
    const sessionCookies = await login({
      username: form.get("username") ?? "",
      password: form.get("password") ?? "",
      requestId: requestId(request),
    });
    const headers = new Headers();
    for (const value of sessionCookies) headers.append("Set-Cookie", value);
    return redirect("/", { headers });
  } catch (error) {
    const result = publicError(error);
    return data(result, { status: result.status });
  }
}

export default function Login() {
  const error = useActionData<typeof action>();
  return (
    <main className="auth-shell">
      <BrandLockup />
      <section className="card" aria-labelledby="login-title">
        <p className="eyebrow">Accesso amministratore</p>
        <h1 id="login-title">{copy.loginTitle}</h1>
        <Form method="post">
          <label>
            Username
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
            Password
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          {error ? (
            <p className="error" role="alert">
              {error.message}
            </p>
          ) : null}
          <button className="button" type="submit">
            Accedi
          </button>
        </Form>
      </section>
    </main>
  );
}
