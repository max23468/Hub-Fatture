import { redirect } from "react-router";
import type { Route } from "./+types/billing-case-detail";

import { actionResult } from "../action";
import { assertCsrf, requestId, requireSessionUser } from "../../src/db/auth.server.ts";
import {
  completeManualArubaPreflight,
  getPendingArubaPreflightForCase,
} from "../../src/db/aruba-inbound.server.ts";
import {
  approveInvoice,
  getInvoiceProjection,
  saveInvoiceDraft,
} from "../../src/db/documents.server.ts";
import {
  addOrderToBillingCase,
  correctBillingCaseCustomer,
  getBillingCase,
  reviewBillingCaseSourceChanges,
  separateOrderFromBillingCase,
  updateBillingCaseTransmission,
} from "../../src/db/orders.server.ts";
import { AppError } from "../../src/errors.ts";
import { readForm } from "../../src/http.server.ts";
import { invoiceLinesFromForm } from "../invoice-lines.ts";

interface Actor {
  id: number;
  canApprove: boolean;
  requestId: string;
}

function runIntent(
  intent: string | null,
  caseId: string,
  form: URLSearchParams,
  revision: string | null,
  actor: Actor,
) {
  if (intent === "save-document") {
    let lines;
    try {
      lines = invoiceLinesFromForm(form);
    } catch {
      throw new AppError("DOCUMENT_INVALID", 422);
    }
    return saveInvoiceDraft(
      caseId,
      {
        caseRevision: revision,
        draftVersion: form.get("draftVersion"),
        differenceReason: form.get("differenceReason"),
        paymentStatus: form.get("paymentStatus"),
        paymentMethod: form.get("paymentMethod"),
        causale: form.get("causale"),
        notes: form.get("notes"),
        lines,
      },
      actor,
    );
  }
  if (intent === "approve-document") {
    return approveInvoice(
      caseId,
      {
        caseRevision: revision,
        draftVersion: form.get("draftVersion"),
        projectionSha256: form.get("projectionSha256"),
        confirmApproval: form.get("confirmApproval") === "yes",
        confirmPending: form.get("confirmPending") === "yes",
        confirmDifference: form.get("confirmDifference") === "yes",
        arubaMode: form.get("arubaMode"),
        emailChoice: form.get("emailChoice"),
        emailModeVersion: form.get("emailModeVersion"),
      },
      actor,
    );
  }
  if (intent === "do-not-transmit") {
    return updateBillingCaseTransmission(caseId, form.get("reason") ?? "", revision, actor);
  }
  if (intent === "reactivate") {
    return updateBillingCaseTransmission(caseId, null, revision, actor);
  }
  if (intent === "separate-order") {
    return separateOrderFromBillingCase(caseId, form.get("orderId") ?? "", revision, actor);
  }
  if (intent === "add-order") {
    return addOrderToBillingCase(caseId, form.get("orderId") ?? "", revision, actor);
  }
  if (intent === "review-source-changes") {
    return reviewBillingCaseSourceChanges(
      caseId,
      revision,
      form.get("confirmSourceReview") === "yes",
      actor,
    );
  }
  if (intent === "complete-manual-aruba-preflight") {
    let pages;
    try {
      pages = JSON.parse(String(form.get("pagesJson") ?? "null")) as unknown;
    } catch {
      throw new AppError("ARUBA_INVENTORY_INVALID", 422);
    }
    return completeManualArubaPreflight(
      form.get("receiptId") ?? "",
      pages,
      form.get("overrideReason"),
      actor,
    );
  }
  if (intent !== "correct-customer") return Promise.resolve("unknown" as const);
  const types = form.getAll("taxType");
  const countries = form.getAll("taxCountryCode");
  return correctBillingCaseCustomer(
    caseId,
    {
      kind: form.get("kind"),
      displayName: form.get("displayName"),
      firstName: form.get("firstName"),
      lastName: form.get("lastName"),
      companyName: form.get("companyName"),
      email: form.get("email"),
      certifiedEmail: form.get("certifiedEmail"),
      recipientCode: form.get("recipientCode"),
      phone: form.get("phone"),
      billingAddress: {
        line1: form.get("line1"),
        line2: form.get("line2"),
        postalCode: form.get("postalCode"),
        city: form.get("city"),
        province: form.get("province"),
        countryCode: form.get("countryCode"),
      },
      // Un valore vuoto rimuove la riga; tutte le altre sopravvivono alla correzione.
      taxIdentifiers: form.getAll("taxValue").flatMap((value, index) =>
        value.trim()
          ? [
              {
                type: types[index],
                value: value.trim(),
                countryCode: countries[index],
                sourceField: "correzione-manuale",
              },
            ]
          : [],
      ),
    },
    revision,
    form.get("reason"),
    actor,
  );
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const [user, billingCase] = await Promise.all([
    requireSessionUser(request),
    getBillingCase(params.caseId),
  ]);
  if (!billingCase) throw new Response("Preparazione non trovata", { status: 404 });
  const [projection, pendingArubaPreflight] = await Promise.all([
    getInvoiceProjection(params.caseId).catch((error: unknown) => {
      if (error instanceof AppError) return { error: error.message } as const;
      throw error;
    }),
    getPendingArubaPreflightForCase(params.caseId),
  ]);
  return {
    username: user.username,
    canApprove: user.canApprove,
    csrfToken: user.csrfToken,
    billingCase,
    projection,
    pendingArubaPreflight,
    storagePending: new URL(request.url).searchParams.get("archiviazione") === "pendente",
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  return actionResult(async () => {
    const user = await requireSessionUser(request);
    const form = await readForm(request);
    assertCsrf(user, form.get("csrf") ?? "");
    const outcome = await runIntent(form.get("intent"), params.caseId, form, form.get("revision"), {
      id: user.id,
      canApprove: user.canApprove,
      requestId: requestId(request),
    });
    if (outcome === "unknown") throw new Response("Azione non riconosciuta", { status: 400 });
    if (outcome === null) throw new Response("Preparazione non trovata", { status: 404 });
    const storagePending =
      typeof outcome === "object" &&
      outcome !== null &&
      "storagePending" in outcome &&
      outcome.storagePending === true;
    return redirect(
      `/ordini/preparazione/${params.caseId}${storagePending ? "?archiviazione=pendente" : ""}`,
    );
  });
}
