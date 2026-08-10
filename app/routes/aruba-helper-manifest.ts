import { data } from "react-router";
import type { Route } from "./+types/aruba-helper-manifest";

import { helperBearer, helperManifest } from "../../src/db/aruba.server.ts";
import { publicError } from "../../src/errors.ts";

export async function loader({ request }: Route.LoaderArgs) {
  try {
    return data(await helperManifest(helperBearer(request)));
  } catch (error) {
    const result = publicError(error);
    return data(result, { status: result.status });
  }
}
