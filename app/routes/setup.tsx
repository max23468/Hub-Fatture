import { data, Form, redirect, useActionData } from "react-router";
import type { Route } from "./+types/setup";

import { BrandLockup } from "../components/brand-lockup";
import { copy } from "../copy.it";
import { AGENT_USERNAME, OWNER_USERNAME } from "../../src/auth.ts";
import { requestId, setupAccounts, setupAvailable } from "../../src/auth.server.ts";
import { publicError } from "../../src/errors.ts";
import { readForm } from "../../src/http.server.ts";

export async function loader() {
  if (!(await setupAvailable())) throw redirect("/login");
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  try {
    const form = await readForm(request);
    await setupAccounts({
      bootstrapToken: form.get("bootstrapToken") ?? "",
      ownerPassword: form.get("ownerPassword") ?? "",
      agentPassword: form.get("agentPassword") ?? "",
      requestId: requestId(request),
    });
    return redirect("/login");
  } catch (error) {
    const result = publicError(error);
    return data(result, { status: result.status });
  }
}

export default function Setup() {
  const error = useActionData<typeof action>();
  return (
    <main className="auth-shell">
      <BrandLockup />
      <section className="card wide" aria-labelledby="setup-title">
        <p className="eyebrow">Prima configurazione</p>
        <h1 id="setup-title">{copy.setupTitle}</h1>
        <Form method="post">
          <label>
            Token di configurazione
            <input name="bootstrapToken" type="password" required />
          </label>
          <label>
            Password per {OWNER_USERNAME} (minimo 8 caratteri)
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
            Password per {AGENT_USERNAME} (minimo 8 caratteri)
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
            Crea gli account
          </button>
        </Form>
      </section>
    </main>
  );
}
