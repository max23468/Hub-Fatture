import {
  assert,
  cp,
  mkdtemp,
  rm,
  os,
  path,
  test,
  runMigrations,
  temporaryDatabase,
  withClient,
  SWITZERLAND_CUSTOMER_SUPPORT,
  OPERATIONAL_CONTROLS,
  EBAY_CONTROL_ALIGNMENT_REPLAY,
  removeMigrationsFrom,
} from "./migrations-scenarios/support.ts";

test("l'upgrade abilita i clienti svizzeri e riprende il canale bloccato", async () => {
  const database = await temporaryDatabase("switzerland_customer_support");
  const beforeSupport = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-switzerland-customer-support-"),
  );
  try {
    await cp("migrations", beforeSupport, { recursive: true });
    await removeMigrationsFrom(beforeSupport, SWITZERLAND_CUSTOMER_SUPPORT);
    await runMigrations({ connectionString: database.connectionString, directory: beforeSupport });
    await withClient(database.connectionString, async (client) => {
      await client.query(
        `INSERT INTO connections
           (provider, environment, account_reference, encrypted_credentials, status,
            last_checked_at, last_synced_at, last_error_code, last_error_message_sanitized)
         VALUES ('SHOPIFY', 'PRODUCTION', 'shop.example', 'encrypted', 'ERROR',
                 '2026-08-30T19:40:00Z', '2026-08-30T18:32:00Z',
                 'PROVIDER_RESPONSE_INVALID', 'PROVIDER_RESPONSE_INVALID')`,
      );
      await client.query(
        `INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
         VALUES
           ('SHOPIFY', 'history_import', 'complete', '2026-08-23T00:00:00Z'),
           ('SHOPIFY', 'orders', 'blocked-page', '2026-08-30T19:00:00Z')`,
      );
      await client.query(
        `INSERT INTO jobs
           (type, status, run_at, locked_at, attempts, last_error_code)
         VALUES ('shopify_process_webhook', 'FAILED', '2026-08-30T18:40:00Z',
                 '2026-08-30T18:40:00Z', 1, 'PROVIDER_RESPONSE_INVALID')`,
      );
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      SWITZERLAND_CUSTOMER_SUPPORT,
      OPERATIONAL_CONTROLS,
      EBAY_CONTROL_ALIGNMENT_REPLAY,
    ]);
    await withClient(database.connectionString, async (client) => {
      const inserted = await client.query(
        `INSERT INTO customers
           (kind, match_key, display_name, billing_address_json, source_confidence,
            review_required)
         VALUES ('NON_EU', 'swiss-customer', 'Cliente svizzero', '{}', 'EXACT_PROFILE', false)
         RETURNING kind`,
      );
      assert.equal(inserted.rows[0].kind, "NON_EU");
      assert.deepEqual(
        (
          await client.query(
            `SELECT status, last_synced_at, last_error_code
             FROM connections WHERE provider = 'SHOPIFY'`,
          )
        ).rows[0],
        { status: "CONNECTED", last_synced_at: null, last_error_code: null },
      );
      assert.deepEqual(
        (
          await client.query(
            `SELECT cursor, overlap_from::text
             FROM sync_cursors WHERE provider = 'SHOPIFY' AND stream = 'orders'`,
          )
        ).rows[0],
        { cursor: null, overlap_from: "2026-08-30 18:35:00+00" },
      );
    });
  } finally {
    await rm(beforeSupport, { recursive: true, force: true });
    await database.drop();
  }
});
