import {
  ARUBA_IDENTITY_EVIDENCE_REPLAY,
  ARUBA_HISTORICAL_API_RECOVERY,
  OPERATIONAL_WORKFLOW_1_1,
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

test("l'upgrade blocca i casi con identità Aruba plausibile e file ufficiale assente", async () => {
  const database = await temporaryDatabase("aruba_identity_evidence_replay");
  const beforeReplay = await mkdtemp(path.join(os.tmpdir(), "hub-fatture-before-aruba-identity-"));
  try {
    await cp("migrations", beforeReplay, { recursive: true });
    await removeMigrationsFrom(beforeReplay, ARUBA_IDENTITY_EVIDENCE_REPLAY);
    await runMigrations({ connectionString: database.connectionString, directory: beforeReplay });
    await withClient(database.connectionString, async (client) => {
      await client.query(`
        INSERT INTO fiscal_profiles (version, status, profile_json)
        VALUES (1, 'MOCK', '{}');
        WITH customer AS (
          INSERT INTO customers
            (kind, match_key, display_name, billing_address_json, source_confidence,
             review_required)
          VALUES ('PRIVATE_IT', 'aruba-identity-replay', 'Cliente sintetico', '{}',
                  'TAX_ID', false)
          RETURNING id
        ), cases AS (
          INSERT INTO billing_cases
            (customer_id, local_order_date, currency, status, customer_snapshot_json,
             fiscal_profile_version)
          SELECT customer.id, local_date, 'EUR', 'READY',
                 '{"reviewRequired":false,"canonicalProfile":{}}', 1
          FROM customer CROSS JOIN (VALUES ('2026-08-18'::date), ('2026-08-17'::date))
            AS seeded(local_date)
          RETURNING id, customer_id, local_order_date
        ), numbered_cases AS (
          SELECT id, customer_id, local_order_date,
                 row_number() OVER (ORDER BY id) AS ordinal
          FROM cases
        )
        INSERT INTO orders
          (provider, external_account_id, external_order_id, display_number,
           created_at_source, updated_at_source, local_order_date, currency, gross_amount,
           payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
           raw_snapshot_json, normalized_snapshot_json)
        SELECT 'SHOPIFY', 'shop', 'order-' || ordinal, '#ORDER-' || ordinal,
               now(), now(), local_order_date, 'EUR', 43368,
               'PAID', 'FULFILLED', 'GROUPED',
               customer_id, id, '{}', '{}'
        FROM numbered_cases;

        WITH inserted AS (
          INSERT INTO aruba_remote_documents
            (environment, account_reference, remote_id, document_type, fiscal_year,
             document_date, total_amount, remote_status, remote_status_observed_at,
             metadata_digest, automatic_source, provider_group_id, xml_sha256)
          VALUES
            ('MOCK', 'account', 'without-file', 'TD01', 2026, '2026-08-19', 43260,
             'DELIVERED', now(), repeat('1', 64), 'API', 'without-file', NULL),
            ('MOCK', 'account', 'with-file', 'TD01', 2026, '2026-08-19', 43260,
             'DELIVERED', now(), repeat('2', 64), 'API', 'with-file', repeat('a', 64))
          RETURNING id, remote_id
        )
        INSERT INTO aruba_document_matches
          (remote_document_id, status, method, matcher_version, candidates_json)
        SELECT inserted.id, 'UNMATCHED', 'NONE', 1,
               jsonb_build_array(jsonb_build_object(
                 'candidateId', orders.id::text,
                 'compatible', false,
                 'reviewable', false,
                 'probe', false,
                 'potential', false,
                 'signals', jsonb_build_object(
                   'nearDate', true, 'recipient', true, 'total', false)))
        FROM inserted
        JOIN orders ON orders.external_order_id = CASE inserted.remote_id
          WHEN 'without-file' THEN 'order-1' ELSE 'order-2' END;
      `);
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      ARUBA_IDENTITY_EVIDENCE_REPLAY,
      ARUBA_HISTORICAL_API_RECOVERY,
      OPERATIONAL_WORKFLOW_1_1,
    ]);
    await withClient(database.connectionString, async (client) => {
      assert.deepEqual(
        (
          await client.query(
            `SELECT orders.external_order_id, billing_cases.status, billing_cases.revision
             FROM orders
             JOIN billing_cases ON billing_cases.id = orders.billing_case_id
             ORDER BY orders.external_order_id`,
          )
        ).rows,
        [
          { external_order_id: "order-1", status: "NEEDS_REVIEW", revision: 1 },
          { external_order_id: "order-2", status: "READY", revision: 0 },
        ],
      );
      assert.equal(
        (
          await client.query(
            `SELECT count(*)::integer AS count FROM audit_events
             WHERE action = 'BILLING_CASE_ARUBA_IDENTITY_EVIDENCE_RECONCILED'`,
          )
        ).rows[0].count,
        1,
      );
    });
  } finally {
    await rm(beforeReplay, { recursive: true, force: true });
    await database.drop();
  }
});
