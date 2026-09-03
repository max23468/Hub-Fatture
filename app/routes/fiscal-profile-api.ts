import type { Route } from "./+types/fiscal-profile-api";

import { assertCsrf, getSessionUser, requestId } from "../../src/db/auth.server.ts";
import { getFiscalProfileSettings } from "../../src/db/documents.server.ts";
import { AppError, publicError } from "../../src/errors.ts";
import { readMultipartForm, securePrivateHeaders } from "../../src/http.server.ts";
import {
  activateFiscalProfileFromAcceptedXml,
  FISCAL_PROFILE_XML_MAX_BYTES,
} from "../../src/operations/fiscal-profile-activation.ts";

const ACTIVATION_CONFIRMATION = "DOCUMENTI_SDI_ACCETTATI";
const MULTIPART_OVERHEAD_BYTES = 128 * 1024;
const MULTIPART_TIMEOUT_MS = 15_000;

function json(value: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  securePrivateHeaders(headers);
  return Response.json(value, { ...init, headers });
}

async function authenticatedUser(request: Request) {
  const user = await getSessionUser(request);
  if (!user) throw new AppError("AUTH_INVALID_CREDENTIALS", 401);
  return user;
}

function publicProfile(profile: Awaited<ReturnType<typeof getFiscalProfileSettings>>) {
  if (!profile) return null;
  return {
    version: profile.version,
    status: profile.status,
    auditedAt: profile.auditedAt,
    taxRegime: profile.taxRegime,
    taxNature: profile.taxNature,
    series: profile.series,
    cadence: profile.cadence,
    sharedByInvoiceAndCreditNote: profile.sharedByInvoiceAndCreditNote,
  };
}

function publicActivatedProfile(
  activation: Awaited<ReturnType<typeof activateFiscalProfileFromAcceptedXml>>,
) {
  return {
    version: activation.version,
    status: activation.status,
    auditedAt: activation.auditedAt,
    taxRegime: activation.profile.seller.taxRegime,
    taxNature: activation.profile.taxNature,
    series: activation.profile.series,
    cadence: activation.profile.numbering.cadence,
    sharedByInvoiceAndCreditNote: activation.profile.numbering.sharedByInvoiceAndCreditNote,
  };
}

export async function loader({ request }: Route.LoaderArgs) {
  try {
    await authenticatedUser(request);
    return json({ profile: publicProfile(await getFiscalProfileSettings()) });
  } catch (error) {
    const result = publicError(error);
    return json({ code: result.code, message: result.message }, { status: result.status });
  }
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    const error = new AppError("METHOD_NOT_ALLOWED", 405);
    return json(
      { code: error.code, message: error.message },
      { status: error.status, headers: { Allow: "GET, POST" } },
    );
  }

  try {
    const user = await authenticatedUser(request);
    if (!user.canApprove) throw new AppError("DOCUMENT_APPROVAL_FORBIDDEN", 403);
    const form = await readMultipartForm(request, {
      maxBytes: FISCAL_PROFILE_XML_MAX_BYTES * 2 + MULTIPART_OVERHEAD_BYTES,
      timeoutMs: MULTIPART_TIMEOUT_MS,
      invalidCode: "FISCAL_PROFILE_SOURCE_INVALID",
    });
    assertCsrf(user, String(form.get("csrf") ?? ""));
    if (form.get("confirmation") !== ACTIVATION_CONFIRMATION) {
      throw new AppError("FISCAL_PROFILE_CONFIRMATION_REQUIRED", 422);
    }
    const expectedVersionValue = String(form.get("expectedVersion") ?? "");
    if (!/^(0|[1-9]\d*)$/.test(expectedVersionValue)) {
      throw new AppError("FISCAL_PROFILE_SOURCE_INVALID", 422);
    }
    const expectedVersion = Number(expectedVersionValue);
    if (!Number.isSafeInteger(expectedVersion)) {
      throw new AppError("FISCAL_PROFILE_SOURCE_INVALID", 422);
    }

    const profileFile = form.get("profileXml");
    const latestDocumentFile = form.get("latestDocumentXml");
    if (!(profileFile instanceof File) || profileFile.size === 0) {
      throw new AppError("FISCAL_PROFILE_SOURCE_INVALID", 422);
    }
    if (latestDocumentFile !== null && !(latestDocumentFile instanceof File)) {
      throw new AppError("FISCAL_PROFILE_SOURCE_INVALID", 422);
    }
    if (latestDocumentFile instanceof File && latestDocumentFile.size === 0) {
      throw new AppError("FISCAL_PROFILE_SOURCE_INVALID", 422);
    }

    const activation = await activateFiscalProfileFromAcceptedXml(
      {
        profileXml: new Uint8Array(await profileFile.arrayBuffer()),
        latestDocumentXml:
          latestDocumentFile instanceof File
            ? new Uint8Array(await latestDocumentFile.arrayBuffer())
            : undefined,
        expectedVersion,
      },
      { id: user.id, canApprove: user.canApprove, requestId: requestId(request) },
    );
    return json(
      { profile: publicActivatedProfile(activation), created: activation.created },
      { status: activation.created ? 201 : 200 },
    );
  } catch (error) {
    const result = publicError(error);
    return json({ code: result.code, message: result.message }, { status: result.status });
  }
}
