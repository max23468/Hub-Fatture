import assert from "node:assert/strict";
import test from "node:test";

import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

test("solo lo scarto autorevole di tutte le submission ricrea la preparazione", async () => {
  const database = await temporaryDatabase("rejected_invoice_requeue");
  process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
  process.env.APP_BASE_URL = "http://localhost:8080";
  process.env.APP_ENV = "test";
  process.env.DATABASE_URL = database.connectionString;
  try {
    await runMigrations({ connectionString: database.connectionString });
    const { closePool, getPool, withTransaction } = await import("./client.server.ts");
    const { requeueAuthoritativelyRejectedInvoice } =
      await import("./rejected-invoice-requeue.server.ts");
    const pool = getPool();
    await pool.query(
      `INSERT INTO users (username, password_hash, can_approve)
       VALUES ('Massimo', 'synthetic', true);
       INSERT INTO fiscal_profiles (version, status, profile_json)
       VALUES (1, 'MOCK', '{}')`,
    );
    const fixture = await pool.query<{
      document_id: string;
      old_case_id: string;
      order_id: string;
      storage_id: string;
    }>(
      `WITH customer AS (
         INSERT INTO customers
           (kind, match_key, display_name, billing_address_json,
            source_confidence, review_required)
         VALUES ('PRIVATE_IT', 'rejected-requeue', 'Cliente sintetico', '{}', 'TAX_ID', false)
         RETURNING id
       ), old_case AS (
         INSERT INTO billing_cases
           (customer_id, local_order_date, currency, status, customer_snapshot_json,
            fiscal_profile_version)
         SELECT id, '2026-08-30', 'EUR', 'APPROVED',
                '{"reviewRequired":false,"canonicalProfile":{}}', 1
         FROM customer RETURNING id, customer_id
       ), source_order AS (
         INSERT INTO orders
           (provider, external_account_id, external_order_id, display_number,
            created_at_source, updated_at_source, local_order_date, currency, gross_amount,
            payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
            raw_snapshot_json, normalized_snapshot_json)
         SELECT 'SHOPIFY', 'shop', 'rejected-order', '#REJECTED', now(), now(),
                '2026-08-30', 'EUR', 15850, 'PAID', 'FULFILLED', 'INVOICED',
                customer_id, id, '{}',
                '{"orderReviewRequired":false,"deferredReviewRequired":false,
                  "customerSnapshot":{"reviewRequired":false,"canonicalProfile":{}}}'
         FROM old_case RETURNING id, billing_case_id
       ), stored AS (
         INSERT INTO storage_objects
           (kind, relative_path, sha256, size_bytes, content_type)
         VALUES ('INVOICE_XML', 'invoices/rejected.xml', repeat('a', 64), 1,
                 'application/xml') RETURNING id
       ), invoice AS (
         INSERT INTO documents
           (billing_case_id, kind, status, document_type, series, document_date,
            fiscal_profile_version, currency, total_amount, source_total_amount,
            difference_amount, projection_sha256, payment_status, payment_method,
            recipient_snapshot_json)
         SELECT billing_case_id, 'INVOICE', 'DRAFT', 'TD01', 'FPR', '2026-08-30',
                1, 'EUR', 15850, 15850, 0, repeat('b', 64), 'PAID', 'MP08', '{}'
         FROM source_order RETURNING id, billing_case_id
       ), linked AS (
         INSERT INTO document_orders (document_id, document_kind, order_id, amount)
         SELECT invoice.id, 'INVOICE', source_order.id, 15850 FROM invoice, source_order
       )
       SELECT invoice.id::text AS document_id,
              invoice.billing_case_id::text AS old_case_id,
              source_order.id::text AS order_id,
              stored.id::text AS storage_id
       FROM invoice, source_order, stored`,
    );
    const ids = fixture.rows[0]!;
    const refundedOrder = await pool.query<{ id: string }>(
      `INSERT INTO orders
         (provider, external_account_id, external_order_id, display_number,
          created_at_source, updated_at_source, local_order_date, currency, gross_amount,
          payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
          raw_snapshot_json, normalized_snapshot_json)
       SELECT provider, external_account_id, 'rejected-refunded-order', '#REFUNDED',
              now(), now(), local_order_date, currency, gross_amount,
              'REFUNDED', fulfillment_status, 'INVOICED', customer_id, billing_case_id,
              '{}', normalized_snapshot_json
       FROM orders WHERE id = $1 RETURNING id::text`,
      [ids.order_id],
    );
    await pool.query(
      `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
       VALUES ($1, 'INVOICE', $2, 15850)`,
      [ids.document_id, refundedOrder.rows[0]!.id],
    );
    await pool.query(
      `UPDATE documents
       SET status = 'APPROVED', fiscal_year = 2026, fiscal_number = 1713,
           approved_at = now(), xml_sha256 = repeat('c', 64),
           immutable_snapshot_json = '{}', fiscal_profile_snapshot_json = '{}',
           storage_object_id = $2
       WHERE id = $1`,
      [ids.document_id, ids.storage_id],
    );
    await pool.query(
      `INSERT INTO aruba_batches
         (id, environment, mode, account_reference, manifest_sha256, document_count,
          status, created_by, transport)
       VALUES ('00000000-0000-4000-8000-000000000741', 'MOCK', 'DOCUMENT_ONLY',
         'synthetic', repeat('d', 64), 1, 'RECONCILED', 1, 'API')`,
    );
    const submissions = await pool.query<{ id: string; status: string }>(
      `INSERT INTO aruba_submissions
         (batch_id, document_id, attempt_number, environment, mode, manifest_sha256,
          xml_sha256, status, transport)
       VALUES
         ('00000000-0000-4000-8000-000000000741', $1, 1, 'MOCK', 'DOCUMENT_ONLY',
          repeat('d', 64), repeat('c', 64), 'REJECTED', 'API'),
         ('00000000-0000-4000-8000-000000000741', $1, 2, 'MOCK', 'DOCUMENT_ONLY',
          repeat('d', 64), repeat('c', 64), 'SDI_PROCESSING', 'API')
       RETURNING id::text, status`,
      [ids.document_id],
    );
    const rejectedId = submissions.rows.find((row) => row.status === "REJECTED")!.id;
    const processingId = submissions.rows.find((row) => row.status === "SDI_PROCESSING")!.id;

    assert.deepEqual(
      await withTransaction((client) =>
        requeueAuthoritativelyRejectedInvoice(client, rejectedId, {
          requestId: "test-rejected-not-yet-authoritative",
        }),
      ),
      { affectedCount: 0, billingCaseIds: [] },
    );
    await pool.query("UPDATE aruba_submissions SET status = 'REJECTED' WHERE id = $1", [
      processingId,
    ]);
    const requeued = await withTransaction((client) =>
      requeueAuthoritativelyRejectedInvoice(client, processingId, {
        requestId: "test-rejected-authoritative",
      }),
    );
    assert.equal(requeued.affectedCount, 1);
    assert.equal(requeued.billingCaseIds.length, 1);
    assert.notEqual(requeued.billingCaseIds[0], ids.old_case_id);

    const state = await pool.query<{
      old_document_status: string;
      old_case_status: string;
      trigger_status: string;
      new_case_id: string;
      new_case_status: string;
      audit_count: number;
    }>(
      `SELECT documents.status AS old_document_status,
              old_case.status AS old_case_status,
              orders.trigger_status,
              orders.billing_case_id::text AS new_case_id,
              new_case.status AS new_case_status,
              (SELECT count(*)::integer FROM audit_events
               WHERE action = 'INVOICE_REJECTED_REQUEUED') AS audit_count
       FROM documents
       JOIN billing_cases AS old_case ON old_case.id = documents.billing_case_id
       JOIN document_orders ON document_orders.document_id = documents.id
       JOIN orders ON orders.id = document_orders.order_id
       JOIN billing_cases AS new_case ON new_case.id = orders.billing_case_id
       WHERE documents.id = $1 AND orders.id = $2`,
      [ids.document_id, ids.order_id],
    );
    assert.deepEqual(state.rows[0], {
      old_document_status: "APPROVED",
      old_case_status: "APPROVED",
      trigger_status: "GROUPED",
      new_case_id: requeued.billingCaseIds[0],
      new_case_status: "READY",
      audit_count: 1,
    });
    assert.deepEqual(
      (
        await pool.query(
          `SELECT payment_status, trigger_status, billing_case_id::text AS billing_case_id
           FROM orders WHERE id = $1`,
          [refundedOrder.rows[0]!.id],
        )
      ).rows[0],
      {
        payment_status: "REFUNDED",
        trigger_status: "INVOICED",
        billing_case_id: ids.old_case_id,
      },
    );

    const draft = await pool.query<{ id: string }>(
      `INSERT INTO documents
         (billing_case_id, kind, status, document_type, series, document_date,
          fiscal_profile_version, currency, total_amount, source_total_amount,
          difference_amount, projection_sha256, payment_status, payment_method,
          recipient_snapshot_json)
       VALUES ($1, 'INVOICE', 'DRAFT', 'TD01', 'FPR', '2026-09-04', 1, 'EUR',
         15850, 15850, 0, repeat('e', 64), 'PAID', 'MP08', '{}') RETURNING id::text`,
      [requeued.billingCaseIds[0]],
    );
    await pool.query(
      `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
       VALUES ($1, 'INVOICE', $2, 15850)`,
      [draft.rows[0]!.id, ids.order_id],
    );
    assert.equal(
      (
        await pool.query(
          `SELECT count(*)::integer AS count FROM document_orders
           WHERE order_id = $1 AND document_kind = 'INVOICE'`,
          [ids.order_id],
        )
      ).rows[0].count,
      2,
    );
    const competingCase = await pool.query<{ id: string }>(
      `INSERT INTO billing_cases
         (customer_id, local_order_date, currency, status, customer_snapshot_json,
          fiscal_profile_version)
       SELECT customer_id, local_order_date + 1, currency, 'READY', customer_snapshot_json, 1
       FROM billing_cases WHERE id = $1 RETURNING id::text`,
      [requeued.billingCaseIds[0]],
    );
    const competingDraft = await pool.query<{ id: string }>(
      `INSERT INTO documents
         (billing_case_id, kind, status, document_type, series, document_date,
          fiscal_profile_version, currency, total_amount, source_total_amount,
          difference_amount, projection_sha256, payment_status, payment_method,
          recipient_snapshot_json)
       VALUES ($1, 'INVOICE', 'DRAFT', 'TD01', 'FPR', '2026-09-05', 1, 'EUR',
         15850, 15850, 0, repeat('f', 64), 'PAID', 'MP08', '{}') RETURNING id::text`,
      [competingCase.rows[0]!.id],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
         VALUES ($1, 'INVOICE', $2, 15850)`,
        [competingDraft.rows[0]!.id, ids.order_id],
      ),
      /Ordine già collegato a una fattura efficace o modificabile/,
    );
    assert.deepEqual(
      await withTransaction((client) =>
        requeueAuthoritativelyRejectedInvoice(client, processingId, {
          requestId: "test-rejected-idempotent",
        }),
      ),
      { affectedCount: 0, billingCaseIds: [] },
    );
    await closePool();
  } finally {
    await import("./client.server.ts").then(({ closePool }) => closePool());
    await database.drop();
  }
});
