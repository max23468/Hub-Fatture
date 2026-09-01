import {
  assert,
  mkdtemp,
  rm,
  os,
  path,
  test,
  runMigrations,
  temporaryDatabase,
  withClient,
  EBAY_CONTROL_ALIGNMENT_REPLAY,
  copyMigrationSnapshot,
} from "./support.ts";

test("l'upgrade rilegge gli ordini eBay per riallineare i controlli", async () => {
  const database = await temporaryDatabase("ebay_control_alignment_replay");
  const beforeReplay = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-ebay-control-alignment-"),
  );
  try {
    await copyMigrationSnapshot(beforeReplay);
    await runMigrations({ connectionString: database.connectionString, directory: beforeReplay });
    await withClient(database.connectionString, async (client) => {
      await client.query(
        `INSERT INTO connections
           (provider, environment, account_reference, encrypted_credentials, status,
            last_synced_at)
         VALUES ('EBAY', 'PRODUCTION', 'seller-controls', 'encrypted', 'CONNECTED',
                 '2026-08-31T12:00:00Z');
         INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
         VALUES
           ('EBAY', 'history_import', 'complete', '2026-01-01T00:00:00Z'),
           ('EBAY', 'orders', 'recent', '2026-08-31T00:00:00Z')`,
      );
      const customerId = (
        await client.query(
          `INSERT INTO customers
             (kind, match_key, display_name, billing_address_json, source_confidence,
              review_required)
           VALUES ('PRIVATE_IT', 'ebay-control-replay', 'Cliente', '{}', 'TAX_ID', true)
           RETURNING id`,
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO orders
           (provider, external_account_id, external_order_id, display_number,
            created_at_source, updated_at_source, local_order_date, currency, gross_amount,
            payment_status, fulfillment_status, trigger_status, customer_id,
            raw_snapshot_json, normalized_snapshot_json)
         VALUES ('EBAY', 'seller-controls', 'control-order', 'E-CTRL',
                 '2026-08-20T09:00:00Z', '2026-08-20T10:00:00Z', '2026-08-20',
                 'EUR', 1000, 'PAID', 'FULFILLED', 'NEEDS_REVIEW', $1, '{}', '{}')`,
        [customerId],
      );
    });

    const applied = await runMigrations({ connectionString: database.connectionString });
    assert.ok(applied.includes(EBAY_CONTROL_ALIGNMENT_REPLAY));
    await withClient(database.connectionString, async (client) => {
      assert.deepEqual(
        (
          await client.query(
            `SELECT cursor, overlap_from::text
             FROM sync_cursors WHERE provider = 'EBAY' AND stream = 'orders'`,
          )
        ).rows[0],
        { cursor: null, overlap_from: "2026-08-20 09:55:00+00" },
      );
      assert.equal(
        (await client.query("SELECT last_synced_at FROM connections WHERE provider = 'EBAY'"))
          .rows[0].last_synced_at,
        null,
      );
    });
  } finally {
    await rm(beforeReplay, { recursive: true, force: true });
    await database.drop();
  }
});
