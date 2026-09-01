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
  SOURCE_CONFLICT_MARKER_BACKFILL,
  copyMigrationSnapshot,
} from "./support.ts";

test("l'upgrade distingue i conflitti sorgente reali dai replay del mapper", async () => {
  const database = await temporaryDatabase("source_conflict_marker_backfill");
  const beforeBackfill = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-source-conflict-marker-"),
  );
  try {
    await copyMigrationSnapshot(beforeBackfill);
    await runMigrations({ connectionString: database.connectionString, directory: beforeBackfill });
    await withClient(database.connectionString, async (client) => {
      const customerId = (
        await client.query(
          `INSERT INTO customers
             (kind, match_key, display_name, billing_address_json, source_confidence,
              review_required)
           VALUES ('EU', 'source-marker', 'Cliente', '{}', 'EXACT_PROFILE', false)
           RETURNING id`,
        )
      ).rows[0].id;
      const caseIds = (
        await client.query(
          `INSERT INTO billing_cases
             (status, local_order_date, currency, customer_id, customer_snapshot_json)
           VALUES
             ('NEEDS_REVIEW', CURRENT_DATE, 'EUR', $1, '{}'),
             ('NEEDS_REVIEW', CURRENT_DATE - 1, 'EUR', $1, '{}')
           RETURNING id`,
          [customerId],
        )
      ).rows.map((row) => row.id);
      const orderIds = (
        await client.query(
          `INSERT INTO orders
             (provider, external_account_id, external_order_id, display_number,
              created_at_source, updated_at_source, local_order_date, currency, gross_amount,
              payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
              raw_snapshot_json, normalized_snapshot_json)
           VALUES
             ('SHOPIFY', 'shop.example', 'real-change', '#1', now(), now(), CURRENT_DATE,
              'EUR', 1000, 'PAID', 'FULFILLED', 'NEEDS_REVIEW', $1, $2, '{}', '{}'),
             ('EBAY', 'seller', 'mapper-replay', '2', now(), now(), CURRENT_DATE,
              'EUR', 1000, 'PAID', 'FULFILLED', 'NEEDS_REVIEW', $1, $3, '{}', '{}')
           RETURNING id`,
          [customerId, caseIds[0], caseIds[1]],
        )
      ).rows.map((row) => row.id);
      await client.query(
        `INSERT INTO order_source_revisions
           (order_id, billing_case_id, previous_normalized_snapshot_json,
            current_normalized_snapshot_json)
         VALUES
           ($1, $2, '{"sourceSnapshot":{"status":"open"}}',
                    '{"sourceSnapshot":{"status":"fulfilled"}}'),
           ($3, $4, '{"sourceSnapshot":{"id":"same"},"totalsReconciled":false}',
                    '{"sourceSnapshot":{"id":"same"},"totalsReconciled":true}')`,
        [orderIds[0], caseIds[0], orderIds[1], caseIds[1]],
      );
    });

    const applied = await runMigrations({ connectionString: database.connectionString });
    assert.ok(applied.includes(SOURCE_CONFLICT_MARKER_BACKFILL));
    await withClient(database.connectionString, async (client) => {
      assert.deepEqual(
        (
          await client.query(
            `SELECT external_order_id,
                    coalesce(
                      (normalized_snapshot_json ->> 'sourceConflictRequired')::boolean,
                      false
                    ) AS source_conflict_required
             FROM orders ORDER BY id`,
          )
        ).rows,
        [
          { external_order_id: "real-change", source_conflict_required: true },
          { external_order_id: "mapper-replay", source_conflict_required: false },
        ],
      );
    });
  } finally {
    await rm(beforeBackfill, { recursive: true, force: true });
    await database.drop();
  }
});
