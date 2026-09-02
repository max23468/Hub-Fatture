import { LogIn } from "lucide-react";
import { Form, redirect, useActionData } from "react-router";
import type { Route } from "./+types/login";

import { actionResult } from "../action";
import { PublicCardHeader, PublicPage } from "../components/public-page";
import { copy } from "../copy.it";
import { privateRouteMeta } from "../metadata";
import { clientIpHash, getSessionUser, login, requestId } from "../../src/db/auth.server.ts";
import { readForm } from "../../src/http.server.ts";

export function meta({ error }: Route.MetaArgs) {
  return privateRouteMeta("login", { error });
}

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
    <PublicPage compact>
      <section className="card public-card" aria-labelledby="login-title">
        <PublicCardHeader
          description={copy.login.intro}
          eyebrow={copy.login.eyebrow}
          icon={<LogIn size={22} strokeWidth={1.8} />}
          title={copy.login.title}
          titleId="login-title"
        />
        <Form className="public-form" method="post" reloadDocument>
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
          <button className="button button--full" type="submit">
            {copy.login.submit}
          </button>
        </Form>
      </section>
    </PublicPage>
  );
}
