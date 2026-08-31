import {
  assert,
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  os,
  path,
  test,
  pg,
  documentInputSchema,
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
  CURRENT_MIGRATIONS,
  MIGRATIONS_AFTER_ARUBA_API_OUTBOUND,
  copyMigrationSnapshot,
} from "./support.ts";

test("installazione vuota, checksum e guardie sull'ordine", { timeout: 30_000 }, async () => {
  const clean = await temporaryDatabase("clean");
  try {
    assert.deepEqual(await runMigrations({ connectionString: clean.connectionString }), [
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
      ...MIGRATIONS_AFTER_ARUBA_API_OUTBOUND,
    ]);
    const cleanClient = new pg.Client({
      connectionString: clean.connectionString,
    });
    await cleanClient.connect();
    try {
      assert.equal(
        (await cleanClient.query("SELECT count(*) FROM schema_migrations")).rows[0].count,
        String(CURRENT_MIGRATIONS.length),
      );
      assert.equal(
        (
          await cleanClient.query(
            `SELECT count(*) FROM information_schema.columns
             WHERE table_name = 'sync_cursors' AND column_name = 'aruba_status_mapper_version'`,
          )
        ).rows[0].count,
        "1",
      );
      assert.match(
        (
          await cleanClient.query<{ definition: string }>(
            `SELECT pg_get_constraintdef(oid) AS definition
             FROM pg_constraint
             WHERE conname = 'documents_customer_email_mode_check'`,
          )
        ).rows[0]!.definition,
        /DISABLED/,
      );
      assert.equal(
        (
          await cleanClient.query(
            "SELECT count(*) FROM settings WHERE key = 'aruba_auth_protection'",
          )
        ).rows[0].count,
        "0",
      );
      assert.equal(
        (
          await cleanClient.query(
            `SELECT count(*) FROM information_schema.columns
             WHERE table_name = 'aruba_sync_sessions'
               AND column_name IN ('device_id', 'token_hash', 'helper_version', 'browser_name',
                                   'scope', 'initial_cursor')`,
          )
        ).rows[0].count,
        "0",
      );
      assert.match(
        (
          await cleanClient.query<{ column_default: string }>(
            `SELECT column_default FROM information_schema.columns
             WHERE table_name = 'aruba_preflight_receipts' AND column_name = 'source'`,
          )
        ).rows[0]!.column_default,
        /MANUAL/,
      );
    } finally {
      await cleanClient.end();
    }

    const changed = await mkdtemp(path.join(os.tmpdir(), "hf-migrations-changed-"));
    await cp("migrations", changed, { recursive: true });
    await writeFile(
      path.join(changed, BASELINE),
      `${await readFile(path.join(changed, BASELINE), "utf8")}\n-- modifica vietata\n`,
    );
    await assert.rejects(
      runMigrations({
        connectionString: clean.connectionString,
        directory: changed,
      }),
      /Migrazione applicata modificata/,
    );
    await rm(path.join(changed, BASELINE));
    await assert.rejects(
      runMigrations({
        connectionString: clean.connectionString,
        directory: changed,
      }),
      /Migrazione applicata rimossa/,
    );

    // Una migrazione nuova che si ordina prima dell'ultima applicata salterebbe il proprio
    // turno: deve fallire invece di essere applicata fuori sequenza.
    const inserted = await mkdtemp(path.join(os.tmpdir(), "hf-migrations-inserted-"));
    await cp("migrations", inserted, { recursive: true });
    await writeFile(path.join(inserted, "000_inserted.sql"), "SELECT 1;\n");
    await assert.rejects(
      runMigrations({
        connectionString: clean.connectionString,
        directory: inserted,
      }),
      /Migrazione fuori ordine/,
    );

    await withClient(clean.connectionString, async (client) => {
      assert.equal(
        (await client.query("SELECT to_regclass('audit_events') AS table_name")).rows[0].table_name,
        "audit_events",
      );
      assert.equal(
        (await client.query("SELECT to_regclass('orders') AS table_name")).rows[0].table_name,
        "orders",
      );
      assert.equal(
        (
          await client.query(
            "SELECT to_regclass('audit_events_login_rate_scope_idx') AS index_name",
          )
        ).rows[0].index_name,
        "audit_events_login_rate_scope_idx",
      );
      assert.equal(
        (await client.query("SELECT value_json #>> '{}' AS trigger FROM settings")).rows[0].trigger,
        "PAID",
      );
      const customerId = (
        await client.query(
          `INSERT INTO customers
               (kind, match_key, display_name, billing_address_json, source_confidence, review_required)
             VALUES ('UNKNOWN', 'test-high-id', 'Test', '{}'::jsonb, 'AMBIGUOUS', true)
             RETURNING id`,
        )
      ).rows[0].id;
      // Il numero pubblico non tronca oltre le sei cifre: è la ragione per cui la sua
      // definizione era già stata rifatta due volte prima della baseline.
      await client.query("ALTER TABLE billing_cases ALTER COLUMN id RESTART WITH 1000000");
      assert.equal(
        (
          await client.query(
            `INSERT INTO billing_cases
                 (customer_id, local_order_date, currency, status, customer_snapshot_json)
               VALUES ($1, '2026-08-09', 'EUR', 'NEEDS_REVIEW', '{}'::jsonb)
               RETURNING public_number`,
            [customerId],
          )
        ).rows[0].public_number,
        "1000000",
      );
    });
  } finally {
    await clean.drop();
  }
});

test("la migrazione rende canonici e case-insensitive i due account", async () => {
  const database = await temporaryDatabase("canonical_accounts");
  const beforeCanonicalNames = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-canonical-accounts-"),
  );
  try {
    await copyMigrationSnapshot(beforeCanonicalNames);
    await rm(path.join(beforeCanonicalNames, CANONICAL_ACCOUNT_NAMES));
    await rm(path.join(beforeCanonicalNames, HISTORICAL_ORDER_RECONCILIATION));
    await rm(path.join(beforeCanonicalNames, HISTORICAL_INVOICE_LINKS));
    await rm(path.join(beforeCanonicalNames, LEGACY_WEBHOOK_HISTORY));
    await rm(path.join(beforeCanonicalNames, SHOPIFY_PAYMENT_FEES));
    await rm(path.join(beforeCanonicalNames, CREDIT_NOTE_ORDER_AMOUNTS));
    await rm(path.join(beforeCanonicalNames, FISCAL_IDENTIFIER_BACKFILL));
    await rm(path.join(beforeCanonicalNames, SHOPIFY_RECIPIENT_RECLASSIFICATION));
    await rm(path.join(beforeCanonicalNames, EBAY_PAYMENT_RECONCILIATION));
    await rm(path.join(beforeCanonicalNames, EBAY_REFUND_DEDUPLICATION));
    await rm(path.join(beforeCanonicalNames, RETENTION_POLICY));
    await rm(path.join(beforeCanonicalNames, CUSTOMER_EMAIL_DISABLED));
    await rm(path.join(beforeCanonicalNames, CUSTOMER_REVIEW_CLEANUP));
    await rm(path.join(beforeCanonicalNames, ARUBA_CANARY_PERMIT));
    await rm(path.join(beforeCanonicalNames, ARUBA_INBOUND_RECONCILIATION));
    await rm(path.join(beforeCanonicalNames, SHOPIFY_SHIPPING_IDENTITY_REPLAY));
    await rm(path.join(beforeCanonicalNames, REMOVE_ARUBA_SEND_PERMITS));
    await rm(path.join(beforeCanonicalNames, REMOVE_ARUBA_UPLOAD_PROTECTION));
    await runMigrations({
      connectionString: database.connectionString,
      directory: beforeCanonicalNames,
    });
    await withClient(database.connectionString, async (client) => {
      await client.query(
        `INSERT INTO users (username, password_hash, can_approve)
         VALUES ('matteo', 'owner', true), ('codex', 'agent', false)`,
      );
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
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
    await withClient(database.connectionString, async (client) => {
      assert.deepEqual(
        (await client.query("SELECT username, can_approve FROM users ORDER BY username")).rows,
        [
          { username: "Codex", can_approve: true },
          { username: "Massimo", can_approve: true },
        ],
      );
      await assert.rejects(
        client.query("UPDATE users SET can_approve = false WHERE username = 'Codex'"),
        /users_approval_identity_check/,
      );
      await client.query("BEGIN");
      await client.query("ALTER TABLE users DROP CONSTRAINT users_username_canonical_check");
      await assert.rejects(
        client.query(
          "INSERT INTO users (username, password_hash, can_approve) VALUES ('MASSIMO', 'x', true)",
        ),
        /users_username_case_insensitive_idx/,
      );
      await client.query("ROLLBACK");
    });
  } finally {
    await rm(beforeCanonicalNames, { recursive: true, force: true });
    await database.drop();
  }
});

test("l'aggiornamento conserva i rimborsi già sottratti prima dell'emissione", async () => {
  const database = await temporaryDatabase("pre_issue_refund_upgrade");
  const beforeRefundAccounting = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-refund-accounting-"),
  );
  try {
    await copyMigrationSnapshot(beforeRefundAccounting);
    await rm(path.join(beforeRefundAccounting, PRE_ISSUE_REFUNDS));
    await rm(path.join(beforeRefundAccounting, CANONICAL_ACCOUNT_NAMES));
    await rm(path.join(beforeRefundAccounting, HISTORICAL_ORDER_RECONCILIATION));
    await rm(path.join(beforeRefundAccounting, HISTORICAL_INVOICE_LINKS));
    await rm(path.join(beforeRefundAccounting, LEGACY_WEBHOOK_HISTORY));
    await rm(path.join(beforeRefundAccounting, SHOPIFY_PAYMENT_FEES));
    await rm(path.join(beforeRefundAccounting, CREDIT_NOTE_ORDER_AMOUNTS));
    await rm(path.join(beforeRefundAccounting, FISCAL_IDENTIFIER_BACKFILL));
    await rm(path.join(beforeRefundAccounting, SHOPIFY_RECIPIENT_RECLASSIFICATION));
    await rm(path.join(beforeRefundAccounting, EBAY_PAYMENT_RECONCILIATION));
    await rm(path.join(beforeRefundAccounting, EBAY_REFUND_DEDUPLICATION));
    await rm(path.join(beforeRefundAccounting, RETENTION_POLICY));
    await rm(path.join(beforeRefundAccounting, CUSTOMER_EMAIL_DISABLED));
    await rm(path.join(beforeRefundAccounting, CUSTOMER_REVIEW_CLEANUP));
    await rm(path.join(beforeRefundAccounting, ARUBA_CANARY_PERMIT));
    await rm(path.join(beforeRefundAccounting, ARUBA_INBOUND_RECONCILIATION));
    await rm(path.join(beforeRefundAccounting, SHOPIFY_SHIPPING_IDENTITY_REPLAY));
    await rm(path.join(beforeRefundAccounting, REMOVE_ARUBA_SEND_PERMITS));
    await rm(path.join(beforeRefundAccounting, REMOVE_ARUBA_UPLOAD_PROTECTION));
    await runMigrations({
      connectionString: database.connectionString,
      directory: beforeRefundAccounting,
    });
    await withClient(database.connectionString, async (client) => {
      const order = await client.query<{ id: string }>(
        `WITH customer AS (
           INSERT INTO customers
             (kind, match_key, display_name, billing_address_json,
              source_confidence, review_required)
           VALUES ('PRIVATE_IT', 'refund-upgrade', 'Cliente', '{}', 'TAX_ID', false)
           RETURNING id
         ), billing_case AS (
           INSERT INTO billing_cases
             (customer_id, local_order_date, currency, status, customer_snapshot_json)
           SELECT id, '2026-08-11', 'EUR', 'READY', '{}' FROM customer
           RETURNING id, customer_id
         )
         INSERT INTO orders
           (provider, external_account_id, external_order_id, display_number,
            created_at_source, updated_at_source, local_order_date, currency, gross_amount,
            payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
            raw_snapshot_json, normalized_snapshot_json)
         SELECT 'SHOPIFY', 'upgrade', 'order', '#UPGRADE', now(), now(), '2026-08-11',
                'EUR', 1000, 'PAID', 'FULFILLED', 'GROUPED', customer_id, id, '{}', '{}'
         FROM billing_case RETURNING id`,
      );
      await client.query(
        `INSERT INTO refunds
          (provider, external_account_id, external_order_id, external_refund_id,
           order_id, status, amount, raw_json)
         VALUES ('SHOPIFY', 'upgrade', 'order', 'refund', $1, 'COMPLETED', 100, '{}')`,
        [order.rows[0]!.id],
      );
    });
    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
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
    await withClient(database.connectionString, async (client) => {
      assert.equal(
        (await client.query("SELECT applied_before_issue FROM refunds")).rows[0]
          .applied_before_issue,
        true,
      );
    });
  } finally {
    await rm(beforeRefundAccounting, { recursive: true, force: true });
    await database.drop();
  }
});

test("l'aggiornamento deriva il pagamento e completa gli snapshot preesistenti", async () => {
  const database = await temporaryDatabase("m4_legacy_documents");
  const beforeM4 = await mkdtemp(path.join(os.tmpdir(), "hub-fatture-before-m4-"));
  let deployCaseId: string | undefined;
  try {
    await copyMigrationSnapshot(beforeM4);
    await rm(path.join(beforeM4, M4_COMPLETION));
    await rm(path.join(beforeM4, M4_LEGACY_DOCUMENTS));
    await rm(path.join(beforeM4, DOCUMENT_DEPLOY_COMPATIBILITY));
    await rm(path.join(beforeM4, APPROVED_PAYMENT_HISTORY));
    await rm(path.join(beforeM4, DRAFT_RECIPIENT_SNAPSHOT));
    await rm(path.join(beforeM4, ORDER_MEMBERSHIP_DRAFT_INVALIDATION));
    await rm(path.join(beforeM4, ARUBA_INTEGRATION));
    await rm(path.join(beforeM4, CREDIT_NOTES_EMAIL));
    await rm(path.join(beforeM4, PRE_ISSUE_REFUNDS));
    await rm(path.join(beforeM4, CANONICAL_ACCOUNT_NAMES));
    await rm(path.join(beforeM4, HISTORICAL_ORDER_RECONCILIATION));
    await rm(path.join(beforeM4, HISTORICAL_INVOICE_LINKS));
    await rm(path.join(beforeM4, LEGACY_WEBHOOK_HISTORY));
    await rm(path.join(beforeM4, SHOPIFY_PAYMENT_FEES));
    await rm(path.join(beforeM4, CREDIT_NOTE_ORDER_AMOUNTS));
    await rm(path.join(beforeM4, FISCAL_IDENTIFIER_BACKFILL));
    await rm(path.join(beforeM4, SHOPIFY_RECIPIENT_RECLASSIFICATION));
    await rm(path.join(beforeM4, EBAY_PAYMENT_RECONCILIATION));
    await rm(path.join(beforeM4, EBAY_REFUND_DEDUPLICATION));
    await rm(path.join(beforeM4, RETENTION_POLICY));
    await rm(path.join(beforeM4, CUSTOMER_EMAIL_DISABLED));
    await rm(path.join(beforeM4, CUSTOMER_REVIEW_CLEANUP));
    await rm(path.join(beforeM4, ARUBA_CANARY_PERMIT));
    await rm(path.join(beforeM4, ARUBA_INBOUND_RECONCILIATION));
    await rm(path.join(beforeM4, SHOPIFY_SHIPPING_IDENTITY_REPLAY));
    await rm(path.join(beforeM4, REMOVE_ARUBA_SEND_PERMITS));
    await rm(path.join(beforeM4, REMOVE_ARUBA_UPLOAD_PROTECTION));
    await runMigrations({
      connectionString: database.connectionString,
      directory: beforeM4,
    });

    await withClient(database.connectionString, async (client) => {
      const customer = await client.query<{ id: string }>(
        `INSERT INTO customers
             (kind, match_key, display_name, billing_address_json, source_confidence, review_required)
           VALUES ('PRIVATE_IT', 'm4-legacy', 'Mario Rossi', '{}', 'TAX_ID', false)
           RETURNING id`,
      );
      const customerId = customer.rows[0]!.id;
      const profile = {
        payment: {
          condition: "TP02",
          invoiceMethod: "MP01",
          creditNoteMethod: "MP05",
        },
      };
      await client.query(
        `INSERT INTO fiscal_profiles (version, status, profile_json)
         VALUES (1, 'MOCK', $1)`,
        [profile],
      );
      const cases = await client.query<{ id: string }>(
        `INSERT INTO billing_cases
             (customer_id, local_order_date, currency, status, customer_snapshot_json,
              fiscal_profile_version)
           VALUES
             ($1, '2026-08-09', 'EUR', 'READY', '{}', 1),
             ($1, '2026-08-10', 'EUR', 'APPROVED', '{}', 1),
             ($1, '2026-08-11', 'EUR', 'READY', '{}', 1)
           RETURNING id`,
        [customerId],
      );
      deployCaseId = cases.rows[2]!.id;
      const orders = await client.query<{ id: string }>(
        `INSERT INTO orders
             (provider, external_account_id, external_order_id, display_number,
              created_at_source, updated_at_source, local_order_date, currency, gross_amount,
              payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
              raw_snapshot_json, normalized_snapshot_json)
           VALUES
             ('SHOPIFY', 'm4', 'pending', '#PENDING', now(), now(), '2026-08-09', 'EUR',
              1000, 'PENDING', 'FULFILLED', 'GROUPED', $1, $2, '{}', '{}'),
             ('SHOPIFY', 'm4', 'paid', '#PAID', now(), now(), '2026-08-10', 'EUR',
              1000, 'PAID', 'FULFILLED', 'INVOICED', $1, $3, '{}', '{}'),
             ('SHOPIFY', 'm4', 'deploy-window', '#DEPLOY', now(), now(), '2026-08-11', 'EUR',
              1000, 'PENDING', 'FULFILLED', 'GROUPED', $1, $4, '{}', '{}')
           RETURNING id`,
        [customerId, cases.rows[0]!.id, cases.rows[1]!.id, cases.rows[2]!.id],
      );
      const draft = await client.query<{ id: string }>(
        `INSERT INTO documents
             (billing_case_id, kind, status, document_type, series, document_date,
              fiscal_profile_version, currency, total_amount, source_total_amount,
              difference_amount, projection_sha256)
           VALUES ($1, 'INVOICE', 'DRAFT', 'TD01', 'FPR', '2026-08-09', 1, 'EUR',
                   1000, 1000, 0, $2)
           RETURNING id`,
        [cases.rows[0]!.id, "a".repeat(64)],
      );
      await client.query(
        `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
         VALUES ($1, 'INVOICE', $2, 1000)`,
        [draft.rows[0]!.id, orders.rows[0]!.id],
      );

      const storage = await client.query<{ id: string }>(
        `INSERT INTO storage_objects
             (kind, relative_path, sha256, size_bytes, content_type)
           VALUES ('INVOICE_XML', 'legacy.xml', $1, 1, 'application/xml')
           RETURNING id`,
        ["b".repeat(64)],
      );
      const approved = await client.query<{ id: string }>(
        `INSERT INTO documents
             (billing_case_id, kind, status, document_type, series, document_date,
              fiscal_profile_version, currency, total_amount, source_total_amount,
              difference_amount, projection_sha256)
           VALUES ($1, 'INVOICE', 'DRAFT', 'TD01', 'FPR', '2026-08-10', 1, 'EUR',
                   1000, 1000, 0, $2)
           RETURNING id`,
        [cases.rows[1]!.id, "c".repeat(64)],
      );
      await client.query(
        `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
         VALUES ($1, 'INVOICE', $2, 1000)`,
        [approved.rows[0]!.id, orders.rows[1]!.id],
      );
      await client.query(
        `UPDATE documents
         SET status = 'APPROVED', fiscal_year = 2026, fiscal_number = 1,
             immutable_snapshot_json = $2, fiscal_profile_snapshot_json = $3,
             approved_at = now(), pending_payment_confirmed_at = now(),
             xml_sha256 = $4, storage_object_id = $5
         WHERE id = $1`,
        [
          approved.rows[0]!.id,
          {
            kind: "INVOICE",
            documentDate: "2026-08-10",
            recipient: {
              kind: "PRIVATE_IT",
              firstName: "Mario",
              lastName: "Rossi",
              taxIdentifiers: [{ type: "CODICE_FISCALE", value: "RSSMRA80A01H501U" }],
              address: {
                line1: "Via Roma 1",
                postalCode: "00100",
                city: "Roma",
                province: "RM",
                countryCode: "IT",
              },
            },
            lines: [{ description: "Moneta", quantity: 1, unitAmount: 1000 }],
          },
          profile,
          "b".repeat(64),
          storage.rows[0]!.id,
        ],
      );
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
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
    assert.ok(deployCaseId);
    await withClient(database.connectionString, async (client) => {
      await assert.rejects(
        client.query(
          `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
           SELECT documents.id, 'INVOICE', orders.id, 1000
           FROM documents CROSS JOIN orders
           WHERE documents.status = 'APPROVED'
             AND orders.external_order_id = 'deploy-window'`,
        ),
        /Le righe di un documento approvato sono immutabili/,
      );
      const deployDraft = await client.query<{ id: string }>(
        `INSERT INTO documents
             (billing_case_id, kind, status, document_type, series, document_date,
              fiscal_profile_version, currency, total_amount, source_total_amount,
              difference_amount, projection_sha256)
           VALUES ($1, 'INVOICE', 'DRAFT', 'TD01', 'FPR', '2026-08-11', 1, 'EUR',
                   1000, 1000, 0, $2)
           RETURNING id`,
        [deployCaseId, "d".repeat(64)],
      );
      const oldVersionOrder = await client.query<{ id: string }>(
        `INSERT INTO orders
             (provider, external_account_id, external_order_id, display_number,
              created_at_source, updated_at_source, local_order_date, currency, gross_amount,
              payment_status, fulfillment_status, trigger_status, customer_id,
              raw_snapshot_json, normalized_snapshot_json)
           SELECT 'SHOPIFY', 'm4', 'old-version-membership', '#OLD', now(), now(),
                  '2026-08-11', 'EUR', 500, 'PAID', 'FULFILLED', 'ELIGIBLE', customer_id,
                  '{}', '{}'
           FROM billing_cases WHERE id = $1
           RETURNING id`,
        [deployCaseId],
      );
      await client.query("UPDATE orders SET billing_case_id = $2 WHERE id = $1", [
        oldVersionOrder.rows[0]!.id,
        deployCaseId,
      ]);
      assert.equal(
        (
          await client.query("SELECT projection_sha256 FROM documents WHERE id = $1", [
            deployDraft.rows[0]!.id,
          ])
        ).rows[0].projection_sha256,
        "0".repeat(64),
      );
      const result = await client.query<{
        status: string;
        payment_status: string;
        payment_method: string;
        immutable_snapshot_json: unknown;
        recipient_snapshot_json: unknown;
      }>(
        `SELECT status, payment_status, payment_method, immutable_snapshot_json,
                recipient_snapshot_json
         FROM documents ORDER BY id`,
      );
      assert.deepEqual(
        result.rows.map(({ status, payment_status, payment_method }) => ({
          status,
          payment_status,
          payment_method,
        })),
        [
          {
            status: "DRAFT",
            payment_status: "PENDING",
            payment_method: "MP01",
          },
          {
            status: "APPROVED",
            payment_status: "PENDING",
            payment_method: "MP01",
          },
          {
            status: "DRAFT",
            payment_status: "PENDING",
            payment_method: "MP01",
          },
        ],
      );
      documentInputSchema.parse(result.rows[1]!.immutable_snapshot_json);
      assert.ok(result.rows.every((row) => row.recipient_snapshot_json));
    });
  } finally {
    await rm(beforeM4, { recursive: true, force: true });
    await database.drop();
  }
});
