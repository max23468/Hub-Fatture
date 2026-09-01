import {
  assert,
  copyMigrationSnapshot,
  mkdtemp,
  os,
  path,
  rm,
  runMigrations,
  SHOPIFY_PRIVATE_RECIPIENT_REPLAY,
  temporaryDatabase,
  test,
  withClient,
} from "./support.ts";

test("l'upgrade rilegge i destinatari Shopify privati classificati come azienda", async () => {
  const database = await temporaryDatabase("shopify_private_recipient_replay");
  const beforeReplay = await mkdtemp(path.join(os.tmpdir(), "hub-fatture-before-private-replay-"));
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
          VALUES ('BUSINESS_IT', 'shopify-private-replay', 'Mario Rossi', '{}', 'TAX_ID', true)
          RETURNING id
        )
        INSERT INTO orders
          (provider, external_account_id, external_order_id, display_number,
           created_at_source, updated_at_source, local_order_date, currency, gross_amount,
           payment_status, fulfillment_status, trigger_status, customer_id,
           raw_snapshot_json, normalized_snapshot_json)
        SELECT 'SHOPIFY', 'shop', external_id, display_number, updated_at, updated_at,
               updated_at::date, 'EUR', 1000, 'PAID', 'FULFILLED', 'NEEDS_REVIEW',
               customer.id, '{}', snapshot
        FROM customer CROSS JOIN (VALUES
          ('unrelated', '#OLD', '2026-07-01T10:00:00Z'::timestamptz,
           '{"customerSnapshot":{"kind":"PRIVATE_IT"}}'::jsonb),
          ('affected', '#PRIVATE', '2026-08-20T10:00:00Z'::timestamptz,
           '{"customerSnapshot":{"kind":"BUSINESS_IT","firstName":"Mario",
             "lastName":"Rossi","companyName":"Testo libero",
             "billingAddress":{"countryCode":"IT"},
             "taxIdentifiers":[{"type":"CODICE_FISCALE","value":"RSSMRA80A01H501U"}]}}'::jsonb)
        ) AS seed(external_id, display_number, updated_at, snapshot);
      `);
    });
    assert.ok(
      (await runMigrations({ connectionString: database.connectionString })).includes(
        SHOPIFY_PRIVATE_RECIPIENT_REPLAY,
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
        { cursor: null, overlap_from: "2026-08-20 09:55:00+00" },
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
