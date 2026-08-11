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
  enqueueEbayPreview,
  failedConnectorJobs,
  latestEbayPreview,
  pendingShopifyDataRequests,
  retryFailedJob,
} from "../../src/db/connectors.server.ts";
import { previewShopifyHistory } from "../../src/integrations/shopify.server.ts";
import { getArubaSettings, setArubaSettings } from "../../src/db/aruba.server.ts";
import { getCustomerEmailSettings, setCustomerEmailMode } from "../../src/db/email.server.ts";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const url = new URL(request.url);
  return {
    username: user.username,
    canApprove: user.canApprove,
    csrfToken: user.csrfToken,
    trigger: await getDraftTrigger(),
    saved: url.searchParams.get("trigger") === "salvato",
    privacyCompleted: url.searchParams.get("privacy") === "chiusa",
    connections: await connectionSummaries(),
    shopifyDataRequests: await pendingShopifyDataRequests(),
    failedJobs: await failedConnectorJobs(),
    ebayPreview: await latestEbayPreview(),
    aruba: await getArubaSettings(),
    arubaSaved: url.searchParams.get("aruba") === "salvata",
    customerEmail: await getCustomerEmailSettings(),
    customerEmailSaved: url.searchParams.get("email") === "salvata",
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
    if (intent === "save-customer-email") {
      await setCustomerEmailMode(form.get("customerEmailMode"), form.get("emailModeVersion"), {
        id: user.id,
        canApprove: user.canApprove,
        requestId: requestId(request),
      });
      return redirect("/impostazioni?email=salvata");
    }
    if (intent === "save-aruba") {
      await setArubaSettings(
        {
          mode: form.get("arubaMode"),
          modeVersion: form.get("arubaModeVersion"),
          authProtection: form.get("arubaAuthProtection"),
          authVersion: form.get("arubaAuthVersion"),
        },
        { id: user.id, canApprove: user.canApprove, requestId: requestId(request) },
      );
      return redirect("/impostazioni?aruba=salvata");
    }
    if (intent === "complete-shopify-data-request") {
      await completeShopifyDataRequest(form.get("eventId"), {
        id: user.id,
        requestId: requestId(request),
      });
      return redirect("/impostazioni?privacy=chiusa");
    }
    if (intent === "retry-connector-job") {
      await retryFailedJob(form.get("jobId"), {
        type: "ADMIN",
        id: user.id,
        requestId: requestId(request),
      });
      return redirect("/impostazioni?job=riavviato");
    }
    if (intent === "preview-ebay") {
      await enqueueEbayPreview();
      return redirect("/impostazioni?ebayPreview=avviata");
    }
    if (intent === "preview-shopify") {
      const provider = "Shopify";
      const preview = await previewShopifyHistory();
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
    canApprove,
    csrfToken,
    trigger,
    saved,
    privacyCompleted,
    connections,
    shopifyDataRequests,
    failedJobs,
    ebayPreview,
    preview,
    aruba,
    arubaSaved,
    customerEmail,
    customerEmailSaved,
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
      {arubaSaved ? (
        <p className="notice" role="status">
          {copy.settings.arubaSaved}
        </p>
      ) : null}
      {customerEmailSaved ? (
        <p className="notice" role="status">
          {copy.settings.customerEmailSaved}
        </p>
      ) : null}
      {ebayPreview ? (
        <p className="notice" role="status">
          {copy.settings.ebayPreviewStatus(
            ebayPreview.status,
            ebayPreview.count,
            ebayPreview.reviewRequired,
            ebayPreview.errorCode,
          )}
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
                {connection?.lastErrorCode ? (
                  <p className="error">{copy.settings.connectionError(connection.lastErrorCode)}</p>
                ) : null}
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
        {failedJobs.length ? (
          <div className="notice section-gap" role="status">
            <h3>{copy.settings.failedJobsTitle}</h3>
            <ul>
              {failedJobs.map((job) => (
                <li key={job.id}>
                  <p>{copy.settings.failedJob(job.type, job.errorCode, job.attempts)}</p>
                  <Form method="post">
                    <input type="hidden" name="csrf" value={csrfToken} />
                    <input type="hidden" name="intent" value="retry-connector-job" />
                    <input type="hidden" name="jobId" value={job.id} />
                    <button className="button button--secondary" type="submit">
                      {copy.settings.retryJob}
                    </button>
                  </Form>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {error ? (
          <p className="error" role="alert">
            {error.message}
          </p>
        ) : null}
      </section>
      <section className="card section-gap">
        <h2>{copy.settings.customerEmailTitle}</h2>
        <p>{copy.settings.customerEmailHelp}</p>
        <dl className="facts facts--columns">
          <div>
            <dt>{copy.settings.smtpTransport}</dt>
            <dd>
              {copy.settings.smtpTransportLabels[customerEmail.transport] ??
                copy.common.unavailable}
            </dd>
          </div>
          <div>
            <dt>{copy.settings.smtpSender}</dt>
            <dd>{customerEmail.sender}</dd>
          </div>
          <div>
            <dt>{copy.settings.smtpStatus}</dt>
            <dd>
              {customerEmail.configured
                ? copy.settings.smtpConfigured
                : copy.settings.smtpNotConfigured}
            </dd>
          </div>
        </dl>
        {canApprove ? (
          <Form method="post" className="inline-form section-gap">
            <input type="hidden" name="csrf" value={csrfToken} />
            <input type="hidden" name="intent" value="save-customer-email" />
            <input type="hidden" name="emailModeVersion" value={customerEmail.version} />
            <label>
              {copy.settings.customerEmailMode}
              <select defaultValue={customerEmail.mode} name="customerEmailMode">
                <option value="AUTOMATIC">{copy.settings.customerEmailAutomatic}</option>
                <option value="MANUAL">{copy.settings.customerEmailManual}</option>
              </select>
            </label>
            <button className="button" type="submit">
              {copy.settings.customerEmailSave}
            </button>
          </Form>
        ) : (
          <p>{copy.settings.customerEmailOwnerOnly}</p>
        )}
      </section>
      <section className="card section-gap">
        <h2>{copy.settings.arubaTitle}</h2>
        <p>{copy.settings.arubaHelp}</p>
        {aruba.automaticForcedAssisted ? (
          <p className="notice">{copy.settings.arubaKillSwitch}</p>
        ) : null}
        {canApprove ? (
          <Form method="post" className="inline-form">
            <input type="hidden" name="csrf" value={csrfToken} />
            <input type="hidden" name="intent" value="save-aruba" />
            <input type="hidden" name="arubaModeVersion" value={aruba.mode.version} />
            <input type="hidden" name="arubaAuthVersion" value={aruba.authProtection.version} />
            <label>
              {copy.settings.arubaMode}
              <select defaultValue={aruba.mode.value} name="arubaMode">
                <option value="ASSISTED">{copy.settings.arubaAssisted}</option>
                <option value="AUTOMATIC">{copy.settings.arubaAutomatic}</option>
              </select>
            </label>
            <label>
              {copy.settings.arubaAuthProtection}
              <select defaultValue={aruba.authProtection.value} name="arubaAuthProtection">
                <option value="UNKNOWN">{copy.settings.arubaAuthUnknown}</option>
                <option value="TWO_FACTOR">{copy.settings.arubaTwoFactor}</option>
                <option value="SMS_PER_UPLOAD">{copy.settings.arubaSms}</option>
              </select>
            </label>
            <button className="button" type="submit">
              {copy.settings.arubaSave}
            </button>
          </Form>
        ) : (
          <p>{copy.settings.arubaOwnerOnly}</p>
        )}
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
