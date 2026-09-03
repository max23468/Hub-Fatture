import {
  assert,
  cp,
  copyMigrationSnapshot,
  EBAY_PARTIAL_REFUND_PAYMENT_STATUS,
  EBAY_SHIPPING_REFUND_REPLAY,
  EBAY_REFUND_MAPPER_CONFLICT_REPLAY,
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

test("l'upgrade non confonde il rimborso parziale eBay con un pagamento pendente", async () => {
  const database = await temporaryDatabase("ebay_partial_refund_payment_status");
  const beforeFix = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-ebay-partial-refund-"),
  );
  try {
    await cp("migrations", beforeFix, { recursive: true });
    await removeMigrationsFrom(beforeFix, EBAY_PARTIAL_REFUND_PAYMENT_STATUS);
    await runMigrations({ connectionString: database.connectionString, directory: beforeFix });
    await withClient(database.connectionString, async (client) => {
      const customerId = (
        await client.query(
          `INSERT INTO customers
             (kind, match_key, display_name, billing_address_json, source_confidence,
              review_required)
           VALUES ('EU', 'ebay-partial-refund', 'Cliente', '{}', 'EXACT_PROFILE', false)
           RETURNING id`,
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO orders
           (provider, external_account_id, external_order_id, display_number,
            created_at_source, updated_at_source, local_order_date, currency, gross_amount,
            payment_status, fulfillment_status, trigger_status, customer_id,
            raw_snapshot_json, normalized_snapshot_json)
         VALUES
           ('EBAY', 'seller', 'partial-refund', '62187', now(), now(), current_date,
            'EUR', 3698, 'PENDING', 'FULFILLED', 'INVOICED', $1,
            '{"paymentStatus":"PENDING","sourceSnapshot":{"orderPaymentStatus":"PARTIALLY_REFUNDED"}}',
            '{"paymentStatus":"PENDING"}'),
           ('EBAY', 'seller', 'pending', '62188', now(), now(), current_date,
            'EUR', 3698, 'PENDING', 'UNFULFILLED', 'WAITING_FOR_TRIGGER', $1,
            '{"paymentStatus":"PENDING","sourceSnapshot":{"orderPaymentStatus":"PENDING"}}',
            '{"paymentStatus":"PENDING"}')`,
        [customerId],
      );
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      EBAY_PARTIAL_REFUND_PAYMENT_STATUS,
      "067_ebay_order_line_identity.sql",
    ]);
    await withClient(database.connectionString, async (client) => {
      assert.deepEqual(
        (
          await client.query(
            `SELECT external_order_id, payment_status,
                    raw_snapshot_json ->> 'paymentStatus' AS raw_payment_status,
                    normalized_snapshot_json ->> 'paymentStatus' AS normalized_payment_status
             FROM orders ORDER BY external_order_id`,
          )
        ).rows,
        [
          {
            external_order_id: "partial-refund",
            payment_status: "PAID",
            raw_payment_status: "PAID",
            normalized_payment_status: "PAID",
          },
          {
            external_order_id: "pending",
            payment_status: "PENDING",
            raw_payment_status: "PENDING",
            normalized_payment_status: "PENDING",
          },
        ],
      );
    });
  } finally {
    await rm(beforeFix, { recursive: true, force: true });
    await database.drop();
  }
});

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

test("l'upgrade rilegge i conflitti del mapper rimborso eBay già deterministici", async () => {
  const database = await temporaryDatabase("ebay_refund_mapper_conflict_replay");
  const beforeReplay = await mkdtemp(path.join(os.tmpdir(), "hub-fatture-before-ebay-mapper-"));
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
           VALUES ('EU', 'ebay-refund-mapper', 'Cliente', '{}', 'EXACT_PROFILE', false)
           RETURNING id`,
        )
      ).rows[0].id;
      const caseId = (
        await client.query(
          `INSERT INTO billing_cases
             (customer_id, local_order_date, currency, status, customer_snapshot_json)
           VALUES ($1, '2026-08-19', 'EUR', 'NEEDS_REVIEW', '{}')
           RETURNING id`,
          [customerId],
        )
      ).rows[0].id;
      const orderId = (
        await client.query(
          `INSERT INTO orders
             (provider, external_account_id, external_order_id, display_number,
              created_at_source, updated_at_source, local_order_date, currency, gross_amount,
              payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
              raw_snapshot_json, normalized_snapshot_json)
           VALUES ('EBAY', 'seller', 'refund-mapper-conflict', '106',
                   '2026-08-19T09:00:00Z', '2026-08-19T10:00:00Z', '2026-08-19',
                   'EUR', 3698, 'PAID', 'FULFILLED', 'GROUPED', $1, $2, '{}',
                   jsonb_build_object(
                     'provider', 'EBAY',
                     'sourceConflictRequired', true,
                     'orderReviewRequired', false,
                     'reviewFingerprint', 'after'))
           RETURNING id`,
          [customerId, caseId],
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO order_source_revisions
           (order_id, billing_case_id, previous_normalized_snapshot_json,
            current_normalized_snapshot_json)
         VALUES (
           $1, $2,
           jsonb_build_object(
             'provider', 'EBAY',
             'sourceSnapshot', '{"payload":"same"}'::jsonb,
             'reviewFingerprint', 'before',
             'refunds', jsonb_build_array(jsonb_build_object(
               'externalRefundId', 'refund-1', 'status', 'AMBIGUOUS', 'amount', NULL,
               'completedAt', '2026-08-19T09:30:00Z',
               'raw', '{"amount":{"value":"7.98"}}'::jsonb))),
           jsonb_build_object(
             'provider', 'EBAY',
             'sourceSnapshot', '{"payload":"same"}'::jsonb,
             'reviewFingerprint', 'after',
             'refunds', jsonb_build_array(jsonb_build_object(
               'externalRefundId', 'refund-1', 'status', 'COMPLETED', 'amount', '9.00',
               'completedAt', '2026-08-19T09:30:00Z',
               'raw', '{"amount":{"value":"7.98"}}'::jsonb))))`,
        [orderId, caseId],
      );
    });

    const applied = await runMigrations({ connectionString: database.connectionString });
    assert.ok(applied.includes(EBAY_REFUND_MAPPER_CONFLICT_REPLAY));
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
