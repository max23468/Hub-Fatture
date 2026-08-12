import { KeyRound, ShieldCheck, UserRound } from "lucide-react";
import { Form, redirect, useActionData } from "react-router";
import type { Route } from "./+types/setup";

import { actionResult } from "../action";
import { PublicCardHeader, PublicPage } from "../components/public-page";
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
    <PublicPage>
      <section className="card public-card public-card--wide" aria-labelledby="setup-title">
        <PublicCardHeader
          description={copy.setup.intro}
          eyebrow={copy.setup.eyebrow}
          icon={<KeyRound size={22} strokeWidth={1.8} />}
          title={copy.setup.title}
          titleId="setup-title"
        />
        <Form className="public-form" method="post">
          <div className="setup-code">
            <label>
              {copy.setup.code}
              <input name="bootstrapToken" type="password" required />
            </label>
            <p className="field-help">{copy.setup.codeHelp}</p>
          </div>
          <div className="setup-accounts">
            <section className="setup-account" aria-labelledby="setup-owner-title">
              <span className="setup-account__icon" aria-hidden="true">
                <ShieldCheck size={20} strokeWidth={1.8} />
              </span>
              <div>
                <h2 id="setup-owner-title">{copy.setup.ownerTitle}</h2>
                <p>{copy.setup.ownerHelp}</p>
              </div>
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
            </section>
            <section className="setup-account" aria-labelledby="setup-operator-title">
              <span className="setup-account__icon" aria-hidden="true">
                <UserRound size={20} strokeWidth={1.8} />
              </span>
              <div>
                <h2 id="setup-operator-title">{copy.setup.operatorTitle}</h2>
                <p>{copy.setup.operatorHelp}</p>
              </div>
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
            </section>
          </div>
          {error ? (
            <p className="error" role="alert">
              {error.message}
            </p>
          ) : null}
          <button className="button button--full" type="submit">
            {copy.setup.submit}
          </button>
        </Form>
      </section>
    </PublicPage>
  );
}
