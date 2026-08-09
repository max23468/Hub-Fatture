import { Form, redirect, useActionData } from "react-router";
import type { Route } from "./+types/setup";

import { actionResult } from "../action";
import { BrandLockup } from "../components/brand-lockup";
import { copy } from "../copy.it";
import { AGENT_USERNAME, OWNER_USERNAME } from "../../src/auth.ts";
import { requestId, setupAccounts, setupAvailable } from "../../src/db/auth.server.ts";
import { readForm } from "../../src/http.server.ts";

export async function loader() {
  if (!(await setupAvailable())) throw redirect("/login");
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  return actionResult(async () => {
    const form = await readForm(request);
    await setupAccounts({
      bootstrapToken: form.get("bootstrapToken") ?? "",
      ownerPassword: form.get("ownerPassword") ?? "",
      agentPassword: form.get("agentPassword") ?? "",
      requestId: requestId(request),
    });
    return redirect("/login");
  });
}

export default function Setup() {
  const error = useActionData<typeof action>();
  return (
    <main className="auth-shell">
      <BrandLockup />
      <section className="card wide" aria-labelledby="setup-title">
        <p className="eyebrow">{copy.setup.eyebrow}</p>
        <h1 id="setup-title">{copy.setup.title}</h1>
        <Form method="post">
          <label>
            {copy.setup.code}
            <input name="bootstrapToken" type="password" required />
          </label>
          <label>
            {copy.setup.passwordFor(OWNER_USERNAME)}
            <input
              name="ownerPassword"
              type="password"
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
              required
            />
          </label>
          <label>
            {copy.setup.passwordFor(AGENT_USERNAME)}
            <input
              name="agentPassword"
              type="password"
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
              required
            />
          </label>
          {error ? (
            <p className="error" role="alert">
              {error.message}
            </p>
          ) : null}
          <button className="button" type="submit">
            {copy.setup.submit}
          </button>
        </Form>
      </section>
    </main>
  );
}
