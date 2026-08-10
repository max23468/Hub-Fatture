import { data } from "react-router";
import type { Route } from "./+types/aruba-helper-file";

import { ARUBA_IMPORT_MAX_BYTES } from "../../src/aruba.ts";
import { helperBearer, importOfficialArubaFileFromHelper } from "../../src/db/aruba.server.ts";
import { publicError } from "../../src/errors.ts";
import { readRawBody } from "../../src/http.server.ts";

export async function action({ request, params }: Route.ActionArgs) {
  try {
    if (request.headers.get("content-type") !== "application/octet-stream") {
      return data(
        { code: "INVALID_CONTENT_TYPE", message: "Formato richiesta non valido." },
        { status: 415 },
      );
    }
    const bytes = await readRawBody(request, {
      maxBytes: ARUBA_IMPORT_MAX_BYTES,
      timeoutMs: 30_000,
    });
    await importOfficialArubaFileFromHelper(
      helperBearer(request),
      params.documentId,
      request.headers.get("x-aruba-file-kind"),
      bytes,
    );
    return data({ ok: true });
  } catch (error) {
    const result = publicError(error);
    return data(result, { status: result.status });
  }
}
