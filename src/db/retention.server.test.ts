import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

test("la retention applica durate e hold senza alterare l'evidenza fiscale", async () => {
  const databaseFixture = await temporaryDatabase("retention");
  try {
    await runMigrations({ connectionString: databaseFixture.connectionString });
    process.env.APP_ENV = "test";
    process.env.APP_BASE_URL = "http://localhost:8080";
    process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
    process.env.DATABASE_URL = databaseFixture.connectionString;

    const database = await import("./client.server.ts");
    const { applyRetentionPolicy } = await import("./retention.server.ts");
    const client = database.getPool();
    const user = await client.query<{ id: string }>(
      "INSERT INTO users (username, password_hash, can_approve) VALUES ('Massimo', 'synthetic', true) RETURNING id",
    );
    const userId = user.rows[0]!.id;
    await client.query(
      `INSERT INTO fiscal_profiles (version, status, profile_json)
       VALUES (1, 'MOCK', '{"payment":{"invoiceMethod":"MP08","creditNoteMethod":"MP05"}}')`,
    );
    const customer = await client.query<{ id: string }>(
      `INSERT INTO customers
         (kind, match_key, display_name, email, billing_address_json,
          source_confidence, review_required)
       VALUES ('PRIVATE_IT', 'retention-customer', 'Cliente Sintetico',
               'cliente@example.invalid', '{}', 'TAX_ID', false)
       RETURNING id`,
    );
    const billingCase = await client.query<{ id: string }>(
      `INSERT INTO billing_cases
         (customer_id, local_order_date, currency, status, customer_snapshot_json,
          fiscal_profile_version)
       VALUES ($1, current_date, 'EUR', 'APPROVED', '{}', 1)
       RETURNING id`,
      [customer.rows[0]!.id],
    );
    const order = await client.query<{ id: string }>(
      `INSERT INTO orders
         (provider, external_account_id, external_order_id, display_number,
          created_at_source, updated_at_source, local_order_date, currency, gross_amount,
          payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
          raw_snapshot_json, normalized_snapshot_json)
       VALUES ('SHOPIFY', 'retention-shop', 'retention-order', '#RETENTION',
               now() - interval '200 days', now() - interval '200 days', current_date,
               'EUR', 1000, 'PAID', 'FULFILLED', 'INVOICED', $1, $2, '{}', '{}')
       RETURNING id`,
      [customer.rows[0]!.id, billingCase.rows[0]!.id],
    );
    const storage = await client.query<{ id: string }>(
      `INSERT INTO storage_objects (kind, relative_path, sha256, size_bytes, content_type)
       VALUES ('INVOICE_XML', 'retention/invoice.xml', $1, 1, 'application/xml')
       RETURNING id`,
      ["a".repeat(64)],
    );
    const document = await client.query<{ id: string }>(
      `INSERT INTO documents
         (billing_case_id, kind, status, document_type, series, document_date,
          fiscal_profile_version, currency, total_amount, source_total_amount,
          difference_amount, projection_sha256, recipient_snapshot_json,
          customer_email_mode, customer_email_choice, customer_email_sender,
          customer_email_recipient, customer_email_subject, customer_email_body)
       VALUES ($1, 'INVOICE', 'DRAFT', 'TD01', 'FPR', current_date, 1, 'EUR',
               1000, 1000, 0, $2, '{}', 'AUTOMATIC', 'SEND',
               'contabilita@example.invalid', 'cliente@example.invalid',
               'Documento fiscale sintetico', 'Contenuto sintetico')
       RETURNING id`,
      [billingCase.rows[0]!.id, "b".repeat(64)],
    );
    await client.query(
      `UPDATE documents
       SET status = 'APPROVED', fiscal_year = 2026, fiscal_number = 991,
           approved_at = now() - interval '100 days', xml_sha256 = $2,
           immutable_snapshot_json = '{}', fiscal_profile_snapshot_json = '{}',
           storage_object_id = $3
       WHERE id = $1`,
      [document.rows[0]!.id, "c".repeat(64), storage.rows[0]!.id],
    );
    await client.query(
      `INSERT INTO email_deliveries
         (message_key, document_id, transport, sender, recipient, subject, body,
          attachment_storage_object_id, status, message_id, sent_at, created_at, updated_at)
       VALUES ($1, $2, 'SYNTHETIC', 'contabilita@example.invalid',
               'cliente@example.invalid', 'Documento fiscale sintetico',
               'Contenuto sintetico', $3, 'SENT', 'synthetic-message',
               now() - interval '100 days', now() - interval '100 days',
               now() - interval '100 days')`,
      [randomUUID(), document.rows[0]!.id, storage.rows[0]!.id],
    );

    await client.query(
      `INSERT INTO webhook_events
         (provider, external_event_id, topic, payload_sha256, request_payload_json,
          received_at, processed_at, status)
       VALUES ('SHOPIFY', 'retention-event', 'orders/updated', $1,
               '{"personal":"payload"}', now() - interval '31 days',
               now() - interval '31 days', 'PROCESSED')`,
      ["d".repeat(64)],
    );
    await client.query(
      `INSERT INTO webhook_events
         (provider, external_event_id, topic, payload_sha256, request_payload_json,
          received_at, status, error_code)
       VALUES ('SHOPIFY', 'retention-event-unresolved', 'orders/updated', $1,
               '{"personal":"unresolved"}', now() - interval '31 days',
               'FAILED', 'PROVIDER_SCHEMA_INVALID')`,
      ["1".repeat(64)],
    );
    await client.query(
      `INSERT INTO refunds
         (provider, external_account_id, external_order_id, external_refund_id,
          order_id, status, amount, completed_at, raw_json, created_at, updated_at)
       VALUES ('SHOPIFY', 'retention-shop', 'retention-order', 'retention-refund',
               $1, 'COMPLETED', 100, now() - interval '31 days',
               '{"personal":"refund"}', now() - interval '31 days',
               now() - interval '31 days')`,
      [order.rows[0]!.id],
    );
    await client.query(
      `INSERT INTO jobs (type, status, completed_at, created_at, payload_json, result_json)
       VALUES ('shopify_sync_orders', 'COMPLETED', now() - interval '181 days',
               now() - interval '181 days', '{"secret":"old"}', '{"result":"old"}')`,
    );
    await client.query(
      `INSERT INTO audit_events
         (actor_type, action, event_class, entity_type, request_id, created_at)
       VALUES
         ('SYSTEM', 'LOGIN_SUCCEEDED', 'OPERATIONAL', 'USER',
          'retention-old-operational', now() - interval '181 days'),
         ('SYSTEM', 'DOCUMENT_APPROVED', 'CRITICAL', 'DOCUMENT',
          'retention-old-critical', now() - interval '181 days')`,
    );

    const batchId = randomUUID();
    await client.query(
      `INSERT INTO aruba_batches
         (id, environment, mode, account_reference, manifest_sha256, document_count,
          status, created_by)
       VALUES ($1, 'MOCK', 'AUTOMATIC', 'synthetic', $2, 1, 'CANCELLED', $3)`,
      [batchId, "e".repeat(64), userId],
    );
    await client.query(
      `INSERT INTO aruba_helper_tokens
         (token_hash, batch_id, expires_at, revoked_at, created_at)
       VALUES ($1, $2, now() - interval '31 days', now() - interval '31 days',
               now() - interval '40 days')`,
      ["f".repeat(64), batchId],
    );
    await client.query(
      `INSERT INTO aruba_send_permits
         (id, batch_id, manifest_sha256, document_count, mode, authorized_by,
          authorized_at, expires_at, consumed_at)
       VALUES ($1, $2, $3, 1, 'AUTOMATIC', $4, now() - interval '40 days',
               now() - interval '31 days', now() - interval '31 days')`,
      [randomUUID(), batchId, "e".repeat(64), userId],
    );
    await client.query(
      `INSERT INTO retention_holds (data_class, reason, approved_by, review_at)
       VALUES ('SOURCE_PAYLOADS', 'Verifica sintetica in corso', $1, now() + interval '1 day')`,
      [userId],
    );

    const first = await applyRetentionPolicy();
    assert.deepEqual(first, {
      SOURCE_PAYLOADS: 0,
      OPERATIONAL_JOBS: 1,
      OPERATIONAL_AUDIT: 1,
      CUSTOMER_EMAIL: 1,
      ARUBA_CREDENTIALS: 2,
    });
    assert.deepEqual(
      (
        await client.query(
          `SELECT request_payload_json, (SELECT raw_json FROM refunds
             WHERE external_refund_id = 'retention-refund') AS refund_raw
           FROM webhook_events WHERE external_event_id = 'retention-event'`,
        )
      ).rows[0],
      { request_payload_json: { personal: "payload" }, refund_raw: { personal: "refund" } },
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM audit_events WHERE request_id = 'retention-old-critical'",
        )
      ).rows[0]!.count,
      1,
    );
    assert.deepEqual(
      (
        await client.query(
          `SELECT recipient, subject, body, content_redacted_at IS NOT NULL AS redacted
           FROM email_deliveries WHERE document_id = $1`,
          [document.rows[0]!.id],
        )
      ).rows[0],
      { recipient: "[redatto]", subject: "[redatto]", body: "[redatto]", redacted: true },
    );
    assert.deepEqual(
      (
        await client.query(
          `SELECT customer_email_recipient, customer_email_redacted_at IS NOT NULL AS redacted
           FROM documents WHERE id = $1`,
          [document.rows[0]!.id],
        )
      ).rows[0],
      { customer_email_recipient: "[redatto]", redacted: true },
    );
    await assert.rejects(
      client.query("UPDATE documents SET total_amount = total_amount + 1 WHERE id = $1", [
        document.rows[0]!.id,
      ]),
      /documento approvato è immutabile/i,
    );

    await client.query(
      `UPDATE retention_holds
       SET released_at = now(), released_by = $1
       WHERE data_class = 'SOURCE_PAYLOADS' AND released_at IS NULL`,
      [userId],
    );
    const second = await applyRetentionPolicy();
    assert.equal(second.SOURCE_PAYLOADS, 2);
    assert.deepEqual(
      (
        await client.query(
          `SELECT request_payload_json, (SELECT raw_json FROM refunds
             WHERE external_refund_id = 'retention-refund') AS refund_raw
           FROM webhook_events WHERE external_event_id = 'retention-event'`,
        )
      ).rows[0],
      { request_payload_json: {}, refund_raw: {} },
    );
    assert.deepEqual(
      (
        await client.query(
          `SELECT request_payload_json FROM webhook_events
           WHERE external_event_id = 'retention-event-unresolved'`,
        )
      ).rows[0],
      { request_payload_json: { personal: "unresolved" } },
    );
    assert.equal(
      (
        await client.query(
          `SELECT count(*)::int AS count FROM audit_events
           WHERE action = 'RETENTION_APPLIED'
             AND metadata_json ? 'dataClass'
             AND metadata_json ? 'affectedCount'
             AND before_json IS NULL AND after_json IS NULL`,
        )
      ).rows[0]!.count,
      5,
    );
  } finally {
    await import("./client.server.ts").then(({ closePool }) => closePool());
    await databaseFixture.drop();
  }
});
