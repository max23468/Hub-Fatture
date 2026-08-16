import { issueArubaReadSession } from "./aruba-inbound.server.ts";
import { arubaInventoryManifest } from "./aruba-inventory-cycle.server.ts";

export async function issueStableArubaReadSession(
  deviceId: unknown,
  actor: Parameters<typeof issueArubaReadSession>[1],
) {
  const session = await issueArubaReadSession(deviceId, actor);
  await arubaInventoryManifest(session.token);
  return session;
}
