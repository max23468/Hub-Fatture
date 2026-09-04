import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PAGE_SIZE } from "../orders.ts";
import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

test("l’archivio documenti filtra, riepiloga e pagina un dataset denso", async () => {
  const clean = await temporaryDatabase("document_archive");
  try {
    await runMigrations({ connectionString: clean.connectionString });
    process.env.APP_ENV = "test";
    process.env.APP_BASE_URL = "http://localhost:8080";
    process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
    process.env.DATABASE_URL = clean.connectionString;

    const documents = await import("./document-archive.server.ts");
    const aruba = await import("./aruba.server.ts");
    const email = await import("./email.server.ts");
    const database = await import("./client.server.ts");
    const profile = JSON.parse(
      await readFile("tests/fixtures/fatturapa/profile.mock.json", "utf8"),
    );

    await database
      .getPool()
      .query(
        "INSERT INTO users (username, password_hash, can_approve) VALUES ('Massimo', 'synthetic', true)",
      );
    await database
      .getPool()
      .query("INSERT INTO fiscal_profiles (version, status, profile_json) VALUES (1, 'MOCK', $1)", [
        profile,
      ]);
    await database.getPool().query(
      `INSERT INTO customers
         (kind, match_key, display_name, billing_address_json,
          source_confidence, review_required)
       SELECT 'PRIVATE_IT', 'archive-customer-' || series,
              CASE WHEN series = 7 THEN 'Cliente %_ letterale'
                   ELSE 'Cliente archivio con denominazione estesa ' || lpad(series::text, 2, '0')
              END,
              '{}', 'TAX_ID', false
       FROM generate_series(1, $1::integer) AS series`,
      [PAGE_SIZE + 6],
    );
    await database.getPool().query(
      `INSERT INTO billing_cases
         (customer_id, local_order_date, currency, status, customer_snapshot_json)
       SELECT id, '2026-01-01'::date + (id::integer - 1), 'EUR', 'READY',
              jsonb_build_object('displayName', display_name)
       FROM customers
       WHERE match_key LIKE 'archive-customer-%'`,
    );
    await database.getPool().query(
      `INSERT INTO documents
         (billing_case_id, kind, status, document_type, series, document_date,
          fiscal_profile_version, currency, total_amount, source_total_amount,
          difference_amount, projection_sha256)
       SELECT billing_cases.id,
              'INVOICE', 'DRAFT', 'TD01',
              'FPR', billing_cases.local_order_date, 1, 'EUR',
              1000 + row_number() OVER (ORDER BY billing_cases.id),
              1000 + row_number() OVER (ORDER BY billing_cases.id),
              0, repeat('0', 64)
       FROM billing_cases
       JOIN customers ON customers.id = billing_cases.customer_id
       WHERE customers.match_key LIKE 'archive-customer-%'`,
    );
    await database.getPool().query(
      `WITH selected_customer AS (
         UPDATE customers
         SET email = 'archivio-univoco@example.invalid',
             tax_id_normalized = 'RSSMRA80A01H501U'
         WHERE id = (
           SELECT id FROM customers WHERE match_key LIKE 'archive-customer-%' ORDER BY id LIMIT 1
         )
         RETURNING id
       ), selected_case AS (
         SELECT billing_cases.id, billing_cases.customer_id
         FROM billing_cases JOIN selected_customer ON selected_customer.id = billing_cases.customer_id
       ), selected_order AS (
         INSERT INTO orders
           (provider, external_account_id, external_order_id, display_number,
            created_at_source, updated_at_source, local_order_date, currency, gross_amount,
            payment_status, fulfillment_status, trigger_status, customer_id,
            raw_snapshot_json, normalized_snapshot_json, billing_case_id)
         SELECT 'SHOPIFY', 'archive-search', 'archive-external-order', '#ARCHIVIO-UNIVOCO',
                now(), now(), '2026-01-01', 'EUR', 1000, 'PAID', 'FULFILLED', 'GROUPED',
                customer_id, '{}', '{}', id
         FROM selected_case
         RETURNING id, billing_case_id
       )
       INSERT INTO document_orders (document_id, document_kind, order_id, amount)
       SELECT documents.id, documents.kind, selected_order.id, documents.total_amount
       FROM selected_order
       JOIN documents ON documents.billing_case_id = selected_order.billing_case_id
       WHERE documents.kind = 'INVOICE'`,
    );
    const sourcePreparation = await database.getPool().query<{
      document_id: string;
      source_case_id: string;
      source_number: string;
    }>(
      `WITH selected_document AS (
         SELECT documents.id AS document_id, billing_cases.customer_id,
                billing_cases.local_order_date, billing_cases.currency
         FROM documents
         JOIN billing_cases ON billing_cases.id = documents.billing_case_id
         ORDER BY documents.id
         LIMIT 1
       ), source_case AS (
         INSERT INTO billing_cases
           (customer_id, local_order_date, currency, status, customer_snapshot_json)
         SELECT customer_id, local_order_date, currency, 'CLOSED',
                jsonb_build_object('displayName', 'Preparazione originaria sintetica')
         FROM selected_document
         RETURNING id, public_number
       ), linked AS (
         UPDATE documents
         SET source_billing_case_id = source_case.id
         FROM selected_document, source_case
         WHERE documents.id = selected_document.document_id
         RETURNING documents.id
       )
       SELECT linked.id AS document_id, source_case.id AS source_case_id,
              source_case.public_number AS source_number
       FROM linked, source_case`,
    );

    const approved = await database.getPool().query<{
      id: string;
      storage_object_id: string;
      fiscal_number: number;
    }>(
      `WITH approved_customers AS (
         INSERT INTO customers
           (kind, match_key, display_name, billing_address_json,
            source_confidence, review_required)
         VALUES
           ('PRIVATE_IT', 'archive-approved-send', 'Cliente da trasmettere', '{}', 'TAX_ID', false),
           ('PRIVATE_IT', 'archive-approved-reconcile', 'Cliente da riconciliare', '{}', 'TAX_ID', false)
         RETURNING id, display_name
       ), approved_cases AS (
         INSERT INTO billing_cases
           (customer_id, local_order_date, currency, status, customer_snapshot_json)
         SELECT id, '2026-06-01'::date + row_number() OVER (ORDER BY id)::integer,
                'EUR', 'APPROVED',
                jsonb_build_object('displayName', display_name)
         FROM approved_customers
         RETURNING id
       ), stored AS (
         INSERT INTO storage_objects
           (kind, relative_path, sha256, size_bytes, content_type)
         VALUES
           ('INVOICE_XML', 'archive/send.xml', repeat('a', 64), 100, 'application/xml'),
           ('INVOICE_XML', 'archive/reconcile.xml', repeat('b', 64), 100, 'application/xml')
         RETURNING id
       ), case_rows AS (
         SELECT id AS billing_case_id, row_number() OVER (ORDER BY id) AS pair_number
         FROM approved_cases
       ), storage_rows AS (
         SELECT id AS storage_object_id, row_number() OVER (ORDER BY id) AS pair_number
         FROM stored
       ), paired AS (
         SELECT case_rows.billing_case_id, storage_rows.storage_object_id,
                case_rows.pair_number
         FROM case_rows
         JOIN storage_rows USING (pair_number)
       )
       INSERT INTO documents
         (billing_case_id, kind, status, document_type, series, fiscal_year, fiscal_number,
          document_date, fiscal_profile_version, currency, total_amount, source_total_amount,
          difference_amount, projection_sha256, approved_at, xml_sha256,
          immutable_snapshot_json, fiscal_profile_snapshot_json, storage_object_id)
       SELECT billing_case_id, 'INVOICE', 'APPROVED', 'TD01', 'FPR', 2026,
              1000 + pair_number, '2026-06-01'::date + pair_number::integer,
              1, 'EUR', 2500, 2500, 0, repeat('c', 64), now(),
              CASE pair_number WHEN 1 THEN repeat('d', 64) ELSE repeat('e', 64) END,
              '{}', $1, storage_object_id
       FROM paired
       RETURNING id, storage_object_id, fiscal_number`,
      [profile],
    );
    assert.equal(approved.rows.length, 2);
    const toSend = approved.rows.find((row) => row.fiscal_number === 1001)!;
    const toReconcile = approved.rows.find((row) => row.fiscal_number === 1002)!;

    await database.getPool().query(
      `INSERT INTO aruba_batches
         (id, environment, mode, account_reference, manifest_sha256, document_count,
          status, requires_reconciliation, created_by)
       VALUES
         ('00000000-0000-4000-8000-000000000001', 'MOCK', 'DOCUMENT_ONLY', 'synthetic',
          repeat('f', 64), 1, 'RECONCILIATION_REQUIRED', true, 1)`,
    );
    await database.getPool().query(
      `INSERT INTO aruba_batch_documents
         (batch_id, document_id, position, document_revision, xml_sha256, filename)
       VALUES
         ('00000000-0000-4000-8000-000000000001', $1, 1, 1, repeat('e', 64),
          'FPR_1002_26.xml')`,
      [toReconcile.id],
    );
    await database.getPool().query(
      `INSERT INTO connections
         (provider, environment, account_reference, encrypted_credentials, status,
          credentials_verified_at, inbound_enabled, api_paused)
       VALUES ('ARUBA', 'DEVELOPMENT', 'synthetic', 'encrypted', 'CONNECTED',
         now() - interval '2 minutes', true, false)`,
    );
    await database.getPool().query(
      `INSERT INTO aruba_submissions
         (batch_id, document_id, attempt_number, environment, mode, manifest_sha256,
          xml_sha256, status, transport, source_filename, next_readback_at)
       VALUES ('00000000-0000-4000-8000-000000000001', $1, 1, 'MOCK',
         'DOCUMENT_ONLY', repeat('f', 64), repeat('e', 64), 'SUBMITTED', 'API',
         'FPR_1002_26.xml', now() - interval '1 minute')`,
      [toReconcile.id],
    );
    await database.getPool().query(
      `UPDATE aruba_submissions SET provider_filename = 'IT00000000000_ARCHIVE.xml',
         provider_sdi_id = 'SDI-ARCHIVE-1002', last_checked_at = now()
       WHERE document_id = $1`,
      [toReconcile.id],
    );
    await database.getPool().query(
      `UPDATE billing_cases SET customer_snapshot_json = customer_snapshot_json ||
         jsonb_build_object('countryCode', 'IT', 'vatNumber', '12345678901')
       FROM documents WHERE documents.billing_case_id = billing_cases.id
         AND documents.id = $1`,
      [toReconcile.id],
    );
    const { scheduleDueSyncs } = await import("./connector-jobs.server.ts");
    await scheduleDueSyncs();
    const scheduledReadback = await database.getPool().query<{
      readback_kind: string;
      submission_id: string;
    }>(
      `SELECT payload_json ->> 'readbackKind' AS readback_kind,
              payload_json ->> 'submissionId' AS submission_id
       FROM jobs WHERE type = 'aruba_readback_submission'`,
    );
    assert.deepEqual(scheduledReadback.rows, [{ readback_kind: "submission", submission_id: "1" }]);
    await scheduleDueSyncs();
    assert.equal(
      (
        await database
          .getPool()
          .query("SELECT count(*)::int AS total FROM jobs WHERE type = 'aruba_readback_submission'")
      ).rows[0].total,
      1,
    );
    await database.getPool().query(
      `UPDATE aruba_submissions SET status = 'DELIVERED',
         accepted_at = now() - interval '4 minutes',
         submitted_at = now() - interval '3 minutes',
         remote_status_changed_at = now() - interval '1 minute'
       WHERE document_id = $1`,
      [toReconcile.id],
    );
    await database.getPool().query(
      `UPDATE aruba_batches
       SET status = 'RECONCILED', requires_reconciliation = false
       WHERE id = '00000000-0000-4000-8000-000000000001'`,
    );
    const notificationStorage = await database.getPool().query<{ id: string }>(
      `INSERT INTO storage_objects
         (kind, relative_path, sha256, size_bytes, content_type)
       VALUES ('SDI_NOTIFICATION', 'archive/delivered.xml', repeat('9', 64), 100, 'application/xml')
       RETURNING id`,
    );
    await database.getPool().query(
      `INSERT INTO sdi_notifications
         (submission_id, remote_notification_id, type, status, received_at, storage_object_id)
       SELECT id, 'SDI-ARCHIVE-NOTIFICATION', 'DELIVERED', 'DELIVERED',
              now() - interval '1 minute', $2
       FROM aruba_submissions WHERE document_id = $1`,
      [toReconcile.id, notificationStorage.rows[0]!.id],
    );

    const firstPage = await documents.listDocuments();
    const secondPage = await documents.listDocuments({ page: 2 });
    assert.equal(firstPage.rows.length, PAGE_SIZE);
    assert.equal(firstPage.hasNext, true);
    assert.equal(secondPage.rows.length, 8);
    assert.equal(secondPage.hasNext, false);
    assert.equal(
      firstPage.rows.some((row) => secondPage.rows.some((other) => other.id === row.id)),
      false,
    );
    assert.equal(
      (await documents.listDocuments({ sort: { key: "data", direction: "asc" } })).rows[0]
        ?.document_date,
      "2026-01-01",
    );
    assert.equal(
      (await documents.listDocuments({ sort: { key: "totale", direction: "desc" } })).rows[0]
        ?.total_amount,
      2500,
    );
    assert.equal(
      (await documents.listDocuments({ sort: { key: "documento", direction: "asc" } })).rows[0]
        ?.public_number,
      "000001",
    );
    assert.equal(
      (await documents.listDocuments({ sort: { key: "documento", direction: "desc" } })).rows[0]
        ?.fiscal_number,
      1002,
    );

    const invoices = await documents.listDocuments({ kind: "INVOICE" });
    assert.equal(invoices.rows.length, PAGE_SIZE);
    assert.ok(invoices.rows.every((row) => row.kind === "INVOICE"));
    assert.equal((await documents.listDocuments({ kind: "CREDIT_NOTE" })).rows.length, 0);
    assert.equal((await documents.listDocuments({ query: "%_" })).rows.length, 1);
    assert.equal(
      (await documents.listDocuments({ query: "archivio-univoco@example.invalid" })).rows.length,
      1,
    );
    assert.equal((await documents.listDocuments({ query: "RSSMRA80A01H501U" })).rows.length, 1);
    assert.equal((await documents.listDocuments({ query: "#ARCHIVIO-UNIVOCO" })).rows.length, 1);
    const bySourcePreparation = await documents.listDocuments({
      query: sourcePreparation.rows[0]!.source_number,
    });
    assert.equal(bySourcePreparation.rows.length, 1);
    assert.equal(bySourcePreparation.rows[0]!.id, sourcePreparation.rows[0]!.document_id);
    assert.equal(
      bySourcePreparation.rows[0]!.source_billing_case_id,
      sourcePreparation.rows[0]!.source_case_id,
    );
    assert.equal(
      bySourcePreparation.rows[0]!.source_public_number,
      sourcePreparation.rows[0]!.source_number,
    );
    assert.equal(
      (await documents.listDocuments({ dateFrom: "2026-01-07", dateTo: "2026-01-07" })).rows.length,
      1,
    );
    assert.deepEqual(
      (await documents.listDocuments({ transmission: "TO_SEND" })).rows.map((row) => row.id),
      [toSend.id],
    );
    assert.deepEqual(
      (await documents.listDocuments({ transmission: "RECONCILIATION_REQUIRED" })).rows.map(
        (row) => row.id,
      ),
      [],
    );
    assert.deepEqual(
      (await documents.listDocuments({ arubaStatus: "NOT_PREPARED" })).rows.map((row) => row.id),
      [toSend.id],
    );
    assert.deepEqual(
      (await documents.listDocuments({ providerFilename: "ARCHIVE.xml" })).rows.map(
        (row) => row.id,
      ),
      [toReconcile.id],
    );
    const monitoredDocument = (await documents.listDocuments({ providerFilename: "ARCHIVE.xml" }))
      .rows[0]!;
    assert.equal(monitoredDocument.aruba_status, "DELIVERED");
    assert.equal(monitoredDocument.provider_sdi_id, "SDI-ARCHIVE-1002");
    assert.ok(monitoredDocument.remote_status_changed_at);
    assert.deepEqual(
      monitoredDocument.aruba_timeline.map(({ status, source }) => ({ status, source })),
      [
        { status: "ARUBA_ACCEPTED", source: "ARUBA" },
        { status: "SUBMITTED", source: "ARUBA" },
        { status: "DELIVERED", source: "SDI" },
      ],
    );
    assert.deepEqual(
      (await documents.listDocuments({ sdiId: "SDI-ARCHIVE-1002" })).rows.map((row) => row.id),
      [toReconcile.id],
    );
    assert.deepEqual(
      (await documents.listDocuments({ remoteUpdatedFrom: "2026-01-01" })).rows.map(
        (row) => row.id,
      ),
      [toReconcile.id],
    );
    assert.deepEqual(
      (await documents.listDocuments({ origin: "HUB", fiscalNumber: "1002" })).rows.map(
        (row) => row.id,
      ),
      [toReconcile.id],
    );
    assert.deepEqual(
      (
        await documents.listDocuments({ recipientCountry: "it", recipientTaxId: "123 45678901" })
      ).rows.map((row) => row.id),
      [toReconcile.id],
    );
    assert.deepEqual(await documents.documentArchiveSummary(), {
      total: 58,
      invoices: 58,
      credit_notes: 0,
      to_send: 1,
      reconciliation_required: 0,
    });

    const officialStorage = await database.getPool().query<{ id: string }>(
      `INSERT INTO storage_objects
         (kind, relative_path, sha256, size_bytes, content_type)
       VALUES
         ('ARUBA_PDF', 'archive/send.pdf', repeat('1', 64), 100, 'application/pdf'),
         ('ARUBA_PDF', 'archive/reconcile.pdf', repeat('2', 64), 100, 'application/pdf')
       RETURNING id`,
    );
    const remoteOwners = await database.getPool().query<{ id: string }>(
      `INSERT INTO aruba_remote_documents
        (environment, account_reference, remote_id, document_type, fiscal_year, series,
         fiscal_number, document_date, total_amount, remote_status,
         remote_status_observed_at, origin, metadata_digest)
       VALUES
        ('MOCK', 'synthetic-aruba-account', 'archive-send', 'TD01', 2026, 'FPR', '1001',
         '2026-08-12', 100, 'DELIVERED', now(), 'HUB_SUBMISSION', repeat('a', 64)),
        ('MOCK', 'synthetic-aruba-account', 'archive-reconcile', 'TD01', 2026, 'FPR', '1002',
         '2026-08-12', 100, 'UNKNOWN', now(), 'HUB_SUBMISSION', repeat('b', 64))
       RETURNING id`,
    );
    await database.getPool().query(
      `INSERT INTO aruba_files (document_id, remote_document_id, storage_object_id, kind)
       VALUES ($1, $5, $3, 'ARUBA_PDF'), ($2, $6, $4, 'ARUBA_PDF')`,
      [
        toSend.id,
        toReconcile.id,
        officialStorage.rows[0]!.id,
        officialStorage.rows[1]!.id,
        remoteOwners.rows[0]!.id,
        remoteOwners.rows[1]!.id,
      ],
    );
    await database.getPool().query(
      `INSERT INTO email_deliveries
         (message_key, document_id, transport, sender, recipient, subject, body,
          attachment_storage_object_id, status, last_error_code)
       VALUES
         ('00000000-0000-4000-8000-000000000011', $1, 'SYNTHETIC',
          'sender@example.invalid', 'one@example.invalid', 'Uno', 'Uno', $3, 'FAILED', 'SMTP_FAILED'),
         ('00000000-0000-4000-8000-000000000012', $2, 'SYNTHETIC',
          'sender@example.invalid', 'two@example.invalid', 'Due', 'Due', $4, 'PENDING', null)`,
      [toSend.id, toReconcile.id, toSend.storage_object_id, toReconcile.storage_object_id],
    );
    assert.deepEqual(
      (await documents.listDocuments({ sort: { key: "email", direction: "asc" } })).rows
        .slice(0, 2)
        .map(({ id }) => id),
      [toSend.id, toReconcile.id],
    );
    assert.deepEqual(
      (await aruba.listOfficialArubaFiles([toSend.id])).map((file) => file.document_id),
      [toSend.id],
    );
    assert.deepEqual(
      (await email.listEmailDeliveries([toReconcile.id])).map((delivery) => delivery.document_id),
      [toReconcile.id],
    );
    assert.deepEqual(await aruba.listOfficialArubaFiles([]), []);
    assert.deepEqual(await email.listEmailDeliveries([]), []);

    await database.closePool();
  } finally {
    await import("./client.server.ts").then(({ closePool }) => closePool());
    await clean.drop();
  }
});
