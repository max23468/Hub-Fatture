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
  FISCAL_IDENTIFIER_BACKFILL,
  SHOPIFY_RECIPIENT_RECLASSIFICATION,
  EBAY_PAYMENT_RECONCILIATION,
  EBAY_REFUND_DEDUPLICATION,
  RETENTION_POLICY,
  REMOVE_ARUBA_UPLOAD_PROTECTION,
  CUSTOMER_EMAIL_DISABLED,
  CUSTOMER_REVIEW_CLEANUP,
  ARUBA_CANARY_PERMIT,
  ARUBA_INBOUND_RECONCILIATION,
  SHOPIFY_SHIPPING_IDENTITY_REPLAY,
  REMOVE_ARUBA_SEND_PERMITS,
  SUPPORT_SAFARI_ARUBA_READ_SYNC,
  ARUBA_STATUS_MAPPER_VERSION,
  ARUBA_API_INBOUND,
  ARUBA_REJECTED_ATTEMPT_IDENTITY,
  ARUBA_API_TRAFFIC_GUARD,
  ARUBA_API_AUTHORITY_CUTOVER,
  ARUBA_P7M_PARITY_NORMALIZATION,
  ARUBA_API_OUTBOUND,
  MIGRATIONS_AFTER_ARUBA_API_OUTBOUND,
  copyMigrationSnapshot,
} from "./support.ts";

test("l'upgrade riallinea automaticamente gli identificativi fiscali storici", async () => {
  const database = await temporaryDatabase("fiscal_identifier_backfill");
  const beforeBackfill = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-fiscal-identifier-backfill-"),
  );
  try {
    await copyMigrationSnapshot(beforeBackfill);
    await rm(path.join(beforeBackfill, FISCAL_IDENTIFIER_BACKFILL));
    await rm(path.join(beforeBackfill, SHOPIFY_RECIPIENT_RECLASSIFICATION));
    await rm(path.join(beforeBackfill, EBAY_PAYMENT_RECONCILIATION));
    await rm(path.join(beforeBackfill, EBAY_REFUND_DEDUPLICATION));
    await rm(path.join(beforeBackfill, RETENTION_POLICY));
    await rm(path.join(beforeBackfill, CUSTOMER_EMAIL_DISABLED));
    await rm(path.join(beforeBackfill, CUSTOMER_REVIEW_CLEANUP));
    await rm(path.join(beforeBackfill, ARUBA_CANARY_PERMIT));
    await rm(path.join(beforeBackfill, ARUBA_INBOUND_RECONCILIATION));
    await rm(path.join(beforeBackfill, SHOPIFY_SHIPPING_IDENTITY_REPLAY));
    await rm(path.join(beforeBackfill, REMOVE_ARUBA_SEND_PERMITS));
    await rm(path.join(beforeBackfill, REMOVE_ARUBA_UPLOAD_PROTECTION));
    await runMigrations({
      connectionString: database.connectionString,
      directory: beforeBackfill,
    });
    await withClient(database.connectionString, async (client) => {
      await client.query(
        `INSERT INTO connections
           (provider, environment, account_reference, encrypted_credentials, status,
            last_synced_at)
         VALUES
           ('SHOPIFY', 'PRODUCTION', 'shop.example', 'encrypted', 'CONNECTED', now()),
           ('EBAY', 'PRODUCTION', 'seller', 'encrypted', 'CONNECTED', now())`,
      );
      await client.query(
        `INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
         VALUES
           ('SHOPIFY', 'history_import', 'complete', '2026-01-01T00:00:00Z'),
           ('EBAY', 'history_import', 'complete', '2026-01-01T00:00:00Z'),
           ('SHOPIFY', 'orders', 'recent', '2026-08-12T10:00:00Z'),
           ('EBAY', 'orders', 'older-replay', '2025-12-01T00:00:00Z')`,
      );
      const customerId = (
        await client.query(
          `INSERT INTO customers
             (kind, match_key, display_name, billing_address_json, source_confidence,
              review_required)
           VALUES ('UNKNOWN', 'fiscal-backfill', 'Cliente', '{}', 'AMBIGUOUS', true)
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
           ('SHOPIFY', 'shop.example', 'shop-order', '#S', '2026-01-02T10:00:00Z',
            '2026-01-03T10:00:00Z', '2026-01-02', 'EUR', 1000, 'PAID', 'FULFILLED',
            'ELIGIBLE', $1, '{}', '{}'),
           ('EBAY', 'seller', 'ebay-order', '#E', '2026-02-02T11:00:00Z',
            '2026-02-03T11:00:00Z', '2026-02-02', 'EUR', 2000, 'PAID', 'FULFILLED',
            'ELIGIBLE', $1, '{}', '{}')`,
        [customerId],
      );
      await client.query("INSERT INTO jobs (type) VALUES ('shopify_sync_orders')");
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      FISCAL_IDENTIFIER_BACKFILL,
      SHOPIFY_RECIPIENT_RECLASSIFICATION,
      EBAY_PAYMENT_RECONCILIATION,
      EBAY_REFUND_DEDUPLICATION,
      RETENTION_POLICY,
      REMOVE_ARUBA_UPLOAD_PROTECTION,
      CUSTOMER_EMAIL_DISABLED,
      CUSTOMER_REVIEW_CLEANUP,
      ARUBA_CANARY_PERMIT,
      ARUBA_INBOUND_RECONCILIATION,
      SHOPIFY_SHIPPING_IDENTITY_REPLAY,
      REMOVE_ARUBA_SEND_PERMITS,
      SUPPORT_SAFARI_ARUBA_READ_SYNC,
      ARUBA_STATUS_MAPPER_VERSION,
      ARUBA_API_INBOUND,
      ARUBA_REJECTED_ATTEMPT_IDENTITY,
      ARUBA_API_TRAFFIC_GUARD,
      ARUBA_API_AUTHORITY_CUTOVER,
      ARUBA_P7M_PARITY_NORMALIZATION,
      ARUBA_API_OUTBOUND,
      ...MIGRATIONS_AFTER_ARUBA_API_OUTBOUND,
    ]);
    await withClient(database.connectionString, async (client) => {
      assert.deepEqual(
        (
          await client.query(
            `SELECT provider, cursor, overlap_from::text
             FROM sync_cursors WHERE stream = 'orders' ORDER BY provider`,
          )
        ).rows,
        [
          {
            provider: "EBAY",
            cursor: null,
            overlap_from: "2025-12-01 00:00:00+00",
          },
          {
            provider: "SHOPIFY",
            cursor: null,
            overlap_from: "2026-01-03 09:55:00+00",
          },
        ],
      );
      assert.deepEqual(
        (
          await client.query(
            `SELECT provider, last_synced_at
             FROM connections ORDER BY provider`,
          )
        ).rows,
        [
          { provider: "EBAY", last_synced_at: null },
          { provider: "SHOPIFY", last_synced_at: null },
        ],
      );
      assert.equal(
        (
          await client.query(
            `SELECT count(*) FROM jobs
             WHERE type = 'shopify_sync_orders' AND status IN ('PENDING', 'RUNNING')`,
          )
        ).rows[0].count,
        "1",
      );
    });
  } finally {
    await rm(beforeBackfill, { recursive: true, force: true });
    await database.drop();
  }
});

test("l'upgrade rilegge soltanto i destinatari Shopify già importati", async () => {
  const database = await temporaryDatabase("shopify_recipient_reclassification");
  const beforeReclassification = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-shopify-recipient-reclassification-"),
  );
  try {
    await copyMigrationSnapshot(beforeReclassification);
    await rm(path.join(beforeReclassification, SHOPIFY_RECIPIENT_RECLASSIFICATION));
    await rm(path.join(beforeReclassification, EBAY_PAYMENT_RECONCILIATION));
    await rm(path.join(beforeReclassification, EBAY_REFUND_DEDUPLICATION));
    await rm(path.join(beforeReclassification, RETENTION_POLICY));
    await rm(path.join(beforeReclassification, CUSTOMER_EMAIL_DISABLED));
    await rm(path.join(beforeReclassification, CUSTOMER_REVIEW_CLEANUP));
    await rm(path.join(beforeReclassification, ARUBA_CANARY_PERMIT));
    await rm(path.join(beforeReclassification, ARUBA_INBOUND_RECONCILIATION));
    await rm(path.join(beforeReclassification, SHOPIFY_SHIPPING_IDENTITY_REPLAY));
    await rm(path.join(beforeReclassification, REMOVE_ARUBA_SEND_PERMITS));
    await rm(path.join(beforeReclassification, REMOVE_ARUBA_UPLOAD_PROTECTION));
    await runMigrations({
      connectionString: database.connectionString,
      directory: beforeReclassification,
    });
    await withClient(database.connectionString, async (client) => {
      await client.query(
        `INSERT INTO connections
           (provider, environment, account_reference, encrypted_credentials, status,
            last_synced_at)
         VALUES
           ('SHOPIFY', 'PRODUCTION', 'shop.example', 'encrypted', 'CONNECTED',
            '2026-08-12T12:00:00Z'),
           ('EBAY', 'PRODUCTION', 'seller', 'encrypted', 'CONNECTED',
            '2026-08-12T12:00:00Z')`,
      );
      await client.query(
        `INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
         VALUES
           ('SHOPIFY', 'history_import', 'complete', '2026-01-01T00:00:00Z'),
           ('EBAY', 'history_import', 'complete', '2026-01-01T00:00:00Z'),
           ('SHOPIFY', 'orders', 'shopify-recent', '2026-08-12T10:00:00Z'),
           ('EBAY', 'orders', 'ebay-recent', '2026-08-12T10:00:00Z')`,
      );
      const customerId = (
        await client.query(
          `INSERT INTO customers
             (kind, match_key, display_name, billing_address_json, source_confidence,
              review_required)
           VALUES ('UNKNOWN', 'recipient-reclassification', 'Cliente', '{}', 'AMBIGUOUS', true)
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
           ('SHOPIFY', 'shop.example', 'shop-order', '#S', '2026-08-01T09:00:00Z',
            '2026-08-02T10:00:00Z', '2026-08-01', 'EUR', 1000, 'PAID', 'FULFILLED',
            'ELIGIBLE', $1, '{}', '{}'),
           ('EBAY', 'seller', 'ebay-order', '#E', '2026-08-03T09:00:00Z',
            '2026-08-04T10:00:00Z', '2026-08-03', 'EUR', 2000, 'PAID', 'FULFILLED',
            'ELIGIBLE', $1, '{}', '{}')`,
        [customerId],
      );
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      SHOPIFY_RECIPIENT_RECLASSIFICATION,
      EBAY_PAYMENT_RECONCILIATION,
      EBAY_REFUND_DEDUPLICATION,
      RETENTION_POLICY,
      REMOVE_ARUBA_UPLOAD_PROTECTION,
      CUSTOMER_EMAIL_DISABLED,
      CUSTOMER_REVIEW_CLEANUP,
      ARUBA_CANARY_PERMIT,
      ARUBA_INBOUND_RECONCILIATION,
      SHOPIFY_SHIPPING_IDENTITY_REPLAY,
      REMOVE_ARUBA_SEND_PERMITS,
      SUPPORT_SAFARI_ARUBA_READ_SYNC,
      ARUBA_STATUS_MAPPER_VERSION,
      ARUBA_API_INBOUND,
      ARUBA_REJECTED_ATTEMPT_IDENTITY,
      ARUBA_API_TRAFFIC_GUARD,
      ARUBA_API_AUTHORITY_CUTOVER,
      ARUBA_P7M_PARITY_NORMALIZATION,
      ARUBA_API_OUTBOUND,
      ...MIGRATIONS_AFTER_ARUBA_API_OUTBOUND,
    ]);
    await withClient(database.connectionString, async (client) => {
      assert.deepEqual(
        (
          await client.query(
            `SELECT provider, cursor, overlap_from::text
             FROM sync_cursors WHERE stream = 'orders' ORDER BY provider`,
          )
        ).rows,
        [
          {
            provider: "EBAY",
            cursor: null,
            overlap_from: "2026-08-04 09:55:00+00",
          },
          {
            provider: "SHOPIFY",
            cursor: null,
            overlap_from: "2026-08-02 09:55:00+00",
          },
        ],
      );
      assert.deepEqual(
        (
          await client.query(
            `SELECT provider, last_synced_at::text
             FROM connections ORDER BY provider`,
          )
        ).rows,
        [
          { provider: "EBAY", last_synced_at: null },
          { provider: "SHOPIFY", last_synced_at: null },
        ],
      );
    });
  } finally {
    await rm(beforeReclassification, { recursive: true, force: true });
    await database.drop();
  }
});

test("l'upgrade rilegge il mapper Shopify senza riavvolgere eBay", async () => {
  const database = await temporaryDatabase("shopify_shipping_identity_replay");
  const beforeReplay = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-shopify-shipping-identity-replay-"),
  );
  try {
    await copyMigrationSnapshot(beforeReplay);
    await rm(path.join(beforeReplay, SHOPIFY_SHIPPING_IDENTITY_REPLAY));
    await rm(path.join(beforeReplay, REMOVE_ARUBA_SEND_PERMITS));
    await runMigrations({
      connectionString: database.connectionString,
      directory: beforeReplay,
    });
    await withClient(database.connectionString, async (client) => {
      await client.query(
        `INSERT INTO connections
           (provider, environment, account_reference, encrypted_credentials, status,
            last_synced_at)
         VALUES
           ('SHOPIFY', 'PRODUCTION', 'shop.example', 'encrypted', 'CONNECTED',
            '2026-08-14T12:00:00Z'),
           ('EBAY', 'PRODUCTION', 'seller', 'encrypted', 'CONNECTED',
            '2026-08-14T12:00:00Z')`,
      );
      await client.query(
        `INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
         VALUES
           ('SHOPIFY', 'history_import', 'complete', '2026-01-01T00:00:00Z'),
           ('EBAY', 'history_import', 'complete', '2026-01-01T00:00:00Z'),
           ('SHOPIFY', 'orders', 'shopify-recent', '2026-08-14T10:00:00Z'),
           ('EBAY', 'orders', 'ebay-recent', '2026-08-14T10:00:00Z')`,
      );
      const customerId = (
        await client.query(
          `INSERT INTO customers
             (kind, match_key, display_name, billing_address_json, source_confidence,
              review_required)
           VALUES ('UNKNOWN', 'shipping-replay', 'Cliente', '{}', 'AMBIGUOUS', true)
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
           ('SHOPIFY', 'shop.example', 'shop-order', '#S', '2026-08-13T09:00:00Z',
            '2026-08-13T10:00:00Z', '2026-08-13', 'EUR', 1000, 'PAID', 'FULFILLED',
            'ELIGIBLE', $1, '{}', '{}'),
           ('EBAY', 'seller', 'ebay-order', '#E', '2026-08-12T09:00:00Z',
            '2026-08-12T10:00:00Z', '2026-08-12', 'EUR', 1000, 'PAID', 'FULFILLED',
            'ELIGIBLE', $1, '{}', '{}')`,
        [customerId],
      );
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      SHOPIFY_SHIPPING_IDENTITY_REPLAY,
      REMOVE_ARUBA_SEND_PERMITS,
      SUPPORT_SAFARI_ARUBA_READ_SYNC,
      ARUBA_STATUS_MAPPER_VERSION,
      ARUBA_API_INBOUND,
      ARUBA_REJECTED_ATTEMPT_IDENTITY,
      ARUBA_API_TRAFFIC_GUARD,
      ARUBA_API_AUTHORITY_CUTOVER,
      ARUBA_P7M_PARITY_NORMALIZATION,
      ARUBA_API_OUTBOUND,
      ...MIGRATIONS_AFTER_ARUBA_API_OUTBOUND,
    ]);
    await withClient(database.connectionString, async (client) => {
      assert.deepEqual(
        (
          await client.query(
            `SELECT provider, cursor, overlap_from::text
             FROM sync_cursors WHERE stream = 'orders' ORDER BY provider`,
          )
        ).rows,
        [
          {
            provider: "EBAY",
            cursor: "ebay-recent",
            overlap_from: "2026-08-14 10:00:00+00",
          },
          {
            provider: "SHOPIFY",
            cursor: null,
            overlap_from: "2026-08-13 09:55:00+00",
          },
        ],
      );
      assert.deepEqual(
        (
          await client.query(
            `SELECT provider, last_synced_at::text
             FROM connections ORDER BY provider`,
          )
        ).rows,
        [
          { provider: "EBAY", last_synced_at: "2026-08-14 12:00:00+00" },
          { provider: "SHOPIFY", last_synced_at: null },
        ],
      );
    });
  } finally {
    await rm(beforeReplay, { recursive: true, force: true });
    await database.drop();
  }
});

test("l'upgrade rilegge soltanto gli ordini eBay già importati", async () => {
  const database = await temporaryDatabase("ebay_payment_reconciliation");
  const beforeReconciliation = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-ebay-payment-reconciliation-"),
  );
  try {
    await copyMigrationSnapshot(beforeReconciliation);
    await rm(path.join(beforeReconciliation, EBAY_PAYMENT_RECONCILIATION));
    await rm(path.join(beforeReconciliation, EBAY_REFUND_DEDUPLICATION));
    await rm(path.join(beforeReconciliation, RETENTION_POLICY));
    await rm(path.join(beforeReconciliation, CUSTOMER_EMAIL_DISABLED));
    await rm(path.join(beforeReconciliation, CUSTOMER_REVIEW_CLEANUP));
    await rm(path.join(beforeReconciliation, ARUBA_CANARY_PERMIT));
    await rm(path.join(beforeReconciliation, ARUBA_INBOUND_RECONCILIATION));
    await rm(path.join(beforeReconciliation, SHOPIFY_SHIPPING_IDENTITY_REPLAY));
    await rm(path.join(beforeReconciliation, REMOVE_ARUBA_SEND_PERMITS));
    await rm(path.join(beforeReconciliation, REMOVE_ARUBA_UPLOAD_PROTECTION));
    await runMigrations({
      connectionString: database.connectionString,
      directory: beforeReconciliation,
    });
    await withClient(database.connectionString, async (client) => {
      await client.query(
        `INSERT INTO connections
           (provider, environment, account_reference, encrypted_credentials, status,
            last_synced_at)
         VALUES
           ('SHOPIFY', 'PRODUCTION', 'shop.example', 'encrypted', 'CONNECTED',
            '2026-08-12T12:00:00Z'),
           ('EBAY', 'PRODUCTION', 'seller', 'encrypted', 'CONNECTED',
            '2026-08-12T12:00:00Z')`,
      );
      await client.query(
        `INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
         VALUES
           ('SHOPIFY', 'orders', 'shopify-recent', '2026-08-12T10:00:00Z'),
           ('EBAY', 'history_import', 'complete', '2026-01-01T00:00:00Z'),
           ('EBAY', 'orders', 'ebay-recent', '2026-08-12T10:00:00Z')`,
      );
      const customerId = (
        await client.query(
          `INSERT INTO customers
             (kind, match_key, display_name, billing_address_json, source_confidence,
              review_required)
           VALUES ('UNKNOWN', 'ebay-payment-reconciliation', 'Cliente', '{}',
             'AMBIGUOUS', true)
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
           ('EBAY', 'seller', 'ebay-order', '#E', '2026-08-03T09:00:00Z',
            '2026-08-04T10:00:00Z', '2026-08-03', 'EUR', 2000, 'PAID', 'FULFILLED',
            'ELIGIBLE', $1, '{}', '{}')`,
        [customerId],
      );
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      EBAY_PAYMENT_RECONCILIATION,
      EBAY_REFUND_DEDUPLICATION,
      RETENTION_POLICY,
      REMOVE_ARUBA_UPLOAD_PROTECTION,
      CUSTOMER_EMAIL_DISABLED,
      CUSTOMER_REVIEW_CLEANUP,
      ARUBA_CANARY_PERMIT,
      ARUBA_INBOUND_RECONCILIATION,
      SHOPIFY_SHIPPING_IDENTITY_REPLAY,
      REMOVE_ARUBA_SEND_PERMITS,
      SUPPORT_SAFARI_ARUBA_READ_SYNC,
      ARUBA_STATUS_MAPPER_VERSION,
      ARUBA_API_INBOUND,
      ARUBA_REJECTED_ATTEMPT_IDENTITY,
      ARUBA_API_TRAFFIC_GUARD,
      ARUBA_API_AUTHORITY_CUTOVER,
      ARUBA_P7M_PARITY_NORMALIZATION,
      ARUBA_API_OUTBOUND,
      ...MIGRATIONS_AFTER_ARUBA_API_OUTBOUND,
    ]);
    await withClient(database.connectionString, async (client) => {
      assert.deepEqual(
        (
          await client.query(
            `SELECT provider, cursor, overlap_from::text
             FROM sync_cursors WHERE stream = 'orders' ORDER BY provider`,
          )
        ).rows,
        [
          {
            provider: "EBAY",
            cursor: null,
            overlap_from: "2026-08-04 09:55:00+00",
          },
          {
            provider: "SHOPIFY",
            cursor: "shopify-recent",
            overlap_from: "2026-08-12 10:00:00+00",
          },
        ],
      );
      assert.deepEqual(
        (
          await client.query(
            `SELECT provider, account_reference, last_synced_at::text
             FROM connections ORDER BY provider, account_reference`,
          )
        ).rows,
        [
          {
            provider: "EBAY",
            account_reference: "seller",
            last_synced_at: null,
          },
          {
            provider: "SHOPIFY",
            account_reference: "shop.example",
            last_synced_at: "2026-08-12 12:00:00+00",
          },
        ],
      );
    });
  } finally {
    await rm(beforeReconciliation, { recursive: true, force: true });
    await database.drop();
  }
});

test("l'upgrade non crea un cursore eBay senza ordini eBay", async () => {
  const database = await temporaryDatabase("ebay_payment_reconciliation_empty");
  const beforeReconciliation = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-ebay-payment-reconciliation-empty-"),
  );
  try {
    await copyMigrationSnapshot(beforeReconciliation);
    await rm(path.join(beforeReconciliation, EBAY_PAYMENT_RECONCILIATION));
    await rm(path.join(beforeReconciliation, EBAY_REFUND_DEDUPLICATION));
    await rm(path.join(beforeReconciliation, RETENTION_POLICY));
    await rm(path.join(beforeReconciliation, CUSTOMER_EMAIL_DISABLED));
    await rm(path.join(beforeReconciliation, CUSTOMER_REVIEW_CLEANUP));
    await rm(path.join(beforeReconciliation, ARUBA_CANARY_PERMIT));
    await rm(path.join(beforeReconciliation, ARUBA_INBOUND_RECONCILIATION));
    await rm(path.join(beforeReconciliation, SHOPIFY_SHIPPING_IDENTITY_REPLAY));
    await rm(path.join(beforeReconciliation, REMOVE_ARUBA_SEND_PERMITS));
    await rm(path.join(beforeReconciliation, REMOVE_ARUBA_UPLOAD_PROTECTION));
    await runMigrations({
      connectionString: database.connectionString,
      directory: beforeReconciliation,
    });
    await withClient(database.connectionString, async (client) => {
      await client.query(
        `INSERT INTO connections
           (provider, environment, account_reference, encrypted_credentials, status,
            last_synced_at)
         VALUES ('EBAY', 'PRODUCTION', 'seller-empty', 'encrypted', 'CONNECTED',
           '2026-08-12T12:00:00Z')`,
      );
      await client.query(
        `INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
         VALUES ('EBAY', 'history_import', 'complete', '2026-01-01T00:00:00Z')`,
      );
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      EBAY_PAYMENT_RECONCILIATION,
      EBAY_REFUND_DEDUPLICATION,
      RETENTION_POLICY,
      REMOVE_ARUBA_UPLOAD_PROTECTION,
      CUSTOMER_EMAIL_DISABLED,
      CUSTOMER_REVIEW_CLEANUP,
      ARUBA_CANARY_PERMIT,
      ARUBA_INBOUND_RECONCILIATION,
      SHOPIFY_SHIPPING_IDENTITY_REPLAY,
      REMOVE_ARUBA_SEND_PERMITS,
      SUPPORT_SAFARI_ARUBA_READ_SYNC,
      ARUBA_STATUS_MAPPER_VERSION,
      ARUBA_API_INBOUND,
      ARUBA_REJECTED_ATTEMPT_IDENTITY,
      ARUBA_API_TRAFFIC_GUARD,
      ARUBA_API_AUTHORITY_CUTOVER,
      ARUBA_P7M_PARITY_NORMALIZATION,
      ARUBA_API_OUTBOUND,
      ...MIGRATIONS_AFTER_ARUBA_API_OUTBOUND,
    ]);
    await withClient(database.connectionString, async (client) => {
      assert.equal(
        (
          await client.query(
            "SELECT count(*) FROM sync_cursors WHERE provider = 'EBAY' AND stream = 'orders'",
          )
        ).rows[0].count,
        "0",
      );
      assert.equal(
        (await client.query("SELECT last_synced_at::text FROM connections WHERE provider = 'EBAY'"))
          .rows[0].last_synced_at,
        "2026-08-12 12:00:00+00",
      );
    });
  } finally {
    await rm(beforeReconciliation, { recursive: true, force: true });
    await database.drop();
  }
});

test("l'upgrade elimina soltanto i duplicati sintetici dei rimborsi eBay", async () => {
  const database = await temporaryDatabase("ebay_refund_deduplication");
  const beforeDeduplication = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-ebay-refund-deduplication-"),
  );
  try {
    await copyMigrationSnapshot(beforeDeduplication);
    await rm(path.join(beforeDeduplication, EBAY_REFUND_DEDUPLICATION));
    await rm(path.join(beforeDeduplication, RETENTION_POLICY));
    await rm(path.join(beforeDeduplication, CUSTOMER_EMAIL_DISABLED));
    await rm(path.join(beforeDeduplication, CUSTOMER_REVIEW_CLEANUP));
    await rm(path.join(beforeDeduplication, ARUBA_CANARY_PERMIT));
    await rm(path.join(beforeDeduplication, ARUBA_INBOUND_RECONCILIATION));
    await rm(path.join(beforeDeduplication, SHOPIFY_SHIPPING_IDENTITY_REPLAY));
    await rm(path.join(beforeDeduplication, REMOVE_ARUBA_SEND_PERMITS));
    await rm(path.join(beforeDeduplication, REMOVE_ARUBA_UPLOAD_PROTECTION));
    await runMigrations({
      connectionString: database.connectionString,
      directory: beforeDeduplication,
    });
    await withClient(database.connectionString, async (client) => {
      const order = await client.query<{ id: string }>(
        `WITH customer AS (
           INSERT INTO customers
             (kind, match_key, display_name, billing_address_json,
              source_confidence, review_required)
           VALUES ('PRIVATE_IT', 'ebay-refund-deduplication', 'Cliente', '{}', 'TAX_ID', false)
           RETURNING id
         )
         INSERT INTO orders
           (provider, external_account_id, external_order_id, display_number,
            created_at_source, updated_at_source, local_order_date, currency, gross_amount,
            payment_status, fulfillment_status, trigger_status, customer_id,
            raw_snapshot_json, normalized_snapshot_json)
         SELECT 'EBAY', 'deduplication', 'ebay-order', 'EBAY-ORDER', now(), now(),
                '2026-08-12', 'EUR', 1000, 'REFUNDED', 'FULFILLED', 'CANCELLED_NO_DOCUMENT',
                id, '{}', '{}'
         FROM customer RETURNING id`,
      );
      await client.query(
        `INSERT INTO refunds
          (provider, external_account_id, external_order_id, external_refund_id,
           order_id, status, amount, completed_at, raw_json)
         VALUES
          ('EBAY', 'deduplication', 'ebay-order', '5446235426', $1,
           'AMBIGUOUS', NULL, '2026-08-12T10:00:00Z', '{}'),
          ('EBAY', 'deduplication', 'ebay-order', 'ebay-order-refund-2', $1,
           'AMBIGUOUS', NULL, '2026-08-12T10:00:00Z', '{}')`,
        [order.rows[0]!.id],
      );
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      EBAY_REFUND_DEDUPLICATION,
      RETENTION_POLICY,
      REMOVE_ARUBA_UPLOAD_PROTECTION,
      CUSTOMER_EMAIL_DISABLED,
      CUSTOMER_REVIEW_CLEANUP,
      ARUBA_CANARY_PERMIT,
      ARUBA_INBOUND_RECONCILIATION,
      SHOPIFY_SHIPPING_IDENTITY_REPLAY,
      REMOVE_ARUBA_SEND_PERMITS,
      SUPPORT_SAFARI_ARUBA_READ_SYNC,
      ARUBA_STATUS_MAPPER_VERSION,
      ARUBA_API_INBOUND,
      ARUBA_REJECTED_ATTEMPT_IDENTITY,
      ARUBA_API_TRAFFIC_GUARD,
      ARUBA_API_AUTHORITY_CUTOVER,
      ARUBA_P7M_PARITY_NORMALIZATION,
      ARUBA_API_OUTBOUND,
      ...MIGRATIONS_AFTER_ARUBA_API_OUTBOUND,
    ]);
    await withClient(database.connectionString, async (client) => {
      assert.deepEqual(
        (await client.query("SELECT external_refund_id FROM refunds ORDER BY external_refund_id"))
          .rows,
        [{ external_refund_id: "5446235426" }],
      );
    });
  } finally {
    await rm(beforeDeduplication, { recursive: true, force: true });
    await database.drop();
  }
});

test("l'upgrade elimina la configurazione obsoleta della protezione per upload Aruba", async () => {
  const database = await temporaryDatabase("remove_aruba_upload_protection");
  const beforeRemoval = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-remove-aruba-upload-protection-"),
  );
  try {
    await copyMigrationSnapshot(beforeRemoval);
    await rm(path.join(beforeRemoval, REMOVE_ARUBA_UPLOAD_PROTECTION));
    await rm(path.join(beforeRemoval, CUSTOMER_EMAIL_DISABLED));
    await rm(path.join(beforeRemoval, CUSTOMER_REVIEW_CLEANUP));
    await rm(path.join(beforeRemoval, ARUBA_CANARY_PERMIT));
    await rm(path.join(beforeRemoval, ARUBA_INBOUND_RECONCILIATION));
    await rm(path.join(beforeRemoval, SHOPIFY_SHIPPING_IDENTITY_REPLAY));
    await rm(path.join(beforeRemoval, REMOVE_ARUBA_SEND_PERMITS));
    await runMigrations({
      connectionString: database.connectionString,
      directory: beforeRemoval,
    });
    await withClient(database.connectionString, async (client) => {
      await client.query(
        "UPDATE settings SET value_json = '\"SMS_PER_UPLOAD\"' WHERE key = 'aruba_auth_protection'",
      );
      assert.equal(
        (await client.query("SELECT count(*) FROM settings WHERE key = 'aruba_auth_protection'"))
          .rows[0].count,
        "1",
      );
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      REMOVE_ARUBA_UPLOAD_PROTECTION,
      CUSTOMER_EMAIL_DISABLED,
      CUSTOMER_REVIEW_CLEANUP,
      ARUBA_CANARY_PERMIT,
      ARUBA_INBOUND_RECONCILIATION,
      SHOPIFY_SHIPPING_IDENTITY_REPLAY,
      REMOVE_ARUBA_SEND_PERMITS,
      SUPPORT_SAFARI_ARUBA_READ_SYNC,
      ARUBA_STATUS_MAPPER_VERSION,
      ARUBA_API_INBOUND,
      ARUBA_REJECTED_ATTEMPT_IDENTITY,
      ARUBA_API_TRAFFIC_GUARD,
      ARUBA_API_AUTHORITY_CUTOVER,
      ARUBA_P7M_PARITY_NORMALIZATION,
      ARUBA_API_OUTBOUND,
      ...MIGRATIONS_AFTER_ARUBA_API_OUTBOUND,
    ]);
    await withClient(database.connectionString, async (client) => {
      assert.equal(
        (await client.query("SELECT count(*) FROM settings WHERE key = 'aruba_auth_protection'"))
          .rows[0].count,
        "0",
      );
    });
  } finally {
    await rm(beforeRemoval, { recursive: true, force: true });
    await database.drop();
  }
});
