import {
  assert,
  cp,
  mkdtemp,
  os,
  path,
  removeMigrationsFrom,
  rm,
  runMigrations,
  temporaryDatabase,
  test,
  withClient,
  ARUBA_FOREIGN_CONSUMER_MATCH_REPLAY,
  ARUBA_ERROR_RETRY,
  SHOPIFY_PRIVATE_RECIPIENT_REPLAY,
  ARUBA_IDENTITY_EVIDENCE_REPLAY,
  ARUBA_HISTORICAL_API_RECOVERY,
  OPERATIONAL_WORKFLOW_1_1,
  INVOICE_SOURCE_PREPARATIONS,
  EBAY_CARE_OF_ADDRESS_REPLAY,
} from "./support.ts";

test("l'upgrade ritenta i conflitti Aruba dei privati esteri", async () => {
  const database = await temporaryDatabase("aruba_foreign_consumer_match_replay");
  const beforeReplay = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-aruba-foreign-consumer-replay-"),
  );
  try {
    await cp("migrations", beforeReplay, { recursive: true });
    await removeMigrationsFrom(beforeReplay, ARUBA_FOREIGN_CONSUMER_MATCH_REPLAY);
    await runMigrations({ connectionString: database.connectionString, directory: beforeReplay });
    await withClient(database.connectionString, async (client) => {
      await client.query(
        `INSERT INTO jobs (type, status, attempts, max_attempts, last_error_code)
         VALUES
           ('aruba_sync_inventory', 'FAILED', 1, 5, 'ARUBA_PROFILE_CONFLICT'),
           ('aruba_full_inventory', 'FAILED', 2, 5, 'ARUBA_PROFILE_CONFLICT'),
           ('aruba_sync_inventory', 'FAILED', 1, 5, 'ARUBA_INVENTORY_CONFLICT')`,
      );
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      ARUBA_FOREIGN_CONSUMER_MATCH_REPLAY,
      ARUBA_ERROR_RETRY,
      SHOPIFY_PRIVATE_RECIPIENT_REPLAY,
      ARUBA_IDENTITY_EVIDENCE_REPLAY,
      ARUBA_HISTORICAL_API_RECOVERY,
      OPERATIONAL_WORKFLOW_1_1,
      INVOICE_SOURCE_PREPARATIONS,
      EBAY_CARE_OF_ADDRESS_REPLAY,
    ]);
    await withClient(database.connectionString, async (client) => {
      assert.deepEqual(
        (
          await client.query(
            `SELECT type, status, attempts, last_error_code
             FROM jobs ORDER BY id`,
          )
        ).rows,
        [
          {
            type: "aruba_sync_inventory",
            status: "FAILED",
            attempts: 1,
            last_error_code: "ARUBA_PROFILE_CONFLICT",
          },
          {
            type: "aruba_full_inventory",
            status: "PENDING",
            attempts: 0,
            last_error_code: null,
          },
          {
            type: "aruba_sync_inventory",
            status: "FAILED",
            attempts: 1,
            last_error_code: "ARUBA_INVENTORY_CONFLICT",
          },
        ],
      );
    });
  } finally {
    await rm(beforeReplay, { recursive: true, force: true });
    await database.drop();
  }
});
