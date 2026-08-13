import { data, redirect } from "react-router";
import type { Route } from "./+types/settings";

import { getConfig } from "../../src/config.server.ts";
import {
  assertCsrf,
  changePassword,
  getAccountProfile,
  requestId,
  requireSessionUser,
  revokeOtherSessions,
} from "../../src/db/auth.server.ts";
import { getArubaSettings, setArubaSettings } from "../../src/db/aruba.server.ts";
import {
  connectionSummaries,
  enqueueEbayHistory,
  latestEbayHistory,
} from "../../src/db/connectors.server.ts";
import { getFiscalProfileSettings } from "../../src/db/documents.server.ts";
import { getCustomerEmailSettings, setCustomerEmailMode } from "../../src/db/email.server.ts";
import {
  getDraftTrigger,
  getShopifyPaymentFeeMode,
  setDraftTrigger,
  setShopifyPaymentFeeMode,
} from "../../src/db/orders.server.ts";
import { getSystemStatus } from "../../src/db/system.server.ts";
import { AppError, publicError } from "../../src/errors.ts";
import { readForm } from "../../src/http.server.ts";
import {
  importShopifyHistory,
  previewShopifyHistory,
} from "../../src/integrations/shopify.server.ts";
import { historicalOrderWindow, localOrderDate } from "../../src/orders.ts";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const url = new URL(request.url);
  const requestedHistoryProvider = url.searchParams.get("historyProvider");
  const [
    profile,
    trigger,
    shopifyPaymentFeeMode,
    connections,
    ebayHistory,
    aruba,
    customerEmail,
    fiscalProfile,
    system,
  ] = await Promise.all([
    getAccountProfile(request, user),
    getDraftTrigger(),
    getShopifyPaymentFeeMode(),
    connectionSummaries(),
    latestEbayHistory(),
    getArubaSettings(),
    getCustomerEmailSettings(),
    getFiscalProfileSettings(),
    getSystemStatus(),
  ]);
  return {
    username: user.username,
    canApprove: user.canApprove,
    csrfToken: user.csrfToken,
    profile,
    trigger,
    shopifyPaymentFeeMode,
    saved: url.searchParams.get("trigger") === "salvato",
    shopifyPaymentFeeModeSaved: url.searchParams.get("commissioni") === "salvata",
    connections,
    ebayHistory,
    aruba,
    arubaSaved: url.searchParams.get("aruba") === "salvata",
    customerEmail,
    customerEmailSaved: url.searchParams.get("email") === "salvata",
    fiscalProfile,
    environment: getConfig().APP_ENV,
    system,
    passwordChanged: url.searchParams.get("profilo") === "password",
    sessionsRevoked: url.searchParams.get("profilo") === "sessioni",
    preview:
      url.searchParams.get("provider") && url.searchParams.get("count")
        ? {
            provider: url.searchParams.get("provider")!,
            count: url.searchParams.get("count")!,
            review: url.searchParams.get("review") ?? "0",
          }
        : null,
    imported:
      url.searchParams.get("provider") && url.searchParams.has("imported")
        ? {
            provider: url.searchParams.get("provider")!,
            imported: url.searchParams.get("imported") ?? "0",
            updated: url.searchParams.get("updated") ?? "0",
            ignored: url.searchParams.get("ignored") ?? "0",
          }
        : null,
    historyStart: historicalOrderWindow(url.searchParams.get("historyStart"))?.startDate ?? null,
    historyProvider:
      requestedHistoryProvider === "SHOPIFY" || requestedHistoryProvider === "EBAY"
        ? requestedHistoryProvider
        : null,
    historyToday: localOrderDate(new Date().toISOString()),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireSessionUser(request);
  const form = await readForm(request);
  const intent = form.get("intent") ?? "save-trigger";
  try {
    assertCsrf(user, form.get("csrf") ?? "");
    if (intent === "change-password") {
      await changePassword(
        request,
        {
          currentPassword: form.get("currentPassword"),
          newPassword: form.get("newPassword"),
          confirmation: form.get("passwordConfirmation"),
        },
        user,
        requestId(request),
      );
      return redirect("/impostazioni?profilo=password#profilo-sicurezza");
    }
    if (intent === "revoke-other-sessions") {
      await revokeOtherSessions(request, user, requestId(request));
      return redirect("/impostazioni?profilo=sessioni#profilo-sicurezza");
    }
    if (intent === "save-customer-email") {
      await setCustomerEmailMode(form.get("customerEmailMode"), form.get("emailModeVersion"), {
        id: user.id,
        canApprove: user.canApprove,
        requestId: requestId(request),
      });
      return redirect("/impostazioni?email=salvata#email-cliente");
    }
    if (intent === "save-shopify-payment-fee-mode") {
      await setShopifyPaymentFeeMode(
        form.get("shopifyPaymentFeeMode"),
        Number(form.get("shopifyPaymentFeeModeVersion") ?? Number.NaN),
        { id: user.id, requestId: requestId(request) },
      );
      return redirect("/impostazioni?commissioni=salvata#fatturazione");
    }
    if (intent === "save-aruba") {
      await setArubaSettings(
        {
          mode: form.get("arubaMode"),
          modeVersion: form.get("arubaModeVersion"),
        },
        { id: user.id, canApprove: user.canApprove, requestId: requestId(request) },
      );
      return redirect("/impostazioni?aruba=salvata#aruba-helper");
    }
    if (intent === "preview-ebay" || intent === "import-ebay") {
      const start = historicalOrderWindow(form.get("historyStart"));
      if (!start) throw new AppError("ORDER_INVALID_INPUT", 422);
      await enqueueEbayHistory(start.startDate, intent === "import-ebay" ? "IMPORT" : "PREVIEW");
      return redirect(
        `/impostazioni?historyStart=${encodeURIComponent(start.startDate)}&historyProvider=EBAY#connessioni`,
      );
    }
    if (intent === "preview-shopify") {
      const preview = await previewShopifyHistory(form.get("historyStart"));
      return redirect(
        "/impostazioni?" +
          new URLSearchParams({
            provider: "Shopify",
            count: String(preview.count),
            review: String(preview.reviewRequired),
            historyStart: String(form.get("historyStart")),
            historyProvider: "SHOPIFY",
          }).toString() +
          "#connessioni",
      );
    }
    if (intent === "import-shopify") {
      const result = await importShopifyHistory(form.get("historyStart"), {
        type: "ADMIN",
        id: user.id,
        requestId: requestId(request),
      });
      return redirect(
        "/impostazioni?" +
          new URLSearchParams({
            provider: "Shopify",
            imported: String(result.imported),
            updated: String(result.updated),
            ignored: String(result.ignored),
            historyStart: String(form.get("historyStart")),
            historyProvider: "SHOPIFY",
          }).toString() +
          "#connessioni",
      );
    }
    if (intent !== "save-trigger") {
      throw new Response("Azione non supportata", { status: 400 });
    }
    await setDraftTrigger(form.get("trigger"), Number(form.get("version") ?? Number.NaN), {
      id: user.id,
      requestId: requestId(request),
    });
    return redirect("/impostazioni?trigger=salvato#fatturazione");
  } catch (error) {
    if (error instanceof Response) throw error;
    const result = publicError(error);
    return data({ ...result, intent }, { status: result.status });
  }
}
