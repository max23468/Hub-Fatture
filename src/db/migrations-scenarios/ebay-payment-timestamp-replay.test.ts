import {
  assert,
  cp,
  EBAY_PAYMENT_TIMESTAMP_REPLAY,
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

test("l'upgrade rilegge i conflitti eBay candidati allo slittamento del pagamento", async () => {
  const database = await temporaryDatabase("ebay_payment_timestamp_replay");
  const beforeReplay = await mkdtemp(path.join(os.tmpdir(), "hub-fatture-before-payment-time-"));
  try {
    await cp("migrations", beforeReplay, { recursive: true });
    await removeMigrationsFrom(beforeReplay, EBAY_PAYMENT_TIMESTAMP_REPLAY);
    await runMigrations({ connectionString: database.connectionString, directory: beforeReplay });
    await withClient(database.connectionString, async (client) => {
      await client.query(`
        INSERT INTO connections
          (provider, environment, account_reference, encrypted_credentials, status, last_synced_at)
        VALUES ('EBAY', 'PRODUCTION', 'seller', 'encrypted', 'CONNECTED', now());
        INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
        VALUES ('EBAY', 'history_import', 'complete', '2026-01-01T00:00:00Z'),
               ('EBAY', 'orders', 'recent', '2026-09-01T00:00:00Z');
        WITH customer AS (
          INSERT INTO customers
            (kind, match_key, display_name, billing_address_json, source_confidence,
             review_required)
          VALUES ('UNKNOWN', 'payment-time', 'Cliente', '{}', 'AMBIGUOUS', false)
          RETURNING id
        ), billing_case AS (
          INSERT INTO billing_cases
            (customer_id, local_order_date, currency, status, customer_snapshot_json)
          SELECT id, '2026-08-20', 'EUR', 'NEEDS_REVIEW', '{}' FROM customer
          RETURNING id, customer_id
        ), inserted_order AS (
          INSERT INTO orders
            (provider, external_account_id, external_order_id, display_number,
             created_at_source, updated_at_source, local_order_date, currency, gross_amount,
             payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
             raw_snapshot_json, normalized_snapshot_json)
          SELECT 'EBAY', 'seller', 'payment-time', 'E-1', '2026-08-20T08:00:00Z',
                 '2026-08-20T10:00:00Z', '2026-08-20', 'EUR', 1000, 'PAID', 'FULFILLED',
                 'NEEDS_REVIEW', customer_id, id, '{}',
                 '{"sourceConflictRequired":true,"orderReviewRequired":false}'::jsonb
          FROM billing_case
          RETURNING id, billing_case_id
        )
        INSERT INTO order_source_revisions
          (order_id, billing_case_id, previous_normalized_snapshot_json,
           current_normalized_snapshot_json)
        SELECT id, billing_case_id,
               '{"provider":"EBAY","payments":[{"paidAt":"2026-08-20T09:00:00Z"}],"reviewFingerprint":"before","sourceSnapshot":{},"updatedAt":"2026-08-20T09:00:00Z"}'::jsonb,
               '{"provider":"EBAY","payments":[{"paidAt":"2026-08-20T09:00:01Z"}],"reviewFingerprint":"after","sourceSnapshot":{},"updatedAt":"2026-08-20T09:00:01Z"}'::jsonb
        FROM inserted_order;
      `);
    });

    assert.deepEqual(
      await runMigrations({ connectionString: database.connectionString }),
      migrationsFrom(EBAY_PAYMENT_TIMESTAMP_REPLAY),
    );
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
