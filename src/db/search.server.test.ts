import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runMigrations } from "./migrations.server.ts";
import { temporaryDatabase } from "./database-fixture.ts";

test(
  "la ricerca globale copre ogni ambito e non interpreta i caratteri SQL",
  { timeout: 30_000 },
  async () => {
    const clean = await temporaryDatabase("global_search");
    try {
      await runMigrations({ connectionString: clean.connectionString });
      process.env.APP_ENV = "test";
      process.env.APP_BASE_URL = "http://localhost:8080";
      process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
      process.env.DATABASE_URL = clean.connectionString;

      const database = await import("./client.server.ts");
      const orders = await import("./order-import.server.ts");
      const search = await import("./search.server.ts");
      const profile = JSON.parse(
        await readFile("tests/fixtures/fatturapa/profile.mock.json", "utf8"),
      );
      await database
        .getPool()
        .query(
          "INSERT INTO fiscal_profiles (version, status, profile_json) VALUES (1, 'MOCK', $1)",
          [profile],
        );
      const fixture = JSON.parse(
        await readFile("tests/fixtures/orders/normalized.mock.json", "utf8"),
      );
      await orders.importOrders(fixture, { id: 1, requestId: "test-global-search" });

      const orderResult = await search.searchGlobal("S-1001");
      assert.equal(orderResult.orders.length, 1);
      assert.deepEqual(orderResult.documents, orderResult.invoices);
      assert.equal(orderResult.orders[0]!.provider, "SHOPIFY");
      assert.match(orderResult.orders[0]!.href, /^\/ordini\/\d+$/);

      const customer = (
        await database.getPool().query(
          `SELECT customers.id, customers.display_name, customers.email,
              order_tax_identifiers.normalized_value AS tax_id
       FROM customers
       JOIN orders ON orders.customer_id = customers.id
       JOIN order_tax_identifiers ON order_tax_identifiers.order_id = orders.id
       WHERE customers.email IS NOT NULL
       ORDER BY customers.id LIMIT 1`,
        )
      ).rows[0];
      await database
        .getPool()
        .query("UPDATE customers SET review_required = true WHERE id = $1", [customer.id]);
      await database.getPool().query(
        `UPDATE orders
         SET normalized_snapshot_json = jsonb_set(
           normalized_snapshot_json,
           '{customerReviewRequired}',
           'true'::jsonb
         )
         WHERE customer_id = $1`,
        [customer.id],
      );
      await database.getPool().query(
        `UPDATE billing_cases
         SET status = 'NEEDS_REVIEW',
             customer_snapshot_json = jsonb_set(
               customer_snapshot_json,
               '{reviewRequired}',
               'true'::jsonb
             )
         WHERE customer_id = $1`,
        [customer.id],
      );
      const byName = await search.searchGlobal(customer.display_name);
      assert.ok(byName.customers.some((item) => item.id === String(customer.id)));
      assert.ok(
        byName.controls.some(
          (item) => item.href === `/controlli?id=CUSTOMER_IDENTITY%3A${customer.id}`,
        ),
      );
      const byEmail = await search.searchGlobal(customer.email);
      assert.ok(byEmail.customers.some((item) => item.id === String(customer.id)));
      const byTaxId = await search.searchGlobal(customer.tax_id);
      assert.ok(byTaxId.customers.some((item) => item.id === String(customer.id)));

      const caseRow = (
        await database.getPool().query(
          `SELECT billing_cases.id, billing_cases.public_number, billing_cases.customer_id,
              billing_cases.customer_snapshot_json
       FROM billing_cases ORDER BY billing_cases.id LIMIT 1`,
        )
      ).rows[0];
      await database.getPool().query(
        `INSERT INTO documents
        (billing_case_id, kind, status, document_type, series, document_date,
         fiscal_profile_version, currency, total_amount, source_total_amount,
         difference_amount, draft_version, projection_sha256, payment_status,
         payment_method, recipient_snapshot_json, origin)
       SELECT $1, 'INVOICE', 'DRAFT', 'TD01', 'FPR', CURRENT_DATE,
              fiscal_profiles.version, 'EUR', 1000, 1000, 0, 1, repeat('0', 64),
              'PAID', 'MP08', $2, 'HUB'
       FROM fiscal_profiles LIMIT 1`,
        [caseRow.id, caseRow.customer_snapshot_json],
      );
      const invoiceId = (
        await database
          .getPool()
          .query<{ id: string }>(
            "SELECT id FROM documents WHERE billing_case_id = $1 AND kind = 'INVOICE'",
            [caseRow.id],
          )
      ).rows[0]!.id;
      const orderId = (
        await database
          .getPool()
          .query<{ id: string }>(
            "SELECT id FROM orders WHERE billing_case_id = $1 ORDER BY id LIMIT 1",
            [caseRow.id],
          )
      ).rows[0]!.id;
      await database.getPool().query(
        `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
         SELECT documents.id, documents.kind, $2, documents.total_amount
         FROM documents WHERE documents.id = $1`,
        [invoiceId, orderId],
      );
      await database.getPool().query(
        `INSERT INTO document_lines
          (document_id, order_id, line_number, description, quantity, unit_amount,
           total_amount, tax_nature)
         VALUES ($1, $2, 1, 'Ordine sintetico ricerca', 1, 1000, 1000, 'N5')`,
        [invoiceId, orderId],
      );
      const byPreparation = await search.searchGlobal(caseRow.public_number);
      assert.equal(byPreparation.invoices.length, 1);
      assert.deepEqual(byPreparation.documents, byPreparation.invoices);
      assert.equal(byPreparation.invoices[0]!.caseNumber, caseRow.public_number);

      const storage = await database.getPool().query<{ id: string }>(
        `INSERT INTO storage_objects
           (kind, relative_path, sha256, size_bytes, content_type)
         VALUES ('INVOICE_XML', 'global-search.xml', $1, 1, 'application/xml')
         RETURNING id`,
        ["1".repeat(64)],
      );
      await database.getPool().query(
        `UPDATE documents
         SET status = 'APPROVED', fiscal_year = 2026, fiscal_number = 1,
             approved_at = now(), xml_sha256 = $2, immutable_snapshot_json = $3,
             fiscal_profile_snapshot_json = $4, storage_object_id = $5
         WHERE billing_case_id = $1`,
        [caseRow.id, "2".repeat(64), caseRow.customer_snapshot_json, profile, storage.rows[0]!.id],
      );
      const byFiscalNumber = await search.searchGlobal("FPR 0001/26");
      assert.equal(byFiscalNumber.invoices.length, 1);
      assert.equal(byFiscalNumber.invoices[0]!.fiscalLabel, "FPR 0001/26");

      await database
        .getPool()
        .query(
          "INSERT INTO users (username, password_hash, can_approve) VALUES ('Massimo', 'synthetic', true)",
        );
      await database.getPool().query(
        `INSERT INTO aruba_batches
          (id, environment, mode, account_reference, manifest_sha256, document_count,
           status, created_by)
         VALUES ('00000000-0000-4000-8000-000000000071', 'MOCK', 'DOCUMENT_ONLY',
                 'synthetic', repeat('5', 64), 1, 'RECONCILED', 1)`,
      );
      await database.getPool().query(
        `INSERT INTO aruba_submissions
          (batch_id, document_id, attempt_number, environment, mode, manifest_sha256,
           xml_sha256, status)
         VALUES ('00000000-0000-4000-8000-000000000071', $1, 1, 'MOCK',
                 'DOCUMENT_ONLY', repeat('5', 64), repeat('2', 64), 'DELIVERED')`,
        [invoiceId],
      );
      const creditNote = await database.getPool().connect();
      try {
        await creditNote.query("BEGIN");
        const creditDocumentId = (
          await creditNote.query<{ id: string }>(
            `INSERT INTO documents
              (billing_case_id, kind, status, document_type, series, document_date,
               fiscal_profile_version, currency, total_amount, source_total_amount,
               difference_amount, draft_version, projection_sha256, payment_status,
               payment_method, recipient_snapshot_json, origin)
             VALUES ($1, 'CREDIT_NOTE', 'DRAFT', 'TD04', 'NC-RICERCA', CURRENT_DATE,
                     1, 'EUR', 100, 100, 0, 1, repeat('3', 64), 'PAID', 'MP08', $2, 'HUB')
             RETURNING id`,
            [caseRow.id, caseRow.customer_snapshot_json],
          )
        ).rows[0]!.id;
        await creditNote.query(
          `INSERT INTO document_links (document_id, related_document_id, relation_type)
           VALUES ($1, $2, 'CREDIT_NOTE_FOR_INVOICE')`,
          [creditDocumentId, invoiceId],
        );
        await creditNote.query(
          `INSERT INTO refunds
            (provider, external_account_id, external_order_id, external_refund_id,
             order_id, status, amount, completed_at, raw_json, credit_document_id)
           SELECT provider, external_account_id, external_order_id, 'ricerca-rimborso', id,
                  'COMPLETED', 100, now(), '{}', $2
           FROM orders WHERE id = $1`,
          [orderId, creditDocumentId],
        );
        await creditNote.query(
          `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
           VALUES ($1, 'CREDIT_NOTE', $2, 100)`,
          [creditDocumentId, orderId],
        );
        assert.deepEqual(
          (
            await creditNote.query(
              `SELECT documents.total_amount,
                      credit_note_invoice_id(documents.id) AS invoice_id,
                      (SELECT sum(amount) FROM refunds WHERE credit_document_id = documents.id)
                        AS refund_total,
                      credit_note_total_matches(documents.id) AS matches
               FROM documents WHERE documents.id = $1`,
              [creditDocumentId],
            )
          ).rows[0],
          { total_amount: 100, invoice_id: invoiceId, refund_total: "100", matches: true },
        );
        await creditNote.query("COMMIT");
      } finally {
        creditNote.release();
      }
      const byCreditNote = await search.searchGlobal("NC-RICERCA");
      assert.equal(byCreditNote.creditNotes.length, 1);
      assert.match(byCreditNote.creditNotes[0]!.href, /^\/documenti\/\d+\/nota$/);

      const activityCase = (
        await database.getPool().query(
          `UPDATE billing_cases
           SET status = 'NEEDS_REVIEW'
           WHERE id = $1
           RETURNING id, public_number`,
          [caseRow.id],
        )
      ).rows[0];
      await database.getPool().query(
        `UPDATE orders
         SET trigger_status = 'NEEDS_REVIEW',
             normalized_snapshot_json = jsonb_set(
               normalized_snapshot_json,
               '{sourceConflictRequired}',
               'true'::jsonb
             )
         WHERE billing_case_id = $1`,
        [activityCase.id],
      );
      const byActivity = await search.searchGlobal(activityCase.public_number);
      assert.ok(
        byActivity.controls.some((item) => item.detail.includes(activityCase.public_number)),
      );

      await database.getPool().query(
        `INSERT INTO audit_events
          (actor_type, action, event_class, entity_type, entity_id, request_id, reason)
         VALUES ('SYSTEM', 'ORDER_GROUPED', 'OPERATIONAL', 'BILLING_CASE', $1,
                 'ricerca-cronologia-univoca', 'Verifica ricerca globale')`,
        [caseRow.id],
      );
      const byHistory = await search.searchGlobal("ricerca-cronologia-univoca");
      assert.equal(byHistory.history.length, 1);
      assert.equal(byHistory.history[0]!.action, "ORDER_GROUPED");

      await database.getPool().query(
        `INSERT INTO aruba_remote_documents
          (environment, account_reference, remote_id, document_type, fiscal_year, series,
           fiscal_number, document_date, total_amount, remote_status,
           remote_status_observed_at, origin, metadata_digest)
         VALUES ('MOCK', 'synthetic-aruba-account', 'ricerca-remota-univoca', 'TD01',
                 2026, 'RMT', '77', CURRENT_DATE, 1000, 'DELIVERED', now(),
                 'ARUBA_EXTERNAL', repeat('4', 64))`,
      );
      const byRemoteDocument = await search.searchGlobal("ricerca-remota-univoca");
      assert.equal(byRemoteDocument.remoteDocuments.length, 1);
      assert.match(byRemoteDocument.remoteDocuments[0]!.href, /vista=inventario-aruba/);

      await database.getPool().query(
        `INSERT INTO customers
          (kind, match_key, display_name, billing_address_json, source_confidence, review_required)
         SELECT 'PRIVATE_IT', 'ricerca-batch-' || series, 'Batch globale ' || series,
                '{}', 'TAX_ID', false
         FROM generate_series(1, 7) AS series`,
      );
      const bounded = await search.searchGlobal("Batch globale");
      assert.equal(bounded.customers.length, 5);
      assert.equal(bounded.totals.customers, 7);

      assert.deepEqual(await search.searchGlobal("%_"), search.emptyGlobalSearch("%_"));
      assert.deepEqual(await search.searchGlobal("a"), search.emptyGlobalSearch("a"));
    } finally {
      const database = await import("./client.server.ts");
      await database.closePool();
      await clean.drop();
    }
  },
);
