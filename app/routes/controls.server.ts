import { data, redirect } from "react-router";
import type { Route } from "./+types/controls";

import { ARUBA_IMPORT_MAX_BYTES } from "../../src/aruba.ts";
import {
  readArubaIdentityConflict,
  resolveArubaIdentityConflict,
} from "../../src/db/aruba-identity-resolution.server.ts";
import {
  confirmArubaDocumentOutOfScope,
  resolveArubaDocumentMatch,
} from "../../src/db/aruba-manual-decisions.server.ts";
import { importArubaRemoteOfficialFileAsActor } from "../../src/db/aruba-official-file-import.server.ts";
import { confirmArubaTransmissionAbsence } from "../../src/db/aruba-transmission-absence.server.ts";
import { assertCsrf, requestId, requireSessionUser } from "../../src/db/auth.server.ts";
import { retryFailedJob } from "../../src/db/connector-jobs.server.ts";
import { completeShopifyDataRequest } from "../../src/db/connector-webhooks.server.ts";
import {
  markOperationalControlWaiting,
  readOperationalControls,
  reopenOperationalControl,
  resolveOperationalControl,
} from "../../src/db/operational-controls.server.ts";
import { publicError } from "../../src/errors.ts";
import { readForm, readMultipartForm } from "../../src/http.server.ts";
import { controlsActionRedirect } from "../controls-navigation";
import { copy } from "../copy.it";
import { dateAfterInRome } from "../format";
import { controlOrigins, controlSeverities, controlWaitingReasons } from "./controls-options.ts";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const url = new URL(request.url);
  const state =
    url.searchParams.get("vista") === "attesa"
      ? "WAITING"
      : url.searchParams.get("vista") === "tutti"
        ? "ALL"
        : "OPEN";
  const requestedSeverity = url.searchParams.get("gravita");
  const requestedOrigin = url.searchParams.get("origine");
  const requestedKind = url.searchParams.get("tipo")?.trim() ?? "";
  const selectedControlId = url.searchParams.get("id")?.trim() ?? "";
  const search = url.searchParams.get("q")?.trim() ?? "";
  const cursor = url.searchParams.get("cursore")?.trim() ?? "";
  const due = (["OVERDUE", "TODAY"] as const).find(
    (value) => value === url.searchParams.get("scadenza"),
  );
  const assignedToMe = url.searchParams.get("assegnati") === "me";
  const severity = controlSeverities.find((item) => item === requestedSeverity);
  const origin = controlOrigins.find((item) => item === requestedOrigin);
  const result = await readOperationalControls({
    state,
    severity,
    origin,
    kind: Object.hasOwn(copy.controls.kinds, requestedKind) ? requestedKind : undefined,
    selectedId: selectedControlId || undefined,
    search,
    cursor: cursor || undefined,
    due,
    assigneeUsername: assignedToMe ? user.username : undefined,
  });
  const selected = result.selected;
  const identityConflict =
    selected?.kind === "ARUBA_IDENTITY_CONFLICT" && selected.metadata_json.remoteDocumentId
      ? await readArubaIdentityConflict(selected.metadata_json.remoteDocumentId)
      : null;
  return {
    identityConflict,
    username: user.username,
    canApprove: user.canApprove,
    csrfToken: user.csrfToken,
    state,
    severity: severity ?? "",
    origin: origin ?? "",
    kind: Object.hasOwn(copy.controls.kinds, requestedKind) ? requestedKind : "",
    result,
    selectedControlId,
    search,
    cursor,
    due: due ?? "",
    assignedToMe,
    defaultDueDate: dateAfterInRome(1),
    today: dateAfterInRome(0),
    outcome: url.searchParams.get("esito") ?? "",
    currentTime: new Date().toISOString(),
  };
}

export async function action({ request }: Route.ActionArgs) {
  try {
    const user = await requireSessionUser(request);
    const actionRedirect = (options: Parameters<typeof controlsActionRedirect>[1]) =>
      redirect(controlsActionRedirect(request.url, options));
    if (request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) {
      const form = await readMultipartForm(request, {
        maxBytes: ARUBA_IMPORT_MAX_BYTES + 64 * 1024,
      });
      assertCsrf(user, String(form.get("csrf") ?? ""));
      const file = form.get("file");
      if (!(file instanceof File)) throw new Response("File mancante", { status: 422 });
      const controlId = String(form.get("controlId") ?? "");
      await importArubaRemoteOfficialFileAsActor(
        String(form.get("remoteDocumentId") ?? ""),
        "ARUBA_XML",
        Buffer.from(await file.arrayBuffer()),
        {
          id: user.id,
          canApprove: user.canApprove,
          requestId: requestId(request),
        },
      );
      return actionRedirect({
        outcome: "file-acquisito",
        selectedControlId: controlId,
        state: "OPEN",
      });
    }
    const form = await readForm(request);
    assertCsrf(user, form.get("csrf") ?? "");
    const intent = form.get("intent") ?? "";
    const controlId = form.get("controlId") ?? "";
    const note = form.get("note") ?? "";
    const actor = {
      type: "ADMIN" as const,
      id: user.id,
      canApprove: user.canApprove,
      requestId: requestId(request),
    };
    if (intent === "retry-connector-job") {
      await retryFailedJob(form.get("jobId"), actor);
      await markOperationalControlWaiting(controlId, {
        reason: "TECHNICAL",
        assigneeUsername: user.username === "Codex" ? "Codex" : "Massimo",
        note,
      });
      return actionRedirect({
        outcome: "attesa",
        selectedControlId: controlId,
        state: "WAITING",
      });
    }
    if (intent === "wait-control") {
      const reason = controlWaitingReasons.find((value) => value === form.get("waitingReason"));
      const assignee = ["Massimo", "Codex"].find((value) => value === form.get("assignee"));
      if (!reason) throw new Response("Motivo di attesa non valido", { status: 422 });
      if (assignee !== "Massimo" && assignee !== "Codex") {
        throw new Response("Assegnatario non valido", { status: 422 });
      }
      await markOperationalControlWaiting(controlId, {
        reason,
        dueDate: form.get("dueDate") ?? undefined,
        assigneeUsername: assignee,
        note,
      });
      return actionRedirect({
        outcome: "attesa",
        selectedControlId: controlId,
        state: "WAITING",
      });
    }
    if (intent === "reopen-control") {
      await reopenOperationalControl(controlId);
      return actionRedirect({
        outcome: "riaperto",
        selectedControlId: controlId,
        state: "OPEN",
      });
    }
    if (intent === "complete-shopify-data-request") {
      await completeShopifyDataRequest(
        form.get("externalEventId"),
        form.get("privacyHandled"),
        actor,
      );
      await resolveOperationalControl(controlId, "PRIVACY_COMPLETED", note);
      return actionRedirect({ outcome: "completato" });
    }
    if (intent === "resolve-aruba-identity") {
      await resolveArubaIdentityConflict(
        form.get("remoteDocumentId") ?? "",
        form.get("selectedRemoteId") ?? "",
        form.get("fingerprint") ?? "",
        form.get("reason"),
        form.get("confirmation"),
        actor,
      );
      return actionRedirect({ outcome: "completato" });
    }
    if (intent === "resolve-aruba-match") {
      await resolveArubaDocumentMatch(
        form.get("remoteDocumentId") ?? "",
        form.get("orderId") ?? "",
        form.get("reason"),
        form.get("amountMismatchConfirmation"),
        form.get("externalEvidenceConfirmation"),
        actor,
      );
      await resolveOperationalControl(controlId, "ARUBA_MATCHED", note);
      return actionRedirect({ outcome: "completato" });
    }
    if (intent === "confirm-aruba-transmission-absence") {
      await confirmArubaTransmissionAbsence(
        form.get("remoteDocumentId") ?? "",
        form.get("metadataDigest") ?? "",
        form.get("reason"),
        form.get("confirmation"),
        actor,
      );
      return actionRedirect({ outcome: "completato" });
    }
    if (intent === "confirm-aruba-out-of-scope") {
      await confirmArubaDocumentOutOfScope(
        form.get("remoteDocumentId") ?? "",
        form.get("reason"),
        form.get("candidateRejection"),
        actor,
      );
      await resolveOperationalControl(controlId, "ARUBA_OUT_OF_SCOPE", note);
      return actionRedirect({ outcome: "completato" });
    }
    throw new Response("Azione non supportata", { status: 400 });
  } catch (error) {
    if (error instanceof Response) throw error;
    const result = publicError(error);
    return data(result, { status: result.status });
  }
}
