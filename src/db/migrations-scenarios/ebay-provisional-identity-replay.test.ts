import {
  assert,
  cp,
  EBAY_PROVISIONAL_IDENTITY_REPLAY,
  migrationsFrom,
  mkdtemp,
  os,
  path,
  removeMigrationsFrom,
  rm,
  runMigrations,
  temporaryDatabase,
  test,
  withClient,
} from "./support.ts";

test("l'upgrade rilegge gli ordini eBay provvisori ancora consolidabili", async () => {
  const database = await temporaryDatabase("ebay_provisional_identity_replay");
  const beforeReplay = await mkdtemp(path.join(os.tmpdir(), "hub-fatture-before-ebay-replay-"));
  try {
    await cp("migrations", beforeReplay, { recursive: true });
    await removeMigrationsFrom(beforeReplay, EBAY_PROVISIONAL_IDENTITY_REPLAY);
    await runMigrations({ connectionString: database.connectionString, directory: beforeReplay });
    await withClient(database.connectionString, async (client) => {
      await client.query(`
        INSERT INTO connections
          (provider, environment, account_reference, encrypted_credentials, status, last_synced_at)
        VALUES ('EBAY', 'PRODUCTION', 'seller', 'encrypted', 'CONNECTED', now());
        INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
        VALUES ('EBAY', 'history_import', 'complete', now() - interval '7 days'),
               ('EBAY', 'orders', 'recent', now() - interval '10 minutes');
        WITH customer AS (
          INSERT INTO customers
            (kind, match_key, display_name, billing_address_json, source_confidence,
             review_required)
          VALUES ('UNKNOWN', 'ebay-provisional', 'Cliente', '{}', 'AMBIGUOUS', false)
          RETURNING id
        ), inserted_order AS (
          INSERT INTO orders
            (provider, external_account_id, external_order_id, display_number,
             created_at_source, updated_at_source, local_order_date, currency, gross_amount,
             payment_status, fulfillment_status, trigger_status, customer_id,
             raw_snapshot_json, normalized_snapshot_json)
          SELECT 'EBAY', 'seller', 'temporary-order', 'temporary-order',
                 now() - interval '1 day', now() - interval '23 hours', current_date - 1,
                 'EUR', 1000, 'PENDING', 'UNFULFILLED', 'WAITING_FOR_TRIGGER', id,
                 '{"sourceSnapshot":{"sourceApi":"EBAY_TRADING"}}'::jsonb, '{}'
          FROM customer
          RETURNING id
        )
        INSERT INTO order_source_identities
          (provider, external_account_id, identity_kind, external_id, order_id)
        SELECT 'EBAY', 'seller', 'ORDER_LINE_ITEM', 'stable-line', id FROM inserted_order;
      `);
    });

    assert.deepEqual(
      await runMigrations({ connectionString: database.connectionString }),
      migrationsFrom(EBAY_PROVISIONAL_IDENTITY_REPLAY),
    );
    await withClient(database.connectionString, async (client) => {
      const cursor = await client.query(
        `SELECT cursor, overlap_from = (
           SELECT updated_at_source - interval '5 minutes' FROM orders
           WHERE external_order_id = 'temporary-order'
         ) AS expected
         FROM sync_cursors WHERE provider = 'EBAY' AND stream = 'orders'`,
      );
      assert.deepEqual(cursor.rows[0], { cursor: null, expected: true });
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
