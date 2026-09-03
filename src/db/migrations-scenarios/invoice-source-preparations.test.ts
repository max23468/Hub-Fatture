import {
  INVOICE_SOURCE_PREPARATIONS,
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
} from "./support.ts";

test("l'upgrade collega soltanto la preparazione originaria univoca", async () => {
  const database = await temporaryDatabase("invoice_source_preparations");
  const beforeTraceability = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-invoice-source-preparations-"),
  );
  try {
    await cp("migrations", beforeTraceability, { recursive: true });
    await removeMigrationsFrom(beforeTraceability, INVOICE_SOURCE_PREPARATIONS);
    await runMigrations({
      connectionString: database.connectionString,
      directory: beforeTraceability,
    });
    await withClient(database.connectionString, async (client) => {
      await client.query("ALTER TABLE billing_cases ALTER COLUMN id RESTART WITH 55");
      await client.query(`
        INSERT INTO fiscal_profiles (version, status, profile_json) VALUES (1, 'MOCK', '{}');
        WITH customer AS (
          INSERT INTO customers
            (kind, match_key, display_name, billing_address_json,
             source_confidence, review_required)
          VALUES ('PRIVATE_IT', 'invoice-source', 'Cliente', '{}', 'TAX_ID', false)
          RETURNING id
        ), cases AS (
          INSERT INTO billing_cases
            (customer_id, local_order_date, currency, status, customer_snapshot_json,
             fiscal_profile_version)
          SELECT id, '2026-08-20'::date, 'EUR', 'CLOSED', '{}'::jsonb, 1 FROM customer
          UNION ALL
          SELECT id, '2026-08-21'::date, 'EUR', 'CLOSED', '{}'::jsonb, 1 FROM customer
          RETURNING id, customer_id, local_order_date
        ), source_case AS (
          SELECT * FROM cases WHERE local_order_date = '2026-08-20'
        ), archive_case AS (
          SELECT * FROM cases WHERE local_order_date = '2026-08-21'
        ), inserted_order AS (
          INSERT INTO orders
            (provider, external_account_id, external_order_id, display_number,
             created_at_source, updated_at_source, local_order_date, currency, gross_amount,
             payment_status, fulfillment_status, trigger_status, customer_id,
             raw_snapshot_json, normalized_snapshot_json)
          SELECT 'SHOPIFY', 'shop', 'source-order', '#SOURCE', now(), now(),
                 '2026-08-20', 'EUR', 1000, 'PAID', 'FULFILLED', 'INVOICED',
                 customer_id, '{}', '{}'
          FROM source_case
          RETURNING id
        ), stored AS (
          INSERT INTO storage_objects
            (kind, relative_path, sha256, size_bytes, content_type)
          VALUES ('ARUBA_XML', 'aruba/history/source.xml', repeat('a', 64), 100,
                  'application/xml')
          RETURNING id
        ), issued AS (
          INSERT INTO documents
            (billing_case_id, kind, status, document_type, series, fiscal_year,
             fiscal_number, document_date, fiscal_profile_version, currency,
             total_amount, source_total_amount, difference_amount, projection_sha256,
             approved_at, xml_sha256, immutable_snapshot_json,
             fiscal_profile_snapshot_json, storage_object_id, payment_method,
             recipient_snapshot_json, origin)
          SELECT archive_case.id, 'INVOICE', 'APPROVED', 'TD01', 'FPR', 2026, 1627,
                 '2026-08-21', 1, 'EUR', 1000, 1000, 0, repeat('b', 64), now(),
                 repeat('b', 64), '{}', '{}', stored.id, 'MP08', '{}', 'ARUBA_HISTORY'
          FROM archive_case, stored
          RETURNING id
        )
        INSERT INTO document_orders (document_id, document_kind, order_id, amount)
        SELECT issued.id, 'INVOICE', inserted_order.id, 1000
        FROM issued, inserted_order;
      `);
      await client.query("ALTER TABLE billing_cases ALTER COLUMN id RESTART WITH 81");
      await client.query(`
        WITH customer AS (
          SELECT id FROM customers WHERE match_key = 'invoice-source'
        ), source_cases AS (
          INSERT INTO billing_cases
            (customer_id, local_order_date, currency, status, customer_snapshot_json,
             fiscal_profile_version)
          SELECT id, '2026-08-22'::date, 'EUR', 'CLOSED', '{}'::jsonb, 1 FROM customer
          UNION ALL
          SELECT id, '2026-08-22'::date, 'EUR', 'CLOSED', '{}'::jsonb, 1 FROM customer
          RETURNING customer_id
        ), archive_case AS (
          INSERT INTO billing_cases
            (customer_id, local_order_date, currency, status, customer_snapshot_json,
             fiscal_profile_version)
          SELECT customer_id, '2026-08-23', 'EUR', 'CLOSED', '{}', 1
          FROM source_cases LIMIT 1
          RETURNING id, customer_id
        ), inserted_order AS (
          INSERT INTO orders
            (provider, external_account_id, external_order_id, display_number,
             created_at_source, updated_at_source, local_order_date, currency, gross_amount,
             payment_status, fulfillment_status, trigger_status, customer_id,
             raw_snapshot_json, normalized_snapshot_json)
          SELECT 'SHOPIFY', 'shop', 'ambiguous-order', '#AMBIGUOUS', now(), now(),
                 '2026-08-22', 'EUR', 2000, 'PAID', 'FULFILLED', 'INVOICED',
                 customer_id, '{}', '{}'
          FROM archive_case
          RETURNING id
        ), stored AS (
          INSERT INTO storage_objects
            (kind, relative_path, sha256, size_bytes, content_type)
          VALUES ('ARUBA_XML', 'aruba/history/ambiguous.xml', repeat('c', 64), 100,
                  'application/xml')
          RETURNING id
        ), issued AS (
          INSERT INTO documents
            (billing_case_id, kind, status, document_type, series, fiscal_year,
             fiscal_number, document_date, fiscal_profile_version, currency,
             total_amount, source_total_amount, difference_amount, projection_sha256,
             approved_at, xml_sha256, immutable_snapshot_json,
             fiscal_profile_snapshot_json, storage_object_id, payment_method,
             recipient_snapshot_json, origin)
          SELECT archive_case.id, 'INVOICE', 'APPROVED', 'TD01', 'FPR', 2026, 1667,
                 '2026-08-23', 1, 'EUR', 2000, 2000, 0, repeat('d', 64), now(),
                 repeat('d', 64), '{}', '{}', stored.id, 'MP08', '{}', 'ARUBA_HISTORY'
          FROM archive_case, stored
          RETURNING id
        )
        INSERT INTO document_orders (document_id, document_kind, order_id, amount)
        SELECT issued.id, 'INVOICE', inserted_order.id, 2000
        FROM issued, inserted_order;
      `);
      await client.query("ALTER TABLE billing_cases ALTER COLUMN id RESTART WITH 90");
      await client.query(`
        WITH customer AS (
          SELECT id FROM customers WHERE match_key = 'invoice-source'
        ), source_case AS (
          INSERT INTO billing_cases
            (customer_id, local_order_date, currency, status, customer_snapshot_json,
             fiscal_profile_version)
          SELECT id, '2026-08-24', 'EUR', 'CLOSED', '{}', 1 FROM customer
          RETURNING customer_id
        ), archive_case AS (
          INSERT INTO billing_cases
            (customer_id, local_order_date, currency, status, customer_snapshot_json,
             fiscal_profile_version)
          SELECT customer_id, '2026-08-25', 'EUR', 'CLOSED', '{}', 1 FROM source_case
          RETURNING id, customer_id
        ), inserted_order AS (
          INSERT INTO orders
            (provider, external_account_id, external_order_id, display_number,
             created_at_source, updated_at_source, local_order_date, currency, gross_amount,
             payment_status, fulfillment_status, trigger_status, customer_id,
             raw_snapshot_json, normalized_snapshot_json)
          SELECT 'SHOPIFY', 'shop', 'unconfirmed-order', '#UNCONFIRMED', now(), now(),
                 '2026-08-24', 'EUR', 3000, 'PAID', 'FULFILLED', 'INVOICED',
                 customer_id, '{}', '{}'
          FROM archive_case
          RETURNING id
        ), stored AS (
          INSERT INTO storage_objects
            (kind, relative_path, sha256, size_bytes, content_type)
          VALUES ('ARUBA_XML', 'aruba/history/unconfirmed.xml', repeat('e', 64), 100,
                  'application/xml')
          RETURNING id
        ), issued AS (
          INSERT INTO documents
            (billing_case_id, kind, status, document_type, series, fiscal_year,
             fiscal_number, document_date, fiscal_profile_version, currency,
             total_amount, source_total_amount, difference_amount, projection_sha256,
             approved_at, xml_sha256, immutable_snapshot_json,
             fiscal_profile_snapshot_json, storage_object_id, payment_method,
             recipient_snapshot_json, origin)
          SELECT archive_case.id, 'INVOICE', 'APPROVED', 'TD01', 'FPR', 2026, 1700,
                 '2026-08-25', 1, 'EUR', 3000, 3000, 0, repeat('f', 64), now(),
                 repeat('f', 64), '{}', '{}', stored.id, 'MP08', '{}', 'ARUBA_HISTORY'
          FROM archive_case, stored
          RETURNING id
        )
        INSERT INTO document_orders (document_id, document_kind, order_id, amount)
        SELECT issued.id, 'INVOICE', inserted_order.id, 3000
        FROM issued, inserted_order;
      `);
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      INVOICE_SOURCE_PREPARATIONS,
    ]);
    await withClient(database.connectionString, async (client) => {
      assert.equal(
        (
          await client.query(
            `SELECT source_cases.local_order_date::text AS source_date
             FROM documents
             JOIN billing_cases AS source_cases
               ON source_cases.id = documents.source_billing_case_id
             WHERE documents.fiscal_number = 1627`,
          )
        ).rows[0].source_date,
        "2026-08-20",
      );
      assert.equal(
        (
          await client.query(
            "SELECT source_billing_case_id FROM documents WHERE fiscal_number = 1667",
          )
        ).rows[0].source_billing_case_id,
        null,
      );
      assert.equal(
        (
          await client.query(
            "SELECT source_billing_case_id FROM documents WHERE fiscal_number = 1700",
          )
        ).rows[0].source_billing_case_id,
        null,
      );
      assert.deepEqual(
        (
          await client.query(
            `SELECT audit_events.entity_type,
                    audit_events.metadata_json ->> 'billingCaseId' AS case_id,
                    documents.fiscal_number
             FROM audit_events
             JOIN documents ON documents.id::text = audit_events.entity_id
             WHERE action = 'INVOICE_SOURCE_PREPARATION_BACKFILLED'`,
          )
        ).rows,
        [{ entity_type: "DOCUMENT", case_id: "55", fiscal_number: 1627 }],
      );
      await assert.rejects(
        client.query("UPDATE documents SET total_amount = 999 WHERE fiscal_number = 1627"),
        /Un documento approvato è immutabile/,
      );
    });
  } finally {
    await rm(beforeTraceability, { recursive: true, force: true });
    await database.drop();
  }
});
