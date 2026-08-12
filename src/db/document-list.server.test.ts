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

    const documents = await import("./documents.server.ts");
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
         ('00000000-0000-4000-8000-000000000001', 'MOCK', 'ASSISTED', 'synthetic',
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

    const invoices = await documents.listDocuments({ kind: "INVOICE" });
    assert.equal(invoices.rows.length, PAGE_SIZE);
    assert.ok(invoices.rows.every((row) => row.kind === "INVOICE"));
    assert.equal((await documents.listDocuments({ kind: "CREDIT_NOTE" })).rows.length, 0);
    assert.equal((await documents.listDocuments({ query: "%_" })).rows.length, 1);
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
      [toReconcile.id],
    );
    assert.deepEqual(
      (await documents.listDocuments({ arubaStatus: "NOT_PREPARED" })).rows.map((row) => row.id),
      [toSend.id],
    );
    assert.deepEqual(await documents.documentArchiveSummary(), {
      total: 58,
      invoices: 58,
      credit_notes: 0,
      to_send: 1,
      reconciliation_required: 1,
    });

    const officialStorage = await database.getPool().query<{ id: string }>(
      `INSERT INTO storage_objects
         (kind, relative_path, sha256, size_bytes, content_type)
       VALUES
         ('ARUBA_PDF', 'archive/send.pdf', repeat('1', 64), 100, 'application/pdf'),
         ('ARUBA_PDF', 'archive/reconcile.pdf', repeat('2', 64), 100, 'application/pdf')
       RETURNING id`,
    );
    await database.getPool().query(
      `INSERT INTO aruba_files (document_id, storage_object_id, kind)
       VALUES ($1, $3, 'ARUBA_PDF'), ($2, $4, 'ARUBA_PDF')`,
      [toSend.id, toReconcile.id, officialStorage.rows[0]!.id, officialStorage.rows[1]!.id],
    );
    await database.getPool().query(
      `INSERT INTO email_deliveries
         (message_key, document_id, transport, sender, recipient, subject, body,
          attachment_storage_object_id, status, last_error_code)
       VALUES
         ('00000000-0000-4000-8000-000000000011', $1, 'SYNTHETIC',
          'sender@example.invalid', 'one@example.invalid', 'Uno', 'Uno', $3, 'FAILED', 'SMTP_FAILED'),
         ('00000000-0000-4000-8000-000000000012', $2, 'SYNTHETIC',
          'sender@example.invalid', 'two@example.invalid', 'Due', 'Due', $4, 'FAILED', 'SMTP_FAILED')`,
      [toSend.id, toReconcile.id, toSend.storage_object_id, toReconcile.storage_object_id],
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
