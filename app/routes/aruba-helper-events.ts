import { data } from "react-router";
import type { Route } from "./+types/aruba-helper-events";

import { helperBearer, recordHelperEvent } from "../../src/db/aruba.server.ts";
import { publicError } from "../../src/errors.ts";
import { readJson } from "../../src/http.server.ts";

export async function action({ request }: Route.ActionArgs) {
  try {
    await recordHelperEvent(helperBearer(request), await readJson(request));
    return data({ ok: true });
  } catch (error) {
    const result = publicError(error);
    return data(result, { status: result.status });
  }
}
