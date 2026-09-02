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
  RECONCILE_APPROVED_INVOICE_MEMBERSHIPS,
  AUTOMATIC_CUSTOMER_IDENTITY_EXCEPTIONS,
  SHOPIFY_BANK_TRANSFER_ROUNDING_REPLAY,
  SOURCE_CONFLICT_MARKER_BACKFILL,
  EBAY_SHIPPING_REFUND_REPLAY,
  SHOPIFY_IDENTITY_FULFILLMENT_REPLAY,
  EBAY_REFUND_MAPPER_CONFLICT_REPLAY,
  ARUBA_FOREIGN_CONSUMER_MATCH_REPLAY,
  ARUBA_ERROR_RETRY,
  SHOPIFY_PRIVATE_RECIPIENT_REPLAY,
  ARUBA_IDENTITY_EVIDENCE_REPLAY,
  ARUBA_HISTORICAL_API_RECOVERY,
  ARUBA_TD01_CANARY,
  removeMigrationsFrom,
} from "./support.ts";

test("l'upgrade chiude le preparazioni ricreate sopra fatture approvate", async () => {
  const database = await temporaryDatabase("approved_invoice_memberships");
  const beforeReconciliation = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-approved-invoice-memberships-"),
  );
  try {
    await cp("migrations", beforeReconciliation, { recursive: true });
    await removeMigrationsFrom(beforeReconciliation, RECONCILE_APPROVED_INVOICE_MEMBERSHIPS);
    await runMigrations({
      connectionString: database.connectionString,
      directory: beforeReconciliation,
    });
    await withClient(database.connectionString, async (client) => {
      await client.query(`
        INSERT INTO fiscal_profiles (version, status, profile_json)
        VALUES (1, 'MOCK', '{}');

        WITH customer AS (
          INSERT INTO customers
            (kind, match_key, display_name, billing_address_json,
             source_confidence, review_required)
          VALUES ('PRIVATE_IT', 'approved-invoice-membership', 'Cliente', '{}',
                  'TAX_ID', false)
          RETURNING id
        ), cases AS (
          INSERT INTO billing_cases
            (customer_id, local_order_date, currency, status, customer_snapshot_json,
             fiscal_profile_version)
          SELECT id, '2026-08-20', 'EUR', status, '{}', 1
          FROM customer
          CROSS JOIN (VALUES ('READY'), ('CLOSED')) AS statuses(status)
          RETURNING id, status
        ), inserted_order AS (
          INSERT INTO orders
            (provider, external_account_id, external_order_id, display_number,
             created_at_source, updated_at_source, local_order_date, currency, gross_amount,
             payment_status, fulfillment_status, trigger_status, customer_id,
             billing_case_id, raw_snapshot_json, normalized_snapshot_json)
          SELECT 'SHOPIFY', 'shop', 'already-invoiced', '#ISSUED',
                 '2026-08-20T08:00:00Z', '2026-08-20T09:00:00Z', '2026-08-20',
                 'EUR', 1000, 'PAID', 'FULFILLED', 'GROUPED', customer.id,
                 cases.id, '{}', '{}'
          FROM customer
          JOIN cases ON cases.status = 'READY'
          RETURNING id
        ), stored AS (
          INSERT INTO storage_objects
            (kind, relative_path, sha256, size_bytes, content_type)
          VALUES ('ARUBA_XML', 'aruba/history/approved-membership.xml',
                  repeat('a', 64), 100, 'application/xml')
          RETURNING id
        ), issued AS (
          INSERT INTO documents
            (billing_case_id, kind, status, document_type, series, fiscal_year,
             fiscal_number, document_date, fiscal_profile_version, currency,
             total_amount, source_total_amount, difference_amount, projection_sha256,
             approved_at, xml_sha256, immutable_snapshot_json,
             fiscal_profile_snapshot_json, storage_object_id, payment_status,
             payment_method, recipient_snapshot_json, origin)
          SELECT cases.id, 'INVOICE', 'APPROVED', 'TD01', 'FPR', 2026, 9001,
                 '2026-08-20', 1, 'EUR', 1000, 1000, 0, repeat('b', 64), now(),
                 repeat('b', 64), '{}', '{}', stored.id, 'PAID', 'MP08', '{}',
                 'ARUBA_HISTORY'
          FROM cases, stored
          WHERE cases.status = 'CLOSED'
          RETURNING id
        )
        INSERT INTO document_orders (document_id, document_kind, order_id, amount)
        SELECT issued.id, 'INVOICE', inserted_order.id, 1000
        FROM issued, inserted_order;
      `);
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      RECONCILE_APPROVED_INVOICE_MEMBERSHIPS,
      AUTOMATIC_CUSTOMER_IDENTITY_EXCEPTIONS,
      SHOPIFY_BANK_TRANSFER_ROUNDING_REPLAY,
      SOURCE_CONFLICT_MARKER_BACKFILL,
      EBAY_SHIPPING_REFUND_REPLAY,
      SHOPIFY_IDENTITY_FULFILLMENT_REPLAY,
      EBAY_REFUND_MAPPER_CONFLICT_REPLAY,
      ARUBA_FOREIGN_CONSUMER_MATCH_REPLAY,
      ARUBA_ERROR_RETRY,
      SHOPIFY_PRIVATE_RECIPIENT_REPLAY,
      ARUBA_IDENTITY_EVIDENCE_REPLAY,
      ARUBA_HISTORICAL_API_RECOVERY,
      ARUBA_TD01_CANARY,
    ]);
    await withClient(database.connectionString, async (client) => {
      assert.deepEqual(
        (
          await client.query(
            `SELECT orders.billing_case_id, orders.trigger_status,
                    billing_cases.status, billing_cases.revision,
                    count(audit_events.id)::integer AS reconciliation_events
             FROM orders
             JOIN billing_cases ON billing_cases.status = 'CLOSED'
               AND billing_cases.id <> (
                 SELECT documents.billing_case_id
                 FROM documents
                 JOIN document_orders ON document_orders.document_id = documents.id
                 WHERE document_orders.order_id = orders.id
               )
             LEFT JOIN audit_events
               ON audit_events.entity_type = 'BILLING_CASE'
              AND audit_events.entity_id = billing_cases.id::text
              AND audit_events.action = 'BILLING_CASE_INVOICED_ORDERS_RECONCILED'
             WHERE orders.external_order_id = 'already-invoiced'
             GROUP BY orders.id, billing_cases.id`,
          )
        ).rows[0],
        {
          billing_case_id: null,
          trigger_status: "INVOICED",
          status: "CLOSED",
          revision: 1,
          reconciliation_events: 1,
        },
      );
      assert.equal(
        (
          await client.query(
            `SELECT count(*)::integer AS count
             FROM billing_cases
             JOIN orders ON orders.billing_case_id = billing_cases.id
             JOIN document_orders ON document_orders.order_id = orders.id
             JOIN documents ON documents.id = document_orders.document_id
             WHERE billing_cases.status IN ('DRAFT', 'READY', 'NEEDS_REVIEW')
               AND document_orders.document_kind = 'INVOICE'
               AND documents.status = 'APPROVED'`,
          )
        ).rows[0].count,
        0,
      );
    });
  } finally {
    await rm(beforeReconciliation, { recursive: true, force: true });
    await database.drop();
  }
});
