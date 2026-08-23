import { randomUUID } from "node:crypto";

import type { Route } from "./+types/aruba-browser-session";

import { assertCsrf, requestId, requireSessionUser } from "../../src/db/auth.server.ts";
import { issueArubaReadSession } from "../../src/db/aruba-inbound.server.ts";
import { AppError, publicError } from "../../src/errors.ts";

const noStore = { "Cache-Control": "no-store" };

export async function action({ request }: Route.ActionArgs) {
  const user = await requireSessionUser(request);
  try {
    if (!user.canApprove) throw new AppError("ARUBA_OPERATION_FORBIDDEN", 403);
    const form = await request.formData();
    assertCsrf(user, String(form.get("csrf") ?? ""));
    const session = await issueArubaReadSession(`bookmarklet-${randomUUID()}`, {
      id: user.id,
      canApprove: user.canApprove,
      requestId: requestId(request),
    });
    return Response.json(session, { headers: noStore });
  } catch (error) {
    const result = publicError(error);
    return Response.json(result, { status: result.status, headers: noStore });
  }
}
