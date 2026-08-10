import { data } from "react-router";
import type { Route } from "./+types/aruba-official-file";

import { requireSessionUser } from "../../src/db/auth.server.ts";
import { readOfficialArubaFile } from "../../src/db/aruba.server.ts";
import { publicError } from "../../src/errors.ts";

export async function loader({ request, params }: Route.LoaderArgs) {
  try {
    await requireSessionUser(request);
    const file = await readOfficialArubaFile(params.documentId, params.fileId);
    const extension = {
      ARUBA_XML: "xml",
      ARUBA_P7M: "p7m",
      ARUBA_PDF: "pdf",
      SDI_NOTIFICATION: "xml",
    }[file.kind];
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        "Cache-Control": "no-store, private",
        "Content-Disposition": `attachment; filename="aruba-${params.documentId}-${params.fileId}.${extension}"`,
        "Content-Type": file.content_type,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const result = publicError(error);
    return data(result, { status: result.status });
  }
}
