import {
  assert,
  cp,
  copyMigrationSnapshot,
  mkdtemp,
  os,
  path,
  rm,
  runMigrations,
  SHOPIFY_SOURCE_CONFLICT_REPLAY,
  SHOPIFY_IDENTITY_FULFILLMENT_REPLAY,
  temporaryDatabase,
  test,
  withClient,
  migrationsFrom,
  removeMigrationsFrom,
} from "./support.ts";

test("l'upgrade rilegge identità mancanti e conflitti Shopify", async () => {
  const database = await temporaryDatabase("shopify_identity_fulfillment_replay");
  const beforeReplay = await mkdtemp(path.join(os.tmpdir(), "hub-fatture-before-shopify-id-"));
  try {
    await copyMigrationSnapshot(beforeReplay);
    await runMigrations({ connectionString: database.connectionString, directory: beforeReplay });
    await withClient(database.connectionString, async (client) => {
      await client.query(`
        INSERT INTO connections
          (provider, environment, account_reference, encrypted_credentials, status, last_synced_at)
        VALUES ('SHOPIFY', 'PRODUCTION', 'shop', 'encrypted', 'CONNECTED', now());
        INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
        VALUES ('SHOPIFY', 'history_import', 'complete', '2026-01-01T00:00:00Z'),
               ('SHOPIFY', 'orders', 'recent', '2026-09-01T00:00:00Z');
        WITH customer AS (
          INSERT INTO customers
            (kind, match_key, display_name, billing_address_json, source_confidence,
             review_required)
          VALUES ('PRIVATE_IT', 'shopify-replay', 'Cliente', '{}', 'TAX_ID', false)
          RETURNING id
        ), orders_inserted AS (
          INSERT INTO orders
            (provider, external_account_id, external_order_id, display_number,
             created_at_source, updated_at_source, local_order_date, currency, gross_amount,
             payment_status, fulfillment_status, trigger_status, customer_id,
             raw_snapshot_json, normalized_snapshot_json)
          SELECT 'SHOPIFY', 'shop', external_id, display_number, updated_at, updated_at,
                 updated_at::date, 'EUR', 1000, 'PAID', 'FULFILLED', 'NEEDS_REVIEW',
                 customer.id, '{}', jsonb_build_object(
                   'externalCustomerId', 'gid://shopify/Customer/3957-4027',
                   'sourceConflictRequired', source_conflict)
          FROM customer CROSS JOIN (VALUES
            ('with-tax', '#4027', '2026-08-17T14:57:48Z'::timestamptz, false),
            ('missing-tax', '#3957', '2026-07-07T20:41:14Z'::timestamptz, false),
            ('fulfillment-conflict', '#FULFILL', '2026-08-01T10:00:00Z'::timestamptz, true)
          ) AS seed(external_id, display_number, updated_at, source_conflict)
          RETURNING id, external_order_id
        )
        INSERT INTO order_tax_identifiers
          (order_id, type, raw_value, normalized_value, source_field)
        SELECT id, 'CODICE_FISCALE', 'RSSMRA80A01H501U', 'RSSMRA80A01H501U',
               'billingAddress.address2'
        FROM orders_inserted WHERE external_order_id = 'with-tax';
      `);
    });
    assert.ok(
      (await runMigrations({ connectionString: database.connectionString })).includes(
        SHOPIFY_IDENTITY_FULFILLMENT_REPLAY,
      ),
    );
    await withClient(database.connectionString, async (client) => {
      assert.deepEqual(
        (
          await client.query(
            `SELECT cursor, overlap_from::text FROM sync_cursors
             WHERE provider = 'SHOPIFY' AND stream = 'orders'`,
          )
        ).rows[0],
        { cursor: null, overlap_from: "2026-07-07 20:36:14+00" },
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

test("l'upgrade rilegge i conflitti Shopify dopo la normalizzazione dei default", async () => {
  const database = await temporaryDatabase("shopify_source_conflict_replay");
  const beforeReplay = await mkdtemp(path.join(os.tmpdir(), "hub-fatture-before-shopify-replay-"));
  try {
    await cp("migrations", beforeReplay, { recursive: true });
    await removeMigrationsFrom(beforeReplay, SHOPIFY_SOURCE_CONFLICT_REPLAY);
    await runMigrations({ connectionString: database.connectionString, directory: beforeReplay });
    await withClient(database.connectionString, async (client) => {
      await client.query(`
        INSERT INTO connections
          (provider, environment, account_reference, encrypted_credentials, status, last_synced_at)
        VALUES ('SHOPIFY', 'PRODUCTION', 'shop', 'encrypted', 'CONNECTED', now());
        INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
        VALUES ('SHOPIFY', 'history_import', 'complete', '2026-01-01T00:00:00Z'),
               ('SHOPIFY', 'orders', 'recent', '2026-09-04T10:00:00Z');
        WITH customer AS (
          INSERT INTO customers
            (kind, match_key, display_name, billing_address_json, source_confidence,
             review_required)
          VALUES ('PRIVATE_IT', 'shopify-source-conflict', 'Cliente', '{}', 'TAX_ID', false)
          RETURNING id
        )
        INSERT INTO orders
          (provider, external_account_id, external_order_id, display_number,
           created_at_source, updated_at_source, local_order_date, currency, gross_amount,
           payment_status, fulfillment_status, trigger_status, customer_id,
           raw_snapshot_json, normalized_snapshot_json)
        SELECT 'SHOPIFY', 'shop', 'source-conflict', '#SOURCE-CONFLICT',
               '2026-09-04T08:00:00Z', '2026-09-04T09:19:09Z', '2026-09-04',
               'EUR', 1000, 'PAID', 'FULFILLED', 'NEEDS_REVIEW', id, '{}',
               '{"sourceConflictRequired":true}'::jsonb
        FROM customer;
      `);
    });

    assert.deepEqual(
      await runMigrations({ connectionString: database.connectionString }),
      migrationsFrom(SHOPIFY_SOURCE_CONFLICT_REPLAY),
    );
    await withClient(database.connectionString, async (client) => {
      assert.deepEqual(
        (
          await client.query(
            `SELECT cursor, overlap_from = '2026-09-04T09:14:09Z'::timestamptz AS expected
             FROM sync_cursors WHERE provider = 'SHOPIFY' AND stream = 'orders'`,
          )
        ).rows[0],
        { cursor: null, expected: true },
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
