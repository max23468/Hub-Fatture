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
  BASELINE,
  CONNECTORS,
  CONNECTOR_PRIVACY,
  CONNECTOR_OPERATIONS,
  DOCUMENTS,
  M4_COMPLETION,
  M4_LEGACY_DOCUMENTS,
  DOCUMENT_DEPLOY_COMPATIBILITY,
  APPROVED_PAYMENT_HISTORY,
  DRAFT_RECIPIENT_SNAPSHOT,
  ORDER_MEMBERSHIP_DRAFT_INVALIDATION,
  ARUBA_INTEGRATION,
  CREDIT_NOTES_EMAIL,
  PRE_ISSUE_REFUNDS,
  CANONICAL_ACCOUNT_NAMES,
  HISTORICAL_ORDER_RECONCILIATION,
  HISTORICAL_INVOICE_LINKS,
  LEGACY_WEBHOOK_HISTORY,
  SHOPIFY_PAYMENT_FEES,
  CREDIT_NOTE_ORDER_AMOUNTS,
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
  RETIRE_ARUBA_BROWSER_STATE,
  MIGRATIONS_AFTER_ARUBA_API_OUTBOUND,
  copyMigrationSnapshot,
  migrationsFrom,
  removeMigrationsFrom,
} from "./support.ts";

test("la migrazione rimuove i permessi Aruba e conserva lo stato pronto", async () => {
  const database = await temporaryDatabase("remove_aruba_send_permits_upgrade");
  const beforeRemoval = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-remove-aruba-send-permits-"),
  );
  try {
    await copyMigrationSnapshot(beforeRemoval);
    await rm(path.join(beforeRemoval, REMOVE_ARUBA_SEND_PERMITS));
    await runMigrations({
      connectionString: database.connectionString,
      directory: beforeRemoval,
    });
    await withClient(database.connectionString, async (client) => {
      const user = await client.query<{ id: number }>(
        `INSERT INTO users (username, password_hash, can_approve)
         VALUES ('Massimo', 'synthetic', true) RETURNING id`,
      );
      const batchId = "10000000-0000-4000-8000-000000000001";
      await client.query(
        `INSERT INTO aruba_batches
          (id, environment, mode, account_reference, manifest_sha256, document_count,
           attempt_number, status, created_by)
         VALUES ($1, 'MOCK', 'AUTOMATIC', 'qualified-account', $2, 1, 1,
                 'PERMIT_CONSUMED', $3)`,
        [batchId, "1".repeat(64), user.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO aruba_send_permits
          (id, batch_id, manifest_sha256, document_count, mode, authorized_by, expires_at)
         VALUES ($1, $2, $3, 1, 'AUTOMATIC', $4, now() + interval '10 minutes')`,
        ["20000000-0000-4000-8000-000000000001", batchId, "1".repeat(64), user.rows[0]!.id],
      );
    });
    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
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
            `SELECT status, to_regclass('aruba_send_permits') AS permits_table
           FROM aruba_batches WHERE id = '10000000-0000-4000-8000-000000000001'`,
          )
        ).rows[0],
        { status: "READY_AUTOMATIC", permits_table: null },
      );
    });
  } finally {
    await rm(beforeRemoval, { recursive: true, force: true });
    await database.drop();
  }
});

test("la transizione conserva la provenienza helper e rimuove lo stato browser", async () => {
  const database = await temporaryDatabase("retire_aruba_browser_state_upgrade");
  const beforeRetirement = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-retire-aruba-browser-state-"),
  );
  try {
    await cp("migrations", beforeRetirement, { recursive: true });
    await removeMigrationsFrom(beforeRetirement, RETIRE_ARUBA_BROWSER_STATE);
    await runMigrations({
      connectionString: database.connectionString,
      directory: beforeRetirement,
    });
    await withClient(database.connectionString, async (client) => {
      await client.query(
        `INSERT INTO aruba_sync_sessions
          (id, environment, account_reference, device_id, token_hash, status, source,
           absolute_expires_at, completed_at)
         VALUES
          ('10000000-0000-4000-8000-000000000044', 'MOCK', 'synthetic-account',
           'manual-evidence-044', repeat('4', 64), 'COMPLETED', 'MANUAL', now(), now()),
          ('20000000-0000-4000-8000-000000000044', 'MOCK', 'synthetic-account',
           'historic-helper-044', repeat('5', 64), 'COMPLETED', 'HELPER', now(), now())`,
      );
    });

    assert.deepEqual(
      await runMigrations({ connectionString: database.connectionString }),
      migrationsFrom(RETIRE_ARUBA_BROWSER_STATE),
    );
    await withClient(database.connectionString, async (client) => {
      assert.deepEqual(
        (await client.query(`SELECT source FROM aruba_sync_sessions ORDER BY source`)).rows,
        [{ source: "HELPER" }, { source: "MANUAL" }],
      );
      assert.equal(
        (
          await client.query(
            `SELECT count(*) FROM information_schema.columns
             WHERE table_name = 'aruba_sync_sessions'
               AND column_name IN ('device_id', 'token_hash', 'helper_version', 'browser_name',
                                   'scope', 'initial_cursor')`,
          )
        ).rows[0].count,
        "0",
      );
      assert.deepEqual(
        (
          await client.query(
            `SELECT to_regclass('aruba_api_shadow_documents') AS shadow_documents,
                    to_regclass('aruba_inbound_parity_dossiers') AS parity_dossiers,
                    to_regclass('aruba_api_shadow_group_files') AS shadow_group_files,
                    to_regclass('aruba_helper_tokens') AS helper_tokens`,
          )
        ).rows[0],
        {
          shadow_documents: null,
          parity_dossiers: null,
          shadow_group_files: null,
          helper_tokens: null,
        },
      );
      assert.deepEqual(
        (
          await client.query(
            `SELECT table_name, column_name, column_default
             FROM information_schema.columns
             WHERE table_schema = 'public'
               AND (table_name, column_name) IN (
                 ('aruba_sync_sessions', 'source'),
                 ('aruba_batches', 'transport'),
                 ('aruba_submissions', 'transport')
               )
             ORDER BY table_name, column_name`,
          )
        ).rows,
        [
          {
            table_name: "aruba_batches",
            column_name: "transport",
            column_default: "'API'::text",
          },
          {
            table_name: "aruba_submissions",
            column_name: "transport",
            column_default: "'API'::text",
          },
          {
            table_name: "aruba_sync_sessions",
            column_name: "source",
            column_default: "'MANUAL'::text",
          },
        ],
      );
    });
  } finally {
    await rm(beforeRetirement, { recursive: true, force: true });
    await database.drop();
  }
});
test("la migrazione clienti elimina soltanto i profili privi di collegamenti", async () => {
  const database = await temporaryDatabase("customer_review_cleanup_upgrade");
  const beforeCleanup = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-customer-review-cleanup-"),
  );
  try {
    await copyMigrationSnapshot(beforeCleanup);
    await rm(path.join(beforeCleanup, CUSTOMER_REVIEW_CLEANUP));
    await rm(path.join(beforeCleanup, ARUBA_CANARY_PERMIT));
    await rm(path.join(beforeCleanup, ARUBA_INBOUND_RECONCILIATION));
    await rm(path.join(beforeCleanup, SHOPIFY_SHIPPING_IDENTITY_REPLAY));
    await rm(path.join(beforeCleanup, REMOVE_ARUBA_SEND_PERMITS));
    await runMigrations({
      connectionString: database.connectionString,
      directory: beforeCleanup,
    });
    await withClient(database.connectionString, async (client) => {
      const inserted = await client.query<{ id: string; match_key: string }>(
        `INSERT INTO customers
          (kind, match_key, display_name, billing_address_json,
           source_confidence, review_required)
         VALUES
          ('PRIVATE_IT', 'cleanup-orphan', 'Orfano', '{}', 'AMBIGUOUS', true),
          ('PRIVATE_IT', 'cleanup-source', 'Con sorgente', '{}', 'AMBIGUOUS', true)
         RETURNING id, match_key`,
      );
      const sourceCustomer = inserted.rows.find((row) => row.match_key === "cleanup-source")!;
      await client.query(
        `INSERT INTO customer_source_records
          (customer_id, provider, external_customer_id, raw_snapshot_json)
         VALUES ($1, 'SHOPIFY', 'cleanup-source', '{}')`,
        [sourceCustomer.id],
      );
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
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
        (await client.query("SELECT match_key FROM customers ORDER BY match_key")).rows.map(
          (row) => row.match_key,
        ),
        ["cleanup-source"],
      );
    });
  } finally {
    await rm(beforeCleanup, { recursive: true, force: true });
    await database.drop();
  }
});

test("la migrazione privacy aggiorna un database con i connettori già applicati", async () => {
  const database = await temporaryDatabase("connector_upgrade");
  const firstTwo = await mkdtemp(path.join(os.tmpdir(), "hub-fatture-first-two-"));
  try {
    await copyMigrationSnapshot(firstTwo);
    await rm(path.join(firstTwo, CONNECTOR_PRIVACY));
    await rm(path.join(firstTwo, CONNECTOR_OPERATIONS));
    await rm(path.join(firstTwo, DOCUMENTS));
    await rm(path.join(firstTwo, M4_COMPLETION));
    await rm(path.join(firstTwo, M4_LEGACY_DOCUMENTS));
    await rm(path.join(firstTwo, DOCUMENT_DEPLOY_COMPATIBILITY));
    await rm(path.join(firstTwo, APPROVED_PAYMENT_HISTORY));
    await rm(path.join(firstTwo, DRAFT_RECIPIENT_SNAPSHOT));
    await rm(path.join(firstTwo, ORDER_MEMBERSHIP_DRAFT_INVALIDATION));
    await rm(path.join(firstTwo, ARUBA_INTEGRATION));
    await rm(path.join(firstTwo, CREDIT_NOTES_EMAIL));
    await rm(path.join(firstTwo, PRE_ISSUE_REFUNDS));
    await rm(path.join(firstTwo, CANONICAL_ACCOUNT_NAMES));
    await rm(path.join(firstTwo, HISTORICAL_ORDER_RECONCILIATION));
    await rm(path.join(firstTwo, HISTORICAL_INVOICE_LINKS));
    await rm(path.join(firstTwo, LEGACY_WEBHOOK_HISTORY));
    await rm(path.join(firstTwo, SHOPIFY_PAYMENT_FEES));
    await rm(path.join(firstTwo, CREDIT_NOTE_ORDER_AMOUNTS));
    await rm(path.join(firstTwo, FISCAL_IDENTIFIER_BACKFILL));
    await rm(path.join(firstTwo, SHOPIFY_RECIPIENT_RECLASSIFICATION));
    await rm(path.join(firstTwo, EBAY_PAYMENT_RECONCILIATION));
    await rm(path.join(firstTwo, EBAY_REFUND_DEDUPLICATION));
    await rm(path.join(firstTwo, RETENTION_POLICY));
    await rm(path.join(firstTwo, CUSTOMER_EMAIL_DISABLED));
    await rm(path.join(firstTwo, CUSTOMER_REVIEW_CLEANUP));
    await rm(path.join(firstTwo, ARUBA_CANARY_PERMIT));
    await rm(path.join(firstTwo, ARUBA_INBOUND_RECONCILIATION));
    await rm(path.join(firstTwo, SHOPIFY_SHIPPING_IDENTITY_REPLAY));
    await rm(path.join(firstTwo, REMOVE_ARUBA_SEND_PERMITS));
    await rm(path.join(firstTwo, REMOVE_ARUBA_UPLOAD_PROTECTION));
    assert.deepEqual(
      await runMigrations({
        connectionString: database.connectionString,
        directory: firstTwo,
      }),
      [BASELINE, CONNECTORS],
    );
    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      CONNECTOR_PRIVACY,
      CONNECTOR_OPERATIONS,
      DOCUMENTS,
      M4_COMPLETION,
      M4_LEGACY_DOCUMENTS,
      DOCUMENT_DEPLOY_COMPATIBILITY,
      APPROVED_PAYMENT_HISTORY,
      DRAFT_RECIPIENT_SNAPSHOT,
      ORDER_MEMBERSHIP_DRAFT_INVALIDATION,
      ARUBA_INTEGRATION,
      CREDIT_NOTES_EMAIL,
      PRE_ISSUE_REFUNDS,
      CANONICAL_ACCOUNT_NAMES,
      HISTORICAL_ORDER_RECONCILIATION,
      HISTORICAL_INVOICE_LINKS,
      LEGACY_WEBHOOK_HISTORY,
      SHOPIFY_PAYMENT_FEES,
      CREDIT_NOTE_ORDER_AMOUNTS,
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
  } finally {
    await rm(firstTwo, { recursive: true, force: true });
    await database.drop();
  }
});

test("l'upgrade neutralizza le sincronizzazioni precedenti all'import storico", async () => {
  const database = await temporaryDatabase("historical_import_upgrade");
  const beforeHistoricalImport = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-historical-import-"),
  );
  try {
    await copyMigrationSnapshot(beforeHistoricalImport);
    await rm(path.join(beforeHistoricalImport, HISTORICAL_ORDER_RECONCILIATION));
    await rm(path.join(beforeHistoricalImport, HISTORICAL_INVOICE_LINKS));
    await rm(path.join(beforeHistoricalImport, LEGACY_WEBHOOK_HISTORY));
    await rm(path.join(beforeHistoricalImport, SHOPIFY_PAYMENT_FEES));
    await rm(path.join(beforeHistoricalImport, CREDIT_NOTE_ORDER_AMOUNTS));
    await rm(path.join(beforeHistoricalImport, FISCAL_IDENTIFIER_BACKFILL));
    await rm(path.join(beforeHistoricalImport, SHOPIFY_RECIPIENT_RECLASSIFICATION));
    await rm(path.join(beforeHistoricalImport, EBAY_PAYMENT_RECONCILIATION));
    await rm(path.join(beforeHistoricalImport, EBAY_REFUND_DEDUPLICATION));
    await rm(path.join(beforeHistoricalImport, RETENTION_POLICY));
    await rm(path.join(beforeHistoricalImport, CUSTOMER_EMAIL_DISABLED));
    await rm(path.join(beforeHistoricalImport, CUSTOMER_REVIEW_CLEANUP));
    await rm(path.join(beforeHistoricalImport, ARUBA_CANARY_PERMIT));
    await rm(path.join(beforeHistoricalImport, ARUBA_INBOUND_RECONCILIATION));
    await rm(path.join(beforeHistoricalImport, SHOPIFY_SHIPPING_IDENTITY_REPLAY));
    await rm(path.join(beforeHistoricalImport, REMOVE_ARUBA_SEND_PERMITS));
    await rm(path.join(beforeHistoricalImport, REMOVE_ARUBA_UPLOAD_PROTECTION));
    await runMigrations({
      connectionString: database.connectionString,
      directory: beforeHistoricalImport,
    });
    await withClient(database.connectionString, async (client) => {
      await client.query(
        `INSERT INTO jobs
           (type, status, locked_at, lease_expires_at, locked_by, claim_token)
         VALUES
           ('shopify_sync_orders', 'PENDING', NULL, NULL, NULL, NULL),
           ('ebay_sync_orders', 'RUNNING', now(), now() + interval '2 minutes',
            'worker-pre-upgrade', gen_random_uuid())`,
      );
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      HISTORICAL_ORDER_RECONCILIATION,
      HISTORICAL_INVOICE_LINKS,
      LEGACY_WEBHOOK_HISTORY,
      SHOPIFY_PAYMENT_FEES,
      CREDIT_NOTE_ORDER_AMOUNTS,
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
      const jobs = await client.query(
        `SELECT type, status, completed_at IS NOT NULL AS completed,
                lease_expires_at, locked_by, claim_token, result_json
         FROM jobs ORDER BY type`,
      );
      assert.deepEqual(jobs.rows, [
        {
          type: "ebay_sync_orders",
          status: "COMPLETED",
          completed: true,
          lease_expires_at: null,
          locked_by: null,
          claim_token: null,
          result_json: { obsoleteBeforeHistoryImport: true },
        },
        {
          type: "shopify_sync_orders",
          status: "COMPLETED",
          completed: true,
          lease_expires_at: null,
          locked_by: null,
          claim_token: null,
          result_json: { obsoleteBeforeHistoryImport: true },
        },
      ]);
    });
  } finally {
    await rm(beforeHistoricalImport, { recursive: true, force: true });
    await database.drop();
  }
});

test("l'upgrade conserva la classificazione storica dei webhook già accodati", async () => {
  const database = await temporaryDatabase("legacy_webhook_history");
  const beforeClassification = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-webhook-history-"),
  );
  try {
    await copyMigrationSnapshot(beforeClassification);
    await rm(path.join(beforeClassification, LEGACY_WEBHOOK_HISTORY));
    await rm(path.join(beforeClassification, SHOPIFY_PAYMENT_FEES));
    await rm(path.join(beforeClassification, CREDIT_NOTE_ORDER_AMOUNTS));
    await rm(path.join(beforeClassification, FISCAL_IDENTIFIER_BACKFILL));
    await rm(path.join(beforeClassification, SHOPIFY_RECIPIENT_RECLASSIFICATION));
    await rm(path.join(beforeClassification, EBAY_PAYMENT_RECONCILIATION));
    await rm(path.join(beforeClassification, EBAY_REFUND_DEDUPLICATION));
    await rm(path.join(beforeClassification, RETENTION_POLICY));
    await rm(path.join(beforeClassification, CUSTOMER_EMAIL_DISABLED));
    await rm(path.join(beforeClassification, CUSTOMER_REVIEW_CLEANUP));
    await rm(path.join(beforeClassification, ARUBA_CANARY_PERMIT));
    await rm(path.join(beforeClassification, ARUBA_INBOUND_RECONCILIATION));
    await rm(path.join(beforeClassification, SHOPIFY_SHIPPING_IDENTITY_REPLAY));
    await rm(path.join(beforeClassification, REMOVE_ARUBA_SEND_PERMITS));
    await rm(path.join(beforeClassification, REMOVE_ARUBA_UPLOAD_PROTECTION));
    await runMigrations({
      connectionString: database.connectionString,
      directory: beforeClassification,
    });
    await withClient(database.connectionString, async (client) => {
      await client.query(
        `INSERT INTO sync_cursors (provider, stream, cursor, overlap_from, updated_at)
         VALUES ('SHOPIFY', 'history_import', 'ready', '2026-08-12T10:00:00Z',
           '2026-08-12T10:00:00Z')`,
      );
      await client.query(
        `INSERT INTO jobs (type, payload_json, status, created_at)
         VALUES
           ('shopify_process_webhook', '{"orderId":"before"}', 'FAILED',
             '2026-08-12T09:00:00Z'),
           ('shopify_process_webhook', '{"orderId":"after"}', 'PENDING',
             '2026-08-12T11:00:00Z')`,
      );
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      LEGACY_WEBHOOK_HISTORY,
      SHOPIFY_PAYMENT_FEES,
      CREDIT_NOTE_ORDER_AMOUNTS,
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
            `SELECT payload_json ->> 'orderId' AS order_id,
                    (payload_json ->> 'historical')::boolean AS historical
             FROM jobs WHERE type = 'shopify_process_webhook' ORDER BY id`,
          )
        ).rows,
        [
          { order_id: "before", historical: true },
          { order_id: "after", historical: true },
        ],
      );
    });
  } finally {
    await rm(beforeClassification, { recursive: true, force: true });
    await database.drop();
  }
});
