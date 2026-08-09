import { checkDatabaseHealth } from "../../src/db/client.server.ts";

export async function loader() {
  await checkDatabaseHealth();
  return Response.json({ status: "ok" });
}
