import { data } from "react-router";
import type { Route } from "./+types/aruba-helper-permit";

import { consumeArubaPermit, helperBearer } from "../../src/db/aruba.server.ts";
import { publicError } from "../../src/errors.ts";
import { readJson } from "../../src/http.server.ts";

export async function action({ request }: Route.ActionArgs) {
  try {
    const body = (await readJson(request)) as Record<string, unknown>;
    await consumeArubaPermit(helperBearer(request), body.manifestSha256);
    return data({ consumed: true });
  } catch (error) {
    const result = publicError(error);
    return data(result, { status: result.status });
  }
}
