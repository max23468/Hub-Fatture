import { data } from "react-router";
import type { Route } from "./+types/aruba-sync-document-file";

import { ARUBA_IMPORT_MAX_BYTES } from "../../src/aruba.ts";
import { importArubaRemoteOfficialFile } from "../../src/db/aruba-inbound.server.ts";
import { arubaReadBearer } from "../../src/db/aruba-read-session.server.ts";
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
    return data(
      await importArubaRemoteOfficialFile(
        arubaReadBearer(request),
        params.remoteDocumentId,
        request.headers.get("x-aruba-file-kind"),
        bytes,
      ),
    );
  } catch (error) {
    const result = publicError(error);
    return data(result, { status: result.status });
  }
}
