import {
  assert,
  cp,
  EBAY_CARE_OF_ADDRESS_REPLAY,
  EBAY_PAYMENT_TIMESTAMP_REPLAY,
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

test("l'upgrade rilegge soltanto i c/o eBay non corretti manualmente", async () => {
  const database = await temporaryDatabase("ebay_care_of_address_replay");
  const beforeReplay = await mkdtemp(path.join(os.tmpdir(), "hub-fatture-before-care-of-replay-"));
  try {
    await cp("migrations", beforeReplay, { recursive: true });
    await removeMigrationsFrom(beforeReplay, EBAY_CARE_OF_ADDRESS_REPLAY);
    await runMigrations({ connectionString: database.connectionString, directory: beforeReplay });
    await withClient(database.connectionString, async (client) => {
      await client.query(`
        INSERT INTO connections
          (provider, environment, account_reference, encrypted_credentials, status, last_synced_at)
        VALUES ('EBAY', 'PRODUCTION', 'seller', 'encrypted', 'CONNECTED', now());
        INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
        VALUES ('EBAY', 'history_import', 'complete', '2026-01-01T00:00:00Z'),
               ('EBAY', 'orders', 'recent', '2026-09-01T00:00:00Z');
        WITH inserted_customers AS (
          INSERT INTO customers
            (kind, match_key, display_name, billing_address_json, source_confidence,
             review_required)
          VALUES
            ('UNKNOWN', 'care-of-automatic', 'Cliente automatico', '{}', 'AMBIGUOUS', true),
            ('UNKNOWN', 'care-of-manual', 'Cliente manuale', '{}', 'AMBIGUOUS', true)
          RETURNING id, match_key
        ), inserted_cases AS (
          INSERT INTO billing_cases
            (customer_id, local_order_date, currency, status, customer_snapshot_json,
             customer_corrected_at)
          SELECT id,
                 CASE match_key WHEN 'care-of-automatic' THEN '2026-08-20'::date
                                ELSE '2026-08-10'::date END,
                 'EUR', 'NEEDS_REVIEW', '{}',
                 CASE WHEN match_key = 'care-of-manual' THEN now() END
          FROM inserted_customers
          RETURNING id, customer_id, local_order_date
        )
        INSERT INTO orders
          (provider, external_account_id, external_order_id, display_number,
           created_at_source, updated_at_source, local_order_date, currency, gross_amount,
           payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
           raw_snapshot_json, normalized_snapshot_json)
        SELECT 'EBAY', 'seller', 'order-' || customer_id::text, 'E-' || customer_id::text,
               local_order_date::timestamptz, local_order_date::timestamptz + interval '10 hours',
               local_order_date, 'EUR', 1000, 'PAID', 'FULFILLED', 'GROUPED', customer_id, id,
               '{"sourceSnapshot":{"fulfillmentStartInstructions":[{"shippingStep":{"shipTo":{"fullName":"Mario Rossi c/o Anna Bianchi"}}}]}}'::jsonb,
               '{}'
        FROM inserted_cases;
      `);
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      EBAY_CARE_OF_ADDRESS_REPLAY,
      EBAY_PAYMENT_TIMESTAMP_REPLAY,
    ]);
    await withClient(database.connectionString, async (client) => {
      assert.deepEqual(
        (
          await client.query(
            `SELECT cursor, overlap_from::text FROM sync_cursors
             WHERE provider='EBAY' AND stream='orders'`,
          )
        ).rows[0],
        { cursor: null, overlap_from: "2026-08-20 09:55:00+00" },
      );
    });
  } finally {
    await rm(beforeReplay, { recursive: true, force: true });
    await database.drop();
  }
});
