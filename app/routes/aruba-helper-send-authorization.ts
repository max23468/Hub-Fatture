import { data } from "react-router";
import type { Route } from "./+types/aruba-helper-send-authorization";

import { helperBearer, verifyArubaSendAuthorization } from "../../src/db/aruba.server.ts";
import { publicError } from "../../src/errors.ts";
import { readJson } from "../../src/http.server.ts";

export async function action({ request }: Route.ActionArgs) {
  try {
    const body = (await readJson(request)) as Record<string, unknown>;
    await verifyArubaSendAuthorization(helperBearer(request), body.manifestSha256);
    return data({ authorized: true });
  } catch (error) {
    const result = publicError(error);
    return data(result, { status: result.status });
  }
}
