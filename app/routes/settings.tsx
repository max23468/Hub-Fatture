import { Form, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/settings";

import { actionResult } from "../action";
import { AppShell } from "../components/app-shell";
import { copy } from "../copy.it";
import { assertCsrf, requestId, requireSessionUser } from "../../src/db/auth.server.ts";
import { readForm } from "../../src/http.server.ts";
import { getDraftTrigger, setDraftTrigger } from "../../src/db/orders.server.ts";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const url = new URL(request.url);
  return {
    username: user.username,
    csrfToken: user.csrfToken,
    trigger: await getDraftTrigger(),
    saved: url.searchParams.get("trigger") === "salvato",
  };
}

export async function action({ request }: Route.ActionArgs) {
  return actionResult(async () => {
    const user = await requireSessionUser(request);
    const form = await readForm(request);
    assertCsrf(user, form.get("csrf") ?? "");
    await setDraftTrigger(form.get("trigger"), Number(form.get("version") ?? Number.NaN), {
      id: user.id,
      requestId: requestId(request),
    });
    return redirect("/impostazioni?trigger=salvato");
  });
}

export default function Settings() {
  const { username, csrfToken, trigger, saved } = useLoaderData<typeof loader>();
  const error = useActionData<typeof action>();
  return (
    <AppShell username={username} csrfToken={csrfToken}>
      <div className="title-block">
        <p className="eyebrow">{copy.settings.eyebrow}</p>
        <h1>{copy.settings.title}</h1>
        <p>{copy.settings.intro}</p>
      </div>
      {saved ? (
        <p className="notice" role="status">
          {copy.settings.saved}
        </p>
      ) : null}
      <section className="card">
        <h2>{copy.settings.preparationTitle}</h2>
        <p>{copy.settings.preparationHelp}</p>
        <Form method="post" className="inline-form">
          <input type="hidden" name="csrf" value={csrfToken} />
          <input type="hidden" name="version" value={trigger.version} />
          <label>
            {copy.settings.preparationLabel}
            <select
              aria-describedby={error ? "trigger-error" : undefined}
              aria-invalid={error ? true : undefined}
              defaultValue={trigger.value}
              name="trigger"
            >
              <option value="PAID">{copy.settings.onPaid}</option>
              <option value="FULFILLED">{copy.settings.onFulfilled}</option>
            </select>
          </label>
          <button className="button" type="submit">
            {copy.settings.save}
          </button>
        </Form>
        {error ? (
          <p className="error" id="trigger-error" role="alert">
            {error.message}
          </p>
        ) : null}
      </section>
      <section className="card section-gap">
        <h2>{copy.settings.timeTitle}</h2>
        <p>{copy.settings.timeHelp}</p>
      </section>
    </AppShell>
  );
}
