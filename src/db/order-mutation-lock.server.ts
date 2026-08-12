import type pg from "pg";

export async function serializeOrderMutations(client: pg.PoolClient) {
  // Lock globale adatto al single tenant; usare lock ordinati per ordine se la concorrenza misurata lo richiede.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('order-import-batch'))");
}
