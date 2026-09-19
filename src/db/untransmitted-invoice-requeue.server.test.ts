import assert from "node:assert/strict";
import test from "node:test";

import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

test("una fattura dichiarata mai trasmessa riporta l'ordine da fatturare", async () => {
  const database = await temporaryDatabase("untransmitted_invoice_requeue");
  process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
  process.env.APP_BASE_URL = "http://localhost:8080";
  process.env.APP_ENV = "test";
  process.env.DATABASE_URL = database.connectionString;
  try {
    await runMigrations({ connectionString: database.connectionString });
    const { closePool, getPool, withTransaction } = await import("./client.server.ts");
    const { requeueUntransmittedInvoices } = await import("./rejected-invoice-requeue.server.ts");
    const pool = getPool();
    await pool.query(
      `INSERT INTO users (username, password_hash, can_approve)
       VALUES ('Massimo', 'synthetic', true);
       INSERT INTO fiscal_profiles (version, status, profile_json)
       VALUES (1, 'MOCK', '{}')`,
    );
    const ids = (
      await pool.query<{ document_id: string; order_id: string; old_case_id: string }>(
        `WITH customer AS (
           INSERT INTO customers
             (kind, match_key, display_name, billing_address_json,
              source_confidence, review_required)
           VALUES ('PRIVATE_IT', 'untransmitted', 'Cliente sintetico', '{}', 'TAX_ID', false)
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
           SELECT 'EBAY', 'seller', 'untransmitted-order', '62295', now(), now(),
                  '2026-08-30', 'EUR', 15850, 'PAID', 'FULFILLED', 'INVOICED',
                  customer_id, id, '{}',
                  '{"orderReviewRequired":false,"deferredReviewRequired":false,
                    "customerSnapshot":{"reviewRequired":false,"canonicalProfile":{}}}'
           FROM old_case RETURNING id, billing_case_id
         ), stored AS (
           INSERT INTO storage_objects
             (kind, relative_path, sha256, size_bytes, content_type)
           VALUES ('INVOICE_XML', 'invoices/untransmitted.xml', repeat('a', 64), 1,
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
         ), approved AS (
           SELECT invoice.id, stored.id AS storage_id FROM invoice, stored
         )
         SELECT approved.id::text AS document_id, source_order.id::text AS order_id,
                source_order.billing_case_id::text AS old_case_id
         FROM approved, source_order`,
      )
    ).rows[0]!;
    await pool.query(
      `UPDATE documents
       SET status = 'APPROVED', fiscal_year = 2026, fiscal_number = 1713,
           approved_at = now(), xml_sha256 = repeat('c', 64),
           immutable_snapshot_json = '{}', fiscal_profile_snapshot_json = '{}',
           storage_object_id = (SELECT id FROM storage_objects LIMIT 1)
       WHERE id = $1;
       INSERT INTO aruba_batches
         (id, environment, mode, account_reference, manifest_sha256, document_count,
          status, created_by, transport)
       VALUES ('00000000-0000-4000-8000-000000000742', 'MOCK', 'DOCUMENT_ONLY',
         'synthetic', repeat('d', 64), 1, 'ARUBA_ACCEPTED', 1, 'API');
       INSERT INTO aruba_submissions
         (batch_id, document_id, attempt_number, environment, mode, manifest_sha256,
          xml_sha256, status, transport, remote_id)
       VALUES ('00000000-0000-4000-8000-000000000742', $1, 1, 'MOCK', 'DOCUMENT_ONLY',
         repeat('d', 64), repeat('c', 64), 'SUBMITTED', 'API', 'phantom-group');`.replace(
        /\$1/g,
        ids.document_id,
      ),
    );
    const remote = (
      await pool.query<{ id: string }>(
        `INSERT INTO aruba_remote_documents
           (environment, account_reference, remote_id, document_type, fiscal_year, series,
            fiscal_number, document_date, total_amount, remote_status,
            remote_status_observed_at, metadata_digest, automatic_source, provider_group_id,
            provider_sdi_id)
         VALUES ('MOCK', 'synthetic', 'phantom-group:0001', 'TD01', 2026, 'FPR', '1713',
           '2026-08-30', 15850, 'SUBMITTED', now() - interval '10 days', repeat('e', 64),
           'API', 'phantom-group', '0')
         RETURNING id::text`,
      )
    ).rows[0]!;
    await pool.query(
      `INSERT INTO aruba_document_matches
         (remote_document_id, status, method, matcher_version, signals_json, decided_by,
          decision_reason, decided_at)
       VALUES ($1, 'UNMATCHED', 'MANUAL', 1, '{"identityCollisionExcluded":true}', 1,
         'Documento sintetico escluso come errato', now())`,
      [remote.id],
    );
    const sweep = () =>
      withTransaction((client) => requeueUntransmittedInvoices(client, "test-untransmitted"));

    // Senza la dichiarazione del titolare la fattura resta emessa.
    assert.equal(await sweep(), 0);
    await pool.query(
      `UPDATE aruba_document_matches SET signals_json = signals_json || jsonb_build_object(
         'transmissionAbsence', jsonb_build_object('metadataDigest', repeat('e', 64)))
       WHERE remote_document_id = $1`,
      [remote.id],
    );
    assert.equal(await sweep(), 1);
    assert.equal(await sweep(), 0, "il recupero riporta l'ordine una sola volta");
    const order = (
      await pool.query<{ trigger_status: string; billing_case_id: string; status: string }>(
        `SELECT orders.trigger_status, orders.billing_case_id::text, billing_cases.status
         FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
         WHERE orders.id = $1`,
        [ids.order_id],
      )
    ).rows[0]!;
    assert.equal(order.trigger_status, "GROUPED");
    assert.notEqual(order.billing_case_id, ids.old_case_id);
    assert.equal(order.status, "READY");
    assert.equal(
      (
        await pool.query(
          `SELECT count(*)::integer AS count FROM audit_events
           WHERE action = 'INVOICE_NOT_TRANSMITTED_REQUEUED'`,
        )
      ).rows[0].count,
      1,
    );
    // Il vincolo del database accetta la nuova fattura: quella mai trasmessa non è efficace.
    const draft = await pool.query<{ id: string }>(
      `INSERT INTO documents
         (billing_case_id, kind, status, document_type, series, document_date,
          fiscal_profile_version, currency, total_amount, source_total_amount,
          difference_amount, projection_sha256, payment_status, payment_method,
          recipient_snapshot_json)
       VALUES ($1, 'INVOICE', 'DRAFT', 'TD01', 'FPR', '2026-09-19', 1, 'EUR',
         15850, 15850, 0, repeat('f', 64), 'PAID', 'MP08', '{}') RETURNING id::text`,
      [order.billing_case_id],
    );
    await pool.query(
      `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
       VALUES ($1, 'INVOICE', $2, 15850)`,
      [draft.rows[0]!.id, ids.order_id],
    );
    await closePool();
  } finally {
    await import("./client.server.ts").then(({ closePool }) => closePool());
    await database.drop();
  }
});
