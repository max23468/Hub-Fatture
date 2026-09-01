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
  SHOPIFY_BANK_TRANSFER_ROUNDING_REPLAY,
  copyMigrationSnapshot,
} from "./support.ts";

test("l'upgrade rilegge i bonifici Shopify arrotondati entro due centesimi", async () => {
  const database = await temporaryDatabase("shopify_bank_transfer_rounding_replay");
  const beforeReplay = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-shopify-bank-rounding-"),
  );
  try {
    await copyMigrationSnapshot(beforeReplay);
    await runMigrations({ connectionString: database.connectionString, directory: beforeReplay });
    await withClient(database.connectionString, async (client) => {
      await client.query(
        `INSERT INTO connections
           (provider, environment, account_reference, encrypted_credentials, status,
            last_synced_at)
         VALUES ('SHOPIFY', 'PRODUCTION', 'shop.example', 'encrypted', 'CONNECTED',
                 '2026-09-01T12:00:00Z');
         INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
         VALUES
           ('SHOPIFY', 'history_import', 'complete', '2026-01-01T00:00:00Z'),
           ('SHOPIFY', 'orders', 'recent', '2026-09-01T00:00:00Z')`,
      );
      const customerId = (
        await client.query(
          `INSERT INTO customers
             (kind, match_key, display_name, billing_address_json, source_confidence,
              review_required)
           VALUES ('EU', 'shopify-bank-rounding', 'Cliente', '{}', 'EXACT_PROFILE', false)
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
           VALUES ('SHOPIFY', 'shop.example', 'rounded-bank-transfer', '#ROUND',
                   '2026-08-19T09:00:00Z', '2026-08-19T10:00:00Z', '2026-08-19',
                   'EUR', 1000, 'PAID', 'FULFILLED', 'NEEDS_REVIEW', $1, '{}',
                   '{"shippingAmount":0,"totalsReconciled":false}')
           RETURNING id`,
          [customerId],
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO order_lines
           (order_id, external_line_id, description, quantity, gross_amount,
            discount_amount, raw_json)
         VALUES ($1, 'line', 'Articolo', 1, 1000, 0, '{}')`,
        [orderId],
      );
      await client.query(
        `INSERT INTO payments
           (order_id, external_payment_id, method, status, amount, raw_json)
         VALUES ($1, 'payment', 'Bonifico Bancario', 'PAID', 1002, '{}')`,
        [orderId],
      );
    });

    const applied = await runMigrations({ connectionString: database.connectionString });
    assert.ok(applied.includes(SHOPIFY_BANK_TRANSFER_ROUNDING_REPLAY));
    await withClient(database.connectionString, async (client) => {
      assert.deepEqual(
        (
          await client.query(
            `SELECT cursor, overlap_from::text
             FROM sync_cursors WHERE provider = 'SHOPIFY' AND stream = 'orders'`,
          )
        ).rows[0],
        { cursor: null, overlap_from: "2026-08-19 09:55:00+00" },
      );
      assert.equal(
        (await client.query("SELECT last_synced_at FROM connections WHERE provider = 'SHOPIFY'"))
          .rows[0].last_synced_at,
        null,
      );
    });
  } finally {
    await rm(beforeReplay, { recursive: true, force: true });
    await database.drop();
  }
});
