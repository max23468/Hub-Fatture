import { Form, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/settings";

import { actionResult } from "../action";
import { AppShell } from "../components/app-shell";
import { copy } from "../copy.it";
import { dateTime } from "../format";
import { assertCsrf, requestId, requireSessionUser } from "../../src/db/auth.server.ts";
import { readForm } from "../../src/http.server.ts";
import { getDraftTrigger, setDraftTrigger } from "../../src/db/orders.server.ts";
import {
  completeShopifyDataRequest,
  connectionSummaries,
  pendingShopifyDataRequests,
} from "../../src/db/connectors.server.ts";
import { previewEbayHistory } from "../../src/integrations/ebay.server.ts";
import { previewShopifyHistory } from "../../src/integrations/shopify.server.ts";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const url = new URL(request.url);
  return {
    username: user.username,
    csrfToken: user.csrfToken,
    trigger: await getDraftTrigger(),
    saved: url.searchParams.get("trigger") === "salvato",
    privacyCompleted: url.searchParams.get("privacy") === "chiusa",
    connections: await connectionSummaries(),
    shopifyDataRequests: await pendingShopifyDataRequests(),
    preview:
      url.searchParams.get("provider") && url.searchParams.get("count")
        ? {
            provider: url.searchParams.get("provider")!,
            count: url.searchParams.get("count")!,
            review: url.searchParams.get("review") ?? "0",
          }
        : null,
  };
}

export async function action({ request }: Route.ActionArgs) {
  return actionResult(async () => {
    const user = await requireSessionUser(request);
    const form = await readForm(request);
    assertCsrf(user, form.get("csrf") ?? "");
    const intent = form.get("intent");
    if (intent === "complete-shopify-data-request") {
      await completeShopifyDataRequest(form.get("eventId"), {
        id: user.id,
        requestId: requestId(request),
      });
      return redirect("/impostazioni?privacy=chiusa");
    }
    if (intent === "preview-shopify" || intent === "preview-ebay") {
      const provider = intent === "preview-shopify" ? "Shopify" : "eBay";
      const preview =
        intent === "preview-shopify" ? await previewShopifyHistory() : await previewEbayHistory();
      return redirect(
        `/impostazioni?${new URLSearchParams({
          provider,
          count: String(preview.count),
          review: String(preview.reviewRequired),
        })}`,
      );
    }
    await setDraftTrigger(form.get("trigger"), Number(form.get("version") ?? Number.NaN), {
      id: user.id,
      requestId: requestId(request),
    });
    return redirect("/impostazioni?trigger=salvato");
  });
}

export default function Settings() {
  const {
    username,
    csrfToken,
    trigger,
    saved,
    privacyCompleted,
    connections,
    shopifyDataRequests,
    preview,
  } = useLoaderData<typeof loader>();
  const error = useActionData<typeof action>();
  const byProvider = new Map(connections.map((connection) => [connection.provider, connection]));
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
      {privacyCompleted ? (
        <p className="notice" role="status">
          {copy.settings.dataRequestCompleted}
        </p>
      ) : null}
      {preview ? (
        <p className="notice" role="status">
          {copy.settings.previewResult(preview.provider, preview.count, preview.review)}
        </p>
      ) : null}
      <section className="card">
        <h2>{copy.settings.connectionsTitle}</h2>
        <p>{copy.settings.connectionsHelp}</p>
        {shopifyDataRequests.length ? (
          <div className="notice" role="status">
            <h3>{copy.settings.dataRequestsTitle}</h3>
            <p>{copy.settings.dataRequestsPending(shopifyDataRequests.length)}</p>
            <ul>
              {shopifyDataRequests.map((dataRequest) => (
                <li key={dataRequest.externalEventId}>
                  <p>
                    {copy.settings.dataRequestReceived}:{" "}
                    <time dateTime={dataRequest.receivedAt}>
                      {dateTime(dataRequest.receivedAt)}
                    </time>
                  </p>
                  <p>
                    {copy.settings.dataRequestCustomers}: {dataRequest.customerIds.join(", ")}
                  </p>
                  <p>
                    {copy.settings.dataRequestOrders}: {dataRequest.orderIds.join(", ")}
                  </p>
                  <Form method="post">
                    <input type="hidden" name="csrf" value={csrfToken} />
                    <input type="hidden" name="intent" value="complete-shopify-data-request" />
                    <input type="hidden" name="eventId" value={dataRequest.externalEventId} />
                    <button className="button button--secondary" type="submit">
                      {copy.settings.dataRequestComplete}
                    </button>
                  </Form>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="detail-grid">
          {(["SHOPIFY", "EBAY"] as const).map((provider) => {
            const connection = byProvider.get(provider);
            const label = provider === "SHOPIFY" ? "Shopify" : "eBay";
            return (
              <section key={provider} className="status-panel">
                <h3>{label}</h3>
                <p className="status">
                  {connection?.status === "CONNECTED"
                    ? copy.settings.connected
                    : copy.settings.notConnected}
                </p>
                {connection ? <p>{connection.accountReference}</p> : null}
                <p>
                  {copy.settings.lastSync}: {connection?.lastSyncedAt ?? copy.settings.never}
                </p>
                <p>
                  <a
                    className="button button--secondary"
                    href={
                      provider === "SHOPIFY"
                        ? "/integrations/shopify/auth"
                        : "/integrations/ebay/auth"
                    }
                  >
                    {connection ? copy.settings.reconnect : copy.settings.connect}
                  </a>
                </p>
                {connection?.status === "CONNECTED" ? (
                  <Form method="post">
                    <input type="hidden" name="csrf" value={csrfToken} />
                    <input
                      type="hidden"
                      name="intent"
                      value={provider === "SHOPIFY" ? "preview-shopify" : "preview-ebay"}
                    />
                    <button className="button button--secondary" type="submit">
                      {copy.settings.preview}
                    </button>
                  </Form>
                ) : null}
              </section>
            );
          })}
        </div>
        {error ? (
          <p className="error" role="alert">
            {error.message}
          </p>
        ) : null}
      </section>
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
