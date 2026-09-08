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
  EBAY_FULFILLMENT_CONFLICT_REPLAY,
  EBAY_PHONE_MAPPER_REPLAY,
  EBAY_NULL_EMAIL_ALIGNMENT_REPLAY,
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
    assert.ok(applied.includes(EBAY_NULL_EMAIL_ALIGNMENT_REPLAY));
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

test("l'upgrade elimina il telefono eBay serializzato come oggetto e rilegge gli ordini", async () => {
  const database = await temporaryDatabase("ebay_phone_mapper_replay");
  const beforeReplay = await mkdtemp(path.join(os.tmpdir(), "hub-fatture-before-ebay-phone-"));
  try {
    await copyMigrationSnapshot(beforeReplay);
    await runMigrations({ connectionString: database.connectionString, directory: beforeReplay });
    await withClient(database.connectionString, async (client) => {
      const customerId = (
        await client.query(
          `INSERT INTO customers
             (kind, match_key, display_name, phone, billing_address_json,
              source_confidence, review_required)
           VALUES ('PRIVATE_IT', 'ebay-phone-replay', 'Cliente', '[object Object]', '{}',
                   'TAX_ID', false)
           RETURNING id`,
        )
      ).rows[0].id;
      const caseId = (
        await client.query(
          `INSERT INTO billing_cases
             (customer_id, local_order_date, currency, status, customer_snapshot_json)
           VALUES ($1, '2026-09-08', 'EUR', 'READY',
             '{"phone":"[object Object]","canonicalProfile":{"phone":"[object object]"}}')
           RETURNING id`,
          [customerId],
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO connections
           (provider, environment, account_reference, encrypted_credentials, status,
            last_synced_at)
         VALUES ('EBAY', 'PRODUCTION', 'seller-phone', 'encrypted', 'CONNECTED',
                 '2026-09-08T10:00:00Z');
         INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
         VALUES ('EBAY', 'history_import', 'complete', '2026-01-01T00:00:00Z'),
                ('EBAY', 'orders', 'recent', '2026-09-08T09:00:00Z')`,
      );
      await client.query(
        `INSERT INTO orders
           (provider, external_account_id, external_order_id, display_number,
            created_at_source, updated_at_source, local_order_date, currency, gross_amount,
            payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
            raw_snapshot_json, normalized_snapshot_json)
         VALUES ('EBAY', 'seller-phone', 'phone-order', 'E-PHONE',
                 '2026-09-08T08:00:00Z', '2026-09-08T09:30:00Z', '2026-09-08',
                 'EUR', 1000, 'PAID', 'UNFULFILLED', 'GROUPED', $1, $2,
                 '{"customer":{"phone":"[object Object]"},"sourceSnapshot":{"fulfillmentStartInstructions":[{"shippingStep":{"shipTo":{"primaryPhone":{"phoneNumber":"+39 011 0000000"}}}}]}}',
                 '{"customer":{"phone":"[object Object]"},"customerSnapshot":{"phone":"[object Object]","canonicalProfile":{"phone":"[object object]"}}}')`,
        [customerId, caseId],
      );
      await client.query(
        `INSERT INTO customer_source_records
           (customer_id, provider, external_customer_id, raw_snapshot_json)
         VALUES ($1, 'EBAY', 'buyer-phone', '{"phone":"[object Object]"}')`,
        [customerId],
      );
      const unrelatedCustomerId = (
        await client.query(
          `INSERT INTO customers
             (kind, match_key, display_name, phone, billing_address_json,
              source_confidence, review_required)
           VALUES ('PRIVATE_IT', 'shopify-phone-marker', 'Altro cliente', '+39 02 0000000',
                   '{}', 'TAX_ID', false)
           RETURNING id`,
        )
      ).rows[0].id;
      const unrelatedCaseId = (
        await client.query(
          `INSERT INTO billing_cases
             (customer_id, local_order_date, currency, status, customer_snapshot_json)
           VALUES ($1, '2026-09-08', 'EUR', 'READY',
             '{"phone":"+39 02 0000000","canonicalProfile":{"phone":"+39020000000"}}')
           RETURNING id`,
          [unrelatedCustomerId],
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO orders
           (provider, external_account_id, external_order_id, display_number,
            created_at_source, updated_at_source, local_order_date, currency, gross_amount,
            payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
            raw_snapshot_json, normalized_snapshot_json)
         VALUES ('SHOPIFY', 'shop-phone', 'unrelated-phone-order', 'S-PHONE',
                 '2026-09-08T08:00:00Z', '2026-09-08T09:30:00Z', '2026-09-08',
                 'EUR', 1000, 'PAID', 'UNFULFILLED', 'GROUPED', $1, $2,
                 '{"customer":{"phone":"+39 02 0000000"}}',
                 '{"customerSnapshot":{"phone":"+39 02 0000000","canonicalProfile":{"phone":"+39020000000"}}}')`,
        [unrelatedCustomerId, unrelatedCaseId],
      );
      await client.query(
        `INSERT INTO customers
           (kind, match_key, display_name, phone, billing_address_json,
            source_confidence, review_required)
         VALUES ('PRIVATE_IT', 'orphan-phone-marker', 'Cliente storico', '[object Object]',
                 '{}', 'TAX_ID', false);

         INSERT INTO billing_cases
           (customer_id, local_order_date, currency, status, customer_snapshot_json)
         SELECT id, '2026-09-06', 'EUR', 'CLOSED',
                '{"displayName":"Caso orfano","phone":"[object Object]","canonicalProfile":{"phone":"[object object]"}}'
         FROM customers WHERE match_key = 'orphan-phone-marker';

         INSERT INTO billing_cases
           (customer_id, local_order_date, currency, status, customer_snapshot_json)
         SELECT id, '2026-09-07', 'EUR', 'CLOSED',
                '{"displayName":"Caso storico","phone":"+39 011 0000000","canonicalProfile":{"phone":"[object object]"}}'
         FROM customers WHERE match_key = 'ebay-phone-replay';

         INSERT INTO orders
           (provider, external_account_id, external_order_id, display_number,
            created_at_source, updated_at_source, local_order_date, currency, gross_amount,
            payment_status, fulfillment_status, trigger_status, customer_id,
            raw_snapshot_json, normalized_snapshot_json)
         VALUES ('EBAY', 'seller-phone', 'mixed-phone-order', 'E-MIXED-PHONE',
                 '2026-09-08T08:30:00Z', '2026-09-08T09:40:00Z', '2026-09-08',
                 'EUR', 1000, 'PAID', 'UNFULFILLED', 'GROUPED',
                 (SELECT id FROM customers WHERE match_key = 'ebay-phone-replay'),
                 '{"customer":{"phone":"+39 011 0000000"}}',
                 '{"customer":{"phone":"[object Object]"},"customerSnapshot":{"phone":"+39 011 0000000","canonicalProfile":{"phone":"[object object]"}}}')`,
      );
      assert.deepEqual(
        (
          await client.query(
            `SELECT external_order_id
             FROM orders
             WHERE provider = 'EBAY'
               AND nullif(btrim(raw_snapshot_json #>>
                 '{sourceSnapshot,fulfillmentStartInstructions,0,shippingStep,shipTo,primaryPhone,phoneNumber}'),
                 '') IS NOT NULL
             ORDER BY external_order_id`,
          )
        ).rows,
        [{ external_order_id: "phone-order" }],
      );
    });

    const applied = await runMigrations({ connectionString: database.connectionString });
    assert.ok(applied.includes(EBAY_PHONE_MAPPER_REPLAY));
    await withClient(database.connectionString, async (client) => {
      assert.deepEqual(
        (
          await client.query(
            `SELECT customers.phone,
                    customer_source_records.raw_snapshot_json ->> 'phone' AS source_phone,
                    billing_cases.customer_snapshot_json ->> 'phone' AS case_phone,
                    billing_cases.customer_snapshot_json #>> '{canonicalProfile,phone}'
                      AS case_canonical_phone,
                    orders.raw_snapshot_json #>> '{customer,phone}' AS raw_order_phone,
                    orders.normalized_snapshot_json #>> '{customerSnapshot,phone}'
                      AS normalized_phone,
                    orders.normalized_snapshot_json #>> '{customerSnapshot,canonicalProfile,phone}'
                      AS canonical_phone
             FROM orders
             JOIN customers ON customers.id = orders.customer_id
             JOIN billing_cases ON billing_cases.id = orders.billing_case_id
             JOIN customer_source_records ON customer_source_records.customer_id = customers.id
             WHERE orders.external_order_id = 'phone-order'`,
          )
        ).rows[0],
        {
          phone: null,
          source_phone: null,
          case_phone: null,
          case_canonical_phone: "",
          raw_order_phone: null,
          normalized_phone: null,
          canonical_phone: "",
        },
      );
      assert.deepEqual(
        (
          await client.query(
            `SELECT cursor, overlap_from::text
             FROM sync_cursors WHERE provider = 'EBAY' AND stream = 'orders'`,
          )
        ).rows[0],
        { cursor: null, overlap_from: "2026-09-08 09:00:00+00" },
      );
      assert.deepEqual(
        (
          await client.query(
            `SELECT customers.phone,
                    billing_cases.customer_snapshot_json ->> 'phone' AS case_phone
             FROM orders
             JOIN customers ON customers.id = orders.customer_id
             JOIN billing_cases ON billing_cases.id = orders.billing_case_id
             WHERE orders.external_order_id = 'unrelated-phone-order'`,
          )
        ).rows[0],
        { phone: "+39 02 0000000", case_phone: "+39 02 0000000" },
      );
      assert.deepEqual(
        (
          await client.query(
            `SELECT raw_snapshot_json #>> '{customer,phone}' AS raw_phone,
                    normalized_snapshot_json #>> '{customer,phone}' AS normalized_customer_phone,
                    normalized_snapshot_json #>> '{customerSnapshot,phone}' AS snapshot_phone,
                    normalized_snapshot_json #>> '{customerSnapshot,canonicalProfile,phone}'
                      AS canonical_phone
             FROM orders WHERE external_order_id = 'mixed-phone-order'`,
          )
        ).rows[0],
        {
          raw_phone: "+39 011 0000000",
          normalized_customer_phone: null,
          snapshot_phone: "+39 011 0000000",
          canonical_phone: "",
        },
      );
      assert.deepEqual(
        (
          await client.query(
            `SELECT customer_snapshot_json ->> 'phone' AS phone,
                    customer_snapshot_json #>> '{canonicalProfile,phone}' AS canonical_phone
             FROM billing_cases
             WHERE customer_snapshot_json ->> 'displayName' = 'Caso storico'`,
          )
        ).rows[0],
        { phone: "+39 011 0000000", canonical_phone: "" },
      );
      assert.deepEqual(
        (
          await client.query(
            `SELECT
               (SELECT count(*)::integer FROM customers
                WHERE phone = '[object Object]') AS customer_markers,
               (SELECT count(*)::integer FROM billing_cases
                WHERE customer_snapshot_json ->> 'phone' = '[object Object]'
                   OR customer_snapshot_json #>> '{canonicalProfile,phone}' =
                     '[object object]') AS case_markers`,
          )
        ).rows[0],
        { customer_markers: 0, case_markers: 0 },
      );
    });
  } finally {
    await rm(beforeReplay, { recursive: true, force: true });
    await database.drop();
  }
});

test("l'upgrade rilegge i conflitti eBay per riallineare l'evasione", async () => {
  const database = await temporaryDatabase("ebay_fulfillment_conflict_replay");
  const beforeReplay = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-ebay-fulfillment-replay-"),
  );
  try {
    await copyMigrationSnapshot(beforeReplay);
    await runMigrations({ connectionString: database.connectionString, directory: beforeReplay });
    await withClient(database.connectionString, async (client) => {
      await client.query(
        `INSERT INTO connections
           (provider, environment, account_reference, encrypted_credentials, status,
            last_synced_at)
         VALUES ('EBAY', 'PRODUCTION', 'seller-fulfillment', 'encrypted', 'CONNECTED',
                 '2026-09-08T08:00:00Z');
         INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
         VALUES
           ('EBAY', 'history_import', 'complete', '2026-01-01T00:00:00Z'),
           ('EBAY', 'orders', 'recent', '2026-09-08T07:00:00Z')`,
      );
      const customerId = (
        await client.query(
          `INSERT INTO customers
             (kind, match_key, display_name, billing_address_json, source_confidence,
              review_required)
           VALUES ('PRIVATE_IT', 'ebay-fulfillment-replay', 'Cliente', '{}', 'TAX_ID', false)
           RETURNING id`,
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO orders
           (provider, external_account_id, external_order_id, display_number,
            created_at_source, updated_at_source, local_order_date, currency, gross_amount,
            payment_status, fulfillment_status, trigger_status, customer_id,
            raw_snapshot_json, normalized_snapshot_json)
         VALUES ('EBAY', 'seller-fulfillment', 'fulfillment-order', 'E-FULFILLMENT',
                 '2026-09-07T08:00:00Z', '2026-09-07T09:25:12Z', '2026-09-07',
                 'EUR', 3185, 'PAID', 'FULFILLED', 'NEEDS_REVIEW', $1, '{}',
                 '{"sourceConflictRequired":true}'::jsonb)`,
        [customerId],
      );
    });

    const applied = await runMigrations({ connectionString: database.connectionString });
    assert.ok(applied.includes(EBAY_FULFILLMENT_CONFLICT_REPLAY));
    await withClient(database.connectionString, async (client) => {
      assert.deepEqual(
        (
          await client.query(
            `SELECT cursor, overlap_from::text
             FROM sync_cursors WHERE provider = 'EBAY' AND stream = 'orders'`,
          )
        ).rows[0],
        { cursor: null, overlap_from: "2026-09-07 09:20:12+00" },
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
