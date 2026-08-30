import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

test("i contatori e la riconciliazione Dashboard usano gli stessi gate operativi", async () => {
  const database = await temporaryDatabase("dashboard_reconciliation");
  process.env.APP_ENV = "test";
  process.env.APP_BASE_URL = "http://localhost:8080";
  process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
  process.env.DATABASE_URL = database.connectionString;

  const client = await import("./client.server.ts");
  try {
    await runMigrations({ connectionString: database.connectionString });
    await client
      .getPool()
      .query(
        "INSERT INTO users (username, password_hash, can_approve) VALUES ('Massimo', 'synthetic', true)",
      );
    const profile = JSON.parse(
      await readFile("tests/fixtures/fatturapa/profile.mock.json", "utf8"),
    );
    await client
      .getPool()
      .query("INSERT INTO fiscal_profiles (version, status, profile_json) VALUES (1, 'MOCK', $1)", [
        profile,
      ]);
    const customer = await client.getPool().query<{ id: string }>(
      `INSERT INTO customers
         (kind, match_key, display_name, billing_address_json, source_confidence, review_required)
       VALUES ('PRIVATE_IT', 'dashboard-reconciliation', 'Cliente sintetico', '{}',
               'TAX_ID', false)
       RETURNING id`,
    );
    const cases = await client.getPool().query<{ id: string }>(
      `INSERT INTO billing_cases
         (customer_id, local_order_date, currency, status, customer_snapshot_json,
          fiscal_profile_version)
       VALUES
         ($1, CURRENT_DATE, 'EUR', 'READY',
          '{"reviewRequired":false,"canonicalProfile":{}}', 1),
         ($1, CURRENT_DATE - 1, 'EUR', 'READY',
          '{"reviewRequired":false,"canonicalProfile":{}}', 1),
         ($1, CURRENT_DATE - 2, 'EUR', 'READY',
          '{"reviewRequired":false,"canonicalProfile":{}}', 1),
         ($1, CURRENT_DATE - 3, 'EUR', 'NEEDS_REVIEW',
          '{"reviewRequired":false,"canonicalProfile":{}}', 1)
       RETURNING id`,
      [customer.rows[0]!.id],
    );
    await client.getPool().query(
      `INSERT INTO documents
         (billing_case_id, kind, status, document_type, series, document_date,
          fiscal_profile_version, currency, total_amount, source_total_amount,
          difference_amount, projection_sha256, payment_status)
       VALUES
         ($1, 'INVOICE', 'DRAFT', 'TD01', 'FPR', CURRENT_DATE,
          1, 'EUR', 1000, 1000, 0, repeat('a', 64), 'PAID'),
         ($2, 'INVOICE', 'DRAFT', 'TD01', 'FPR', CURRENT_DATE - 1,
          1, 'EUR', 1000, 1000, 0, repeat('b', 64), 'PAID')`,
      [cases.rows[0]!.id, cases.rows[1]!.id],
    );
    await client.getPool().query(
      `INSERT INTO orders
         (provider, external_account_id, external_order_id, display_number,
          created_at_source, updated_at_source, local_order_date, currency, gross_amount,
          payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
          raw_snapshot_json, normalized_snapshot_json)
       VALUES
         ('SHOPIFY', 'dashboard-test', 'pending-review', '#PENDING', now(), now(),
          CURRENT_DATE - 3, 'EUR', 1000, 'PENDING', 'FULFILLED', 'NEEDS_REVIEW', $1, $2, '{}',
          '{"orderReviewRequired":true,"deferredReviewRequired":false,"totalsReconciled":true,
            "customerSnapshot":{"canonicalProfile":{}}}')`,
      [customer.rows[0]!.id, cases.rows[3]!.id],
    );

    const orders = await import("./orders.server.ts");
    const documents = await import("./documents.server.ts");
    const initialSummary = await orders.dashboardSummary();
    assert.equal(initialSummary.ready_cases, "1");
    assert.equal(initialSummary.review_cases, "0");
    assert.equal(initialSummary.pending_payments, "1");
    assert.deepEqual(
      (
        await orders.listBillingCases({
          statuses: ["NEEDS_REVIEW"],
          excludePendingPayments: true,
        })
      ).rows,
      [],
    );
    assert.deepEqual(
      (await documents.listMassApprovalCandidates()).map(({ billing_case_id }) => billing_case_id),
      [cases.rows[0]!.id],
    );
    await client.getPool().query(
      `INSERT INTO aruba_batches
         (id, environment, mode, transport, account_reference, manifest_sha256,
          document_count, status, requires_reconciliation, created_by)
       VALUES
         ('00000000-0000-4000-8000-000000000101', 'MOCK', 'DOCUMENT_ONLY', 'API',
          'synthetic-aruba-account', repeat('1', 64), 1, 'DRY_RUN_VALIDATED', false,
          (SELECT id FROM users ORDER BY id LIMIT 1)),
         ('00000000-0000-4000-8000-000000000102', 'MOCK', 'DOCUMENT_ONLY', 'API',
          'synthetic-aruba-account', repeat('2', 64), 1, 'RECONCILIATION_REQUIRED', true,
          (SELECT id FROM users ORDER BY id LIMIT 1))`,
    );
    assert.equal((await orders.dashboardSummary()).aruba_batches_requiring_attention, "1");

    const order = await client.getPool().query<{ id: string }>(
      `INSERT INTO orders
         (provider, external_account_id, external_order_id, display_number,
          created_at_source, updated_at_source, local_order_date, currency, gross_amount,
          payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
          raw_snapshot_json, normalized_snapshot_json)
       VALUES
         ('SHOPIFY', 'dashboard-test', 'weak-aruba-candidate', '#WEAK', now(), now(),
          CURRENT_DATE - 2, 'EUR', 1000, 'PAID', 'FULFILLED', 'GROUPED', $1, $2, '{}',
          '{"orderReviewRequired":false,"deferredReviewRequired":false,"totalsReconciled":true,
            "customerSnapshot":{"canonicalProfile":{}}}')
       RETURNING id`,
      [customer.rows[0]!.id, cases.rows[2]!.id],
    );
    const remote = await client.getPool().query<{ id: string }>(
      `INSERT INTO aruba_remote_documents
         (environment, account_reference, remote_id, document_type, fiscal_year,
          document_date, total_amount, remote_status, remote_status_observed_at,
          metadata_digest, automatic_source, provider_group_id)
       VALUES ('MOCK', 'synthetic-aruba-account', 'weak-official-match', 'TD01', 2026,
               CURRENT_DATE - 2, 1000, 'DELIVERED', now(), repeat('c', 64),
               'API', 'weak-official-match')
       RETURNING id`,
    );
    await client.getPool().query(
      `INSERT INTO aruba_document_matches
         (remote_document_id, status, method, matcher_version, candidates_json)
       VALUES ($1, 'AMBIGUOUS', 'NONE', 1,
         jsonb_build_array(jsonb_build_object(
           'candidateId', $2::text, 'probe', true, 'potential', true,
           'compatible', false, 'signals', '{}'::jsonb)))`,
      [remote.rows[0]!.id, order.rows[0]!.id],
    );

    const inventory = await import("./aruba-inventory-health.server.ts");
    assert.equal((await inventory.getArubaInventoryHealth()).ambiguous, 1);

    const status = await import("./billing-case-status.server.ts");
    const transaction = await client.getPool().connect();
    try {
      await transaction.query("BEGIN");
      assert.equal(
        await status.recomputeBillingCaseStatus(transaction, cases.rows[2]!.id),
        "NEEDS_REVIEW",
      );
      await transaction.query("COMMIT");
    } finally {
      transaction.release();
    }
    assert.deepEqual((await orders.getBillingCase(cases.rows[2]!.id))!.anomalies, [
      "ARUBA_POTENTIAL_MATCH",
    ]);
    assert.equal((await orders.dashboardSummary()).review_cases, "1");

    await client
      .getPool()
      .query("UPDATE aruba_remote_documents SET xml_sha256 = repeat('d', 64) WHERE id = $1", [
        remote.rows[0]!.id,
      ]);
    const reconciliation = await client.getPool().connect();
    try {
      await reconciliation.query("BEGIN");
      assert.equal(await status.recomputeOpenBillingCaseStatuses(reconciliation), 1);
      await reconciliation.query("COMMIT");
    } finally {
      reconciliation.release();
    }
    assert.equal((await orders.getBillingCase(cases.rows[2]!.id))!.status, "READY");
    assert.deepEqual((await orders.getBillingCase(cases.rows[2]!.id))!.anomalies, []);
    assert.equal((await inventory.getArubaInventoryHealth()).ambiguous, 0);
  } finally {
    await client.closePool();
    await database.drop();
  }
});
