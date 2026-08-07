import { getPool } from "../../src/db/client.server.ts";

export async function loader() {
  await getPool().query("SELECT 1");
  return Response.json({ status: "ok" });
}
