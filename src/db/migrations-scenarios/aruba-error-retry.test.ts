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
  ARUBA_ERROR_RETRY,
  SHOPIFY_PRIVATE_RECIPIENT_REPLAY,
  ARUBA_IDENTITY_EVIDENCE_REPLAY,
  ARUBA_HISTORICAL_API_RECOVERY,
  OPERATIONAL_WORKFLOW_1_1,
  INVOICE_SOURCE_PREPARATIONS,
  EBAY_CARE_OF_ADDRESS_REPLAY,
} from "./support.ts";

test("l'upgrade riprende un retry Aruba con credenziali valide in stato di errore", async () => {
  const database = await temporaryDatabase("aruba_error_retry");
  const beforeRetry = await mkdtemp(path.join(os.tmpdir(), "hub-fatture-before-aruba-retry-"));
  try {
    await cp("migrations", beforeRetry, { recursive: true });
    await removeMigrationsFrom(beforeRetry, ARUBA_ERROR_RETRY);
    await runMigrations({ connectionString: database.connectionString, directory: beforeRetry });
    await withClient(database.connectionString, async (client) => {
      await client.query(
        `INSERT INTO connections (
           provider, environment, account_reference, encrypted_credentials, status,
           inbound_enabled, api_paused, credentials_verified_at
         ) VALUES ('ARUBA', 'PRODUCTION', 'aruba-test', 'cifrato', 'ERROR', true, false, now())`,
      );
      await client.query(
        `INSERT INTO jobs (type, status, attempts, max_attempts, last_error_code)
         VALUES
           ('aruba_sync_inventory', 'FAILED', 1, 5, 'PROVIDER_NOT_CONFIGURED'),
           ('aruba_full_inventory', 'FAILED', 1, 5, 'ARUBA_PROFILE_CONFLICT')`,
      );
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
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
            status: "PENDING",
            attempts: 0,
            last_error_code: null,
          },
          {
            type: "aruba_full_inventory",
            status: "FAILED",
            attempts: 1,
            last_error_code: "ARUBA_PROFILE_CONFLICT",
          },
        ],
      );
    });
  } finally {
    await rm(beforeRetry, { recursive: true, force: true });
    await database.drop();
  }
});
