import {
  assert,
  copyMigrationSnapshot,
  EBAY_SHIPPING_REFUND_REPLAY,
  mkdtemp,
  os,
  path,
  rm,
  runMigrations,
  temporaryDatabase,
  test,
  withClient,
} from "./support.ts";

test("l'upgrade rilegge i rimborsi eBay ancora senza importo cliente", async () => {
  const database = await temporaryDatabase("ebay_shipping_refund_replay");
  const beforeReplay = await mkdtemp(path.join(os.tmpdir(), "hub-fatture-before-ebay-refund-"));
  try {
    await copyMigrationSnapshot(beforeReplay);
    await runMigrations({ connectionString: database.connectionString, directory: beforeReplay });
    await withClient(database.connectionString, async (client) => {
      await client.query(
        `INSERT INTO connections
           (provider, environment, account_reference, encrypted_credentials, status,
            last_synced_at)
         VALUES ('EBAY', 'PRODUCTION', 'seller', 'encrypted', 'CONNECTED',
                 '2026-09-01T12:00:00Z');
         INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
         VALUES
           ('EBAY', 'history_import', 'complete', '2026-01-01T00:00:00Z'),
           ('EBAY', 'orders', 'recent', '2026-09-01T00:00:00Z')`,
      );
      const customerId = (
        await client.query(
          `INSERT INTO customers
             (kind, match_key, display_name, billing_address_json, source_confidence,
              review_required)
           VALUES ('EU', 'ebay-shipping-refund', 'Cliente', '{}', 'EXACT_PROFILE', false)
           RETURNING id`,
        )
      ).rows[0].id;
      const orderId = (
        await client.query(
          `INSERT INTO orders
             (provider, external_account_id, external_order_id, display_number,
              created_at_source, updated_at_source, local_order_date, currency, gross_amount,
              payment_status, fulfillment_status, trigger_status, customer_id,
              raw_snapshot_json, normalized_snapshot_json)
           VALUES ('EBAY', 'seller', 'shipping-refund', '106',
                   '2026-08-19T09:00:00Z', '2026-08-19T10:00:00Z', '2026-08-19',
                   'EUR', 3698, 'PAID', 'FULFILLED', 'NEEDS_REVIEW', $1, '{}', '{}')
           RETURNING id`,
          [customerId],
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO refunds
           (provider, external_account_id, external_order_id, external_refund_id,
            order_id, status, amount, raw_json)
         VALUES ('EBAY', 'seller', 'shipping-refund', 'shipping-refund', $1,
                 'AMBIGUOUS', NULL, '{}')`,
        [orderId],
      );
    });

    const applied = await runMigrations({ connectionString: database.connectionString });
    assert.ok(applied.includes(EBAY_SHIPPING_REFUND_REPLAY));
    await withClient(database.connectionString, async (client) => {
      assert.deepEqual(
        (
          await client.query(
            `SELECT cursor, overlap_from::text
             FROM sync_cursors WHERE provider = 'EBAY' AND stream = 'orders'`,
          )
        ).rows[0],
        { cursor: null, overlap_from: "2026-08-19 09:55:00+00" },
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
