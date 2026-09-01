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
  AUTOMATIC_CUSTOMER_IDENTITY_EXCEPTIONS,
  removeMigrationsFrom,
} from "./support.ts";

test("l'upgrade conserva le deroghe manuali e pianifica il replay automatico eBay", async () => {
  const database = await temporaryDatabase("automatic_customer_identity_exceptions");
  const beforeAutomatic = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-automatic-identity-exceptions-"),
  );
  try {
    await cp("migrations", beforeAutomatic, { recursive: true });
    await removeMigrationsFrom(beforeAutomatic, AUTOMATIC_CUSTOMER_IDENTITY_EXCEPTIONS);
    await runMigrations({
      connectionString: database.connectionString,
      directory: beforeAutomatic,
    });
    await withClient(database.connectionString, async (client) => {
      const userId = (
        await client.query(
          `INSERT INTO users (username, password_hash, can_approve)
           VALUES ('Massimo', 'synthetic-password-hash', true) RETURNING id`,
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO connections
           (provider, environment, account_reference, encrypted_credentials, status,
            last_synced_at)
         VALUES ('EBAY', 'PRODUCTION', 'seller-automatic', 'encrypted', 'CONNECTED',
                 '2026-09-01T08:00:00Z');
         INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
         VALUES ('EBAY', 'history_import', 'complete', '2026-01-01T00:00:00Z'),
                ('EBAY', 'orders', 'recent', '2026-09-01T00:00:00Z')`,
      );
      const customerId = (
        await client.query(
          `INSERT INTO customers
             (kind, match_key, display_name, billing_address_json, source_confidence,
              review_required)
           VALUES ('PRIVATE_IT', 'automatic-replay', 'Cliente', '{}', 'TAX_ID', true)
           RETURNING id`,
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO orders
           (provider, external_account_id, external_order_id, display_number,
            created_at_source, updated_at_source, local_order_date, currency, gross_amount,
            payment_status, fulfillment_status, trigger_status, customer_id,
            raw_snapshot_json, normalized_snapshot_json)
         VALUES ('EBAY', 'seller-automatic', 'automatic-order', 'E-AUTO',
                 '2026-08-20T09:00:00Z', '2026-08-20T10:00:00Z', '2026-08-20',
                 'EUR', 1000, 'PAID', 'FULFILLED', 'NEEDS_REVIEW', $1, '{}', '{}')`,
        [customerId],
      );
      await client.query(
        `INSERT INTO customer_identity_exceptions
           (provider, external_customer_id, source_identity_sha256, first_name, last_name,
            accepted_by)
         VALUES ('EBAY', 'historical-manual', repeat('a', 64), 'Mario', 'Rossi', $1)`,
        [userId],
      );
    });

    const applied = await runMigrations({ connectionString: database.connectionString });
    assert.ok(applied.includes(AUTOMATIC_CUSTOMER_IDENTITY_EXCEPTIONS));
    await withClient(database.connectionString, async (client) => {
      assert.deepEqual(
        (
          await client.query(
            `SELECT decision_mode, accepted_by IS NOT NULL AS has_actor
             FROM customer_identity_exceptions
             WHERE external_customer_id = 'historical-manual'`,
          )
        ).rows[0],
        { decision_mode: "MANUAL", has_actor: true },
      );
      assert.deepEqual(
        (
          await client.query(
            `SELECT cursor, overlap_from::text FROM sync_cursors
             WHERE provider = 'EBAY' AND stream = 'orders'`,
          )
        ).rows[0],
        { cursor: null, overlap_from: "2026-08-20 09:55:00+00" },
      );
    });
  } finally {
    await rm(beforeAutomatic, { recursive: true, force: true });
    await database.drop();
  }
});
