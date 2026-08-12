import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import profileFixture from "../../tests/fixtures/fatturapa/profile.mock.json" with { type: "json" };

import { AppError } from "../errors.ts";
import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

test(
  "TD04 cumulativa: idempotenza, concorrenza, limite e audit atomico",
  { timeout: 30_000 },
  async () => {
    const databaseFixture = await temporaryDatabase("credit_notes");
    const storage = await mkdtemp(path.join(tmpdir(), "hub-fatture-credit-notes-"));
    try {
      await runMigrations({ connectionString: databaseFixture.connectionString });
      process.env.APP_ENV = "test";
      process.env.APP_BASE_URL = "http://localhost:8080";
      process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
      process.env.DATABASE_URL = databaseFixture.connectionString;
      process.env.DOCUMENT_STORAGE_ROOT = storage;
      process.env.SMTP_TRANSPORT = "SYNTHETIC";
      const database = await import("./client.server.ts");
      const refunds = await import("./refunds.server.ts");
      const client = database.getPool();
      const user = await client.query<{ id: string }>(
        "INSERT INTO users (username, password_hash, can_approve) VALUES ('Massimo', 'synthetic', true) RETURNING id",
      );
      await client.query(
        "INSERT INTO fiscal_profiles (version, status, profile_json) VALUES (1, 'MOCK', $1)",
        [profileFixture],
      );
      const recipient = {
        kind: "PRIVATE_IT",
        firstName: "Mario",
        lastName: "Rossi",
        taxIdentifiers: [{ type: "CODICE_FISCALE", value: "RSSMRA80A01H501U" }],
        address: {
          line1: "Via Esempio 1",
          postalCode: "00100",
          city: "Roma",
          province: "RM",
          countryCode: "IT",
        },
      };
      const customer = await client.query<{ id: string }>(
        `INSERT INTO customers
        (kind, match_key, display_name, email, billing_address_json,
         source_confidence, review_required)
       VALUES ('PRIVATE_IT', 'credit-test', 'Mario Rossi', 'cliente@example.invalid', '{}',
         'TAX_ID', false) RETURNING id`,
      );
      const billingCase = await client.query<{ id: string }>(
        `INSERT INTO billing_cases
        (customer_id, local_order_date, currency, status, customer_snapshot_json,
         fiscal_profile_version)
       VALUES ($1, '2026-08-10', 'EUR', 'APPROVED', $2, 1) RETURNING id`,
        [customer.rows[0]!.id, { ...recipient, email: "cliente@example.invalid" }],
      );
      const order = await client.query<{ id: string }>(
        `INSERT INTO orders
        (provider, external_account_id, external_order_id, display_number, created_at_source,
         updated_at_source, local_order_date, currency, gross_amount, payment_status,
         fulfillment_status, trigger_status, customer_id, billing_case_id,
         raw_snapshot_json, normalized_snapshot_json)
       VALUES ('SHOPIFY', 'shop', 'order-credit', '#CREDIT',
         '2026-08-10T09:00:00Z', '2026-08-10T09:00:00Z', '2026-08-10',
         'EUR', 10000, 'PAID', 'FULFILLED', 'INVOICED', $1, $2, '{}', '{}') RETURNING id`,
        [customer.rows[0]!.id, billingCase.rows[0]!.id],
      );
      const stored = await client.query<{ id: string }>(
        `INSERT INTO storage_objects (kind, relative_path, sha256, size_bytes, content_type)
       VALUES ('INVOICE_XML', 'invoices/test.xml', $1, 1, 'application/xml') RETURNING id`,
        ["a".repeat(64)],
      );
      const invoice = await client.query<{ id: string }>(
        `INSERT INTO documents
        (billing_case_id, kind, status, document_type, series, document_date,
         fiscal_profile_version, currency, total_amount, source_total_amount,
         difference_amount, draft_version, projection_sha256, payment_status,
         payment_method, recipient_snapshot_json, customer_email_mode,
         customer_email_choice, customer_email_sender, customer_email_recipient,
         customer_email_subject, customer_email_body)
       VALUES ($1, 'INVOICE', 'DRAFT', 'TD01', 'FPR', '2026-08-10', 1, 'EUR',
         10000, 10000, 0, 1, $2, 'PAID', 'MP08', $3, 'AUTOMATIC', 'SEND',
         'contabilita@example.invalid', 'cliente@example.invalid', 'Il tuo documento fiscale',
         'In allegato trovi la copia leggibile del documento fiscale.') RETURNING id`,
        [billingCase.rows[0]!.id, "b".repeat(64), recipient],
      );
      await client.query(
        `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
       VALUES ($1, 'INVOICE', $2, 10000)`,
        [invoice.rows[0]!.id, order.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO document_lines
          (document_id, order_id, line_number, description, quantity, unit_amount,
           total_amount, tax_nature)
         VALUES ($1, $2, 1, 'Ordine Shopify #CREDIT', 1, 10000, 10000, 'N5')`,
        [invoice.rows[0]!.id, order.rows[0]!.id],
      );
      await client.query(
        `UPDATE documents SET status = 'APPROVED', fiscal_year = 2026, fiscal_number = 1,
         approved_at = now(), xml_sha256 = $2, immutable_snapshot_json = $3,
         fiscal_profile_snapshot_json = $4, storage_object_id = $5 WHERE id = $1`,
        [
          invoice.rows[0]!.id,
          "a".repeat(64),
          { kind: "INVOICE" },
          profileFixture,
          stored.rows[0]!.id,
        ],
      );
      const batchId = randomUUID();
      await client.query(
        `INSERT INTO aruba_batches
        (id, environment, mode, account_reference, manifest_sha256, document_count,
         status, created_by)
       VALUES ($1, 'MOCK', 'ASSISTED', 'synthetic', $2, 1, 'RECONCILED', $3)`,
        [batchId, "c".repeat(64), user.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO aruba_batch_documents
        (batch_id, document_id, position, document_revision, xml_sha256, filename)
       VALUES ($1, $2, 1, 1, $3, 'invoice.xml')`,
        [batchId, invoice.rows[0]!.id, "a".repeat(64)],
      );
      await client.query(
        `INSERT INTO aruba_submissions
        (batch_id, document_id, attempt_number, environment, mode, manifest_sha256,
         xml_sha256, status)
       VALUES ($1, $2, 1, 'MOCK', 'ASSISTED', $3, $4, 'DELIVERED')`,
        [batchId, invoice.rows[0]!.id, "c".repeat(64), "a".repeat(64)],
      );
      const submissionId = (
        await client.query<{ id: string }>("SELECT id FROM aruba_submissions WHERE batch_id = $1", [
          batchId,
        ])
      ).rows[0]!.id;
      const pdf = Buffer.from("%PDF-1.4 synthetic customer copy");
      await writeFile(path.join(storage, "invoice.pdf"), pdf);
      const pdfStorage = await client.query<{ id: string }>(
        `INSERT INTO storage_objects (kind, relative_path, sha256, size_bytes, content_type)
       VALUES ('ARUBA_PDF', 'invoice.pdf', $1, $2, 'application/pdf') RETURNING id`,
        [createHash("sha256").update(pdf).digest("hex"), pdf.byteLength],
      );
      await client.query(
        `INSERT INTO aruba_files (document_id, submission_id, storage_object_id, kind)
       VALUES ($1, $2, $3, 'ARUBA_PDF')`,
        [invoice.rows[0]!.id, submissionId, pdfStorage.rows[0]!.id],
      );

      const insertRefund = async (externalId: string, amount: number) =>
        (
          await client.query<{ id: string }>(
            `INSERT INTO refunds
            (provider, external_account_id, external_order_id, external_refund_id,
             order_id, status, amount, completed_at, raw_json)
           VALUES ('SHOPIFY', 'shop', 'order-credit', $1, $2, 'COMPLETED', $3, now(), '{}')
           RETURNING id`,
            [externalId, order.rows[0]!.id, amount],
          )
        ).rows[0]!.id;

      let firstRefund = await insertRefund("refund-1", 2500);
      await client.query("UPDATE aruba_submissions SET status = 'REJECTED' WHERE batch_id = $1", [
        batchId,
      ]);
      const email = await import("./email.server.ts");
      await assert.rejects(
        email.setCustomerEmailMode("MANUAL", 1, {
          id: Number(user.rows[0]!.id),
          canApprove: false,
          requestId: "email-settings-forbidden",
        }),
        (error) => error instanceof AppError && error.code === "EMAIL_DELIVERY_FORBIDDEN",
      );
      assert.equal(
        await database.withTransaction((transaction) =>
          email.scheduleCustomerEmail(transaction, invoice.rows[0]!.id),
        ),
        null,
      );
      assert.equal(await refunds.processRefund(firstRefund), null);
      assert.equal(
        (await client.query("SELECT count(*) FROM documents WHERE kind = 'CREDIT_NOTE'")).rows[0]
          .count,
        "0",
      );
      await client.query("UPDATE aruba_submissions SET status = 'DELIVERED' WHERE batch_id = $1", [
        batchId,
      ]);
      const schedulerA = await client.connect();
      const schedulerB = await client.connect();
      let deliveryId: string | null;
      try {
        await schedulerA.query("BEGIN");
        await schedulerB.query("BEGIN");
        deliveryId = await email.scheduleCustomerEmail(schedulerA, invoice.rows[0]!.id);
        const competingSchedule = email.scheduleCustomerEmail(schedulerB, invoice.rows[0]!.id);
        await schedulerA.query("COMMIT");
        assert.equal(await competingSchedule, null);
        await schedulerB.query("COMMIT");
      } finally {
        schedulerA.release();
        schedulerB.release();
      }
      assert.ok(deliveryId);
      assert.equal(
        (await client.query("SELECT sender FROM email_deliveries WHERE id = $1", [deliveryId]))
          .rows[0].sender,
        "contabilita@example.invalid",
      );
      const jobs = await import("./connectors.server.ts");
      const firstEmailJob = await jobs.claimJob("email-synthetic");
      assert.equal(firstEmailJob?.type, "send_customer_email");
      await email.sendCustomerEmail(firstEmailJob!);
      assert.equal(await jobs.completeJob(firstEmailJob!), true);
      assert.equal(
        (await client.query("SELECT status FROM email_deliveries WHERE id = $1", [deliveryId]))
          .rows[0].status,
        "SENT",
      );

      const retryId = await email.retryCustomerEmail(invoice.rows[0]!.id, {
        id: Number(user.rows[0]!.id),
        canApprove: true,
        requestId: "manual-email-retry",
      });
      const failedJob = await jobs.claimJob("email-failure");
      await assert.rejects(
        email.sendCustomerEmail(failedJob!, async () => {
          throw Object.assign(new Error("synthetic SMTP detail that must not be persisted"), {
            command: "DATA",
            responseCode: 451,
          });
        }),
        (error) => error instanceof AppError && error.code === "EMAIL_DELIVERY_TEMPORARY",
      );
      assert.equal(await jobs.failJob(failedJob!, "EMAIL_DELIVERY_TEMPORARY"), false);
      await assert.rejects(
        email.retryCustomerEmail(invoice.rows[0]!.id, {
          id: Number(user.rows[0]!.id),
          canApprove: true,
          requestId: "manual-email-while-retry-active",
        }),
        (error) => error instanceof AppError && error.code === "CONFLICT_REVISION",
      );
      await client.query("UPDATE jobs SET run_at = now() WHERE id = $1", [failedJob!.id]);
      const retryJob = await jobs.claimJob("email-retry");
      await email.sendCustomerEmail(retryJob!, async () => "<synthetic-retry@example.invalid>");
      assert.equal(await jobs.completeJob(retryJob!), true);
      const retried = (
        await client.query(
          "SELECT status, attempt_count, last_error_sanitized FROM email_deliveries WHERE id = $1",
          [retryId],
        )
      ).rows[0];
      assert.deepEqual(retried, { status: "SENT", attempt_count: 2, last_error_sanitized: null });

      const permanentId = await email.retryCustomerEmail(invoice.rows[0]!.id, {
        id: Number(user.rows[0]!.id),
        canApprove: true,
        requestId: "manual-email-permanent-failure",
      });
      const permanentJob = await jobs.claimJob("email-permanent-failure");
      await assert.rejects(
        email.sendCustomerEmail(permanentJob!, async () => {
          throw Object.assign(new Error("synthetic permanent SMTP rejection"), {
            command: "DATA",
            responseCode: 550,
          });
        }),
        (error) => error instanceof AppError && error.code === "EMAIL_DELIVERY_FAILED",
      );
      assert.equal(await jobs.failJob(permanentJob!, "EMAIL_DELIVERY_FAILED"), true);
      assert.deepEqual(
        (
          await client.query("SELECT status, last_error_code FROM email_deliveries WHERE id = $1", [
            permanentId,
          ])
        ).rows[0],
        { status: "FAILED", last_error_code: "EMAIL_DELIVERY_FAILED" },
      );

      await assert.rejects(
        email.retryCustomerEmail(invoice.rows[0]!.id, {
          id: Number(user.rows[0]!.id),
          canApprove: false,
          requestId: "manual-email-forbidden",
        }),
        (error) => error instanceof AppError && error.code === "EMAIL_DELIVERY_FORBIDDEN",
      );
      const timeoutId = await email.retryCustomerEmail(invoice.rows[0]!.id, {
        id: Number(user.rows[0]!.id),
        canApprove: true,
        requestId: "manual-email-timeout",
      });
      const timeoutJob = await jobs.claimJob("email-timeout");
      await assert.rejects(
        email.sendCustomerEmail(timeoutJob!, async () => {
          throw new Error("synthetic timeout after possible SMTP acceptance");
        }),
        (error) => error instanceof AppError && error.code === "EMAIL_DELIVERY_UNCERTAIN",
      );
      assert.equal(await jobs.failJob(timeoutJob!, "EMAIL_DELIVERY_UNCERTAIN"), true);
      assert.deepEqual(
        (
          await client.query("SELECT status, last_error_code FROM email_deliveries WHERE id = $1", [
            timeoutId,
          ])
        ).rows[0],
        { status: "FAILED", last_error_code: "EMAIL_DELIVERY_UNCERTAIN" },
      );
      const timeoutRetryId = await email.retryCustomerEmail(
        invoice.rows[0]!.id,
        {
          id: Number(user.rows[0]!.id),
          canApprove: true,
          requestId: "manual-email-timeout-confirmed",
        },
        true,
      );
      const timeoutRetryJob = await jobs.claimJob("email-timeout-confirmed");
      await email.sendCustomerEmail(
        timeoutRetryJob!,
        async () => "<synthetic-timeout-retry@example.invalid>",
      );
      assert.equal(await jobs.completeJob(timeoutRetryJob!), true);
      assert.equal(
        (await client.query("SELECT status FROM email_deliveries WHERE id = $1", [timeoutRetryId]))
          .rows[0].status,
        "SENT",
      );

      const persistenceId = await email.retryCustomerEmail(invoice.rows[0]!.id, {
        id: Number(user.rows[0]!.id),
        canApprove: true,
        requestId: "manual-email-persistence-failure",
      });
      const persistenceJob = await jobs.claimJob("email-persistence-failure");
      await client.query(
        `CREATE FUNCTION block_email_sent_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'CUSTOMER_EMAIL_SENT' THEN RAISE EXCEPTION 'sent audit blocked'; END IF; RETURN NEW; END $$`,
      );
      await client.query(
        "CREATE TRIGGER email_sent_audit_block BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION block_email_sent_audit()",
      );
      await assert.rejects(
        email.sendCustomerEmail(
          persistenceJob!,
          async () => "<synthetic-persisted-before-db-failure@example.invalid>",
        ),
        (error) => error instanceof AppError && error.code === "EMAIL_DELIVERY_UNCERTAIN",
      );
      await client.query("DROP TRIGGER email_sent_audit_block ON audit_events");
      assert.equal(await jobs.failJob(persistenceJob!, "EMAIL_DELIVERY_UNCERTAIN"), true);
      assert.deepEqual(
        (
          await client.query("SELECT status, last_error_code FROM email_deliveries WHERE id = $1", [
            persistenceId,
          ])
        ).rows[0],
        { status: "FAILED", last_error_code: "EMAIL_DELIVERY_UNCERTAIN" },
      );

      const crashId = await email.retryCustomerEmail(
        invoice.rows[0]!.id,
        {
          id: Number(user.rows[0]!.id),
          canApprove: true,
          requestId: "manual-email-crash",
        },
        true,
      );
      const crashedJob = await jobs.claimJob("email-crash");
      await client.query("UPDATE email_deliveries SET send_started_at = now() WHERE id = $1", [
        crashId,
      ]);
      await client.query(
        "UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
        [crashedJob!.id],
      );
      const recoveredJob = await jobs.claimJob("email-recovered");
      assert.equal(recoveredJob?.id, crashedJob?.id);
      await assert.rejects(
        email.sendCustomerEmail(recoveredJob!),
        (error) => error instanceof AppError && error.code === "EMAIL_DELIVERY_UNCERTAIN",
      );
      assert.equal(
        (
          await client.query("SELECT last_error_code FROM email_deliveries WHERE id = $1", [
            crashId,
          ])
        ).rows[0].last_error_code,
        "EMAIL_DELIVERY_UNCERTAIN",
      );
      assert.equal(
        (await client.query("SELECT status FROM documents WHERE id = $1", [invoice.rows[0]!.id]))
          .rows[0].status,
        "APPROVED",
      );
      assert.equal(await jobs.failJob(recoveredJob!, "EMAIL_DELIVERY_UNCERTAIN"), true);
      await assert.rejects(
        email.retryCustomerEmail(invoice.rows[0]!.id, {
          id: Number(user.rows[0]!.id),
          canApprove: true,
          requestId: "manual-email-unverified-crash",
        }),
        (error) => error instanceof AppError && error.code === "EMAIL_DELIVERY_UNCERTAIN",
      );
      assert.ok(
        await email.retryCustomerEmail(
          invoice.rows[0]!.id,
          {
            id: Number(user.rows[0]!.id),
            canApprove: true,
            requestId: "manual-email-verified-crash",
          },
          true,
        ),
      );
      let noteId = await refunds.processRefund(firstRefund);
      assert.ok(noteId);
      assert.equal(await refunds.processRefund(firstRefund), noteId);
      const state = (
        await client.query(
          `SELECT documents.total_amount, documents.status, balances.credited_amount,
                (SELECT count(*) FROM audit_events WHERE action = 'REFUND_CREDIT_NOTE_LINKED') AS audit_count
         FROM documents
         JOIN document_links ON document_links.document_id = documents.id
         JOIN credit_note_balances AS balances
           ON balances.invoice_document_id = document_links.related_document_id
         WHERE documents.id = $1`,
          [noteId],
        )
      ).rows[0];
      assert.deepEqual(state, {
        total_amount: 2500,
        status: "DRAFT",
        credited_amount: 2500,
        audit_count: "1",
      });
      const appliedBeforeIssue = (
        await client.query<{ id: string }>(
          `INSERT INTO refunds
            (provider, external_account_id, external_order_id, external_refund_id,
             order_id, status, amount, raw_json, applied_before_issue)
           VALUES ('SHOPIFY', 'shop', 'order-credit', 'refund-applied-before-issue', $1,
             'COMPLETED', 100, '{}', true)
           RETURNING id`,
          [order.rows[0]!.id],
        )
      ).rows[0]!.id;
      assert.equal(await refunds.processRefund(appliedBeforeIssue), null);
      await assert.rejects(
        client.query("UPDATE refunds SET credit_document_id = $2 WHERE id = $1", [
          appliedBeforeIssue,
          noteId,
        ]),
        /refunds_single_accounting_path_check/,
      );
      await assert.rejects(
        client.query("UPDATE refunds SET amount = 2400 WHERE id = $1", [firstRefund]),
        /Il totale della nota non coincide/,
      );
      assert.equal(
        (await client.query("SELECT amount FROM refunds WHERE id = $1", [firstRefund])).rows[0]
          .amount,
        2500,
      );
      const importedOrder = JSON.parse(
        await readFile("tests/fixtures/orders/normalized.mock.json", "utf8"),
      )[0];
      Object.assign(importedOrder, {
        externalAccountId: "shop",
        externalOrderId: "order-credit",
        displayNumber: "#CREDIT",
        updatedAt: "2026-08-12T09:00:00Z",
        total: "100.00",
        lines: [{ ...importedOrder.lines[0], grossAmount: "100.00" }],
        payments: [{ ...importedOrder.payments[0], amount: "100.00" }],
        refunds: [
          {
            externalRefundId: "refund-1",
            status: "COMPLETED",
            amount: "26.00",
            completedAt: "2026-08-12T08:00:00Z",
            raw: {},
          },
        ],
      });
      const orders = await import("./orders.server.ts");
      await orders.importOrders([importedOrder], {
        id: Number(user.rows[0]!.id),
        requestId: "refresh-linked-credit-note",
      });
      assert.deepEqual(
        (
          await client.query(
            `SELECT documents.total_amount,
                    (SELECT count(*) FROM audit_events
                     WHERE action = 'REFUND_CREDIT_NOTE_UPDATED'
                       AND request_id = 'refresh-linked-credit-note') AS audit_count
             FROM documents WHERE id = $1`,
            [noteId],
          )
        ).rows[0],
        { total_amount: 2600, audit_count: "1" },
      );
      importedOrder.updatedAt = "2026-08-13T09:00:00Z";
      importedOrder.refunds[0].amount = "25.00";
      await orders.importOrders([importedOrder], {
        id: Number(user.rows[0]!.id),
        requestId: "restore-linked-credit-note",
      });
      importedOrder.updatedAt = "2026-08-14T09:00:00Z";
      importedOrder.refunds = [];
      const disappearedNoteId = noteId;
      await orders.importOrders([importedOrder], {
        id: Number(user.rows[0]!.id),
        requestId: "remove-missing-linked-refund",
      });
      assert.deepEqual(
        (
          await client.query(
            `SELECT
               (SELECT count(*) FROM documents WHERE id = $1) AS document_count,
               (SELECT count(*) FROM refunds WHERE external_refund_id = 'refund-1') AS refund_count,
               (SELECT count(*) FROM audit_events
                WHERE action = 'REFUND_CREDIT_NOTE_UPDATED'
                  AND request_id = 'remove-missing-linked-refund') AS audit_count`,
            [disappearedNoteId],
          )
        ).rows[0],
        { document_count: "0", refund_count: "0", audit_count: "1" },
      );
      importedOrder.updatedAt = "2026-08-15T09:00:00Z";
      importedOrder.refunds = [
        {
          externalRefundId: "refund-1",
          status: "COMPLETED",
          amount: "25.00",
          completedAt: "2026-08-12T08:00:00Z",
          raw: {},
        },
      ];
      await orders.importOrders([importedOrder], {
        id: Number(user.rows[0]!.id),
        requestId: "restore-missing-linked-refund",
      });
      firstRefund = (
        await client.query<{ id: string }>(
          "SELECT id FROM refunds WHERE external_refund_id = 'refund-1'",
        )
      ).rows[0]!.id;
      noteId = await refunds.processRefund(firstRefund);
      assert.ok(noteId);
      assert.notEqual(noteId, disappearedNoteId);
      importedOrder.updatedAt = "2026-08-16T09:00:00Z";
      Object.assign(importedOrder.refunds[0], { status: "AMBIGUOUS", amount: null });
      const removedNoteId = noteId;
      await orders.importOrders([importedOrder], {
        id: Number(user.rows[0]!.id),
        requestId: "review-linked-credit-note",
      });
      assert.equal(
        (await client.query("SELECT count(*) FROM documents WHERE id = $1", [removedNoteId]))
          .rows[0].count,
        "0",
      );
      assert.equal(
        (
          await client.query(
            "SELECT credited_amount FROM credit_note_balances WHERE invoice_document_id = $1",
            [invoice.rows[0]!.id],
          )
        ).rows[0].credited_amount,
        0,
      );
      importedOrder.updatedAt = "2026-08-17T09:00:00Z";
      Object.assign(importedOrder.refunds[0], { status: "COMPLETED", amount: "25.00" });
      await orders.importOrders([importedOrder], {
        id: Number(user.rows[0]!.id),
        requestId: "restore-reviewed-credit-note",
      });
      noteId = await refunds.processRefund(firstRefund);
      assert.ok(noteId);
      assert.notEqual(noteId, removedNoteId);
      await client.query("UPDATE documents SET document_date = '2026-08-10' WHERE id = $1", [
        noteId,
      ]);
      await database.withTransaction((transaction) =>
        refunds.refreshCreditNoteDraft(transaction, noteId!),
      );
      let projection = await refunds.getCreditNoteProjection(noteId!);
      assert.match(projection!.xml, /<Data>2026-08-10<\/Data>/);
      assert.ok(projection?.xml.includes("<TipoDocumento>TD04</TipoDocumento>"));
      assert.ok(projection?.xml.includes("<DatiFattureCollegate>"));
      assert.equal(projection?.comparison.recipient[0]?.field, "identity");
      assert.match(projection?.comparison.lines[0]?.source ?? "", /profilo shop/);
      assert.match(projection?.comparison.lines[0]?.source ?? "", /rimborso refund-1/);
      await email.setCustomerEmailMode("MANUAL", projection!.customerEmail.version, {
        id: Number(user.rows[0]!.id),
        canApprove: true,
        requestId: "email-settings-stale-approval",
      });
      await assert.rejects(
        refunds.approveCreditNote(
          noteId!,
          {
            draftVersion: projection!.draftVersion,
            projectionSha256: projection!.projectionSha256,
            confirmApproval: true,
            arubaMode: projection!.arubaMode,
            emailChoice: "SKIP",
            emailModeVersion: projection!.customerEmail.version,
          },
          {
            id: Number(user.rows[0]!.id),
            canApprove: true,
            requestId: "approve-credit-note-stale-email-mode",
          },
        ),
        (error) => error instanceof AppError && error.code === "CONFLICT_REVISION",
      );
      projection = await refunds.getCreditNoteProjection(noteId!);
      const approved = await refunds.approveCreditNote(
        noteId!,
        {
          draftVersion: projection!.draftVersion,
          projectionSha256: projection!.projectionSha256,
          confirmApproval: true,
          arubaMode: projection!.arubaMode,
          emailChoice: "SKIP",
          emailModeVersion: projection!.customerEmail.version,
        },
        {
          id: Number(user.rows[0]!.id),
          canApprove: true,
          requestId: "approve-credit-note",
        },
      );
      assert.ok(approved.batchId);
      assert.deepEqual(
        (
          await client.query(
            `SELECT documents.status, documents.document_type, batches.mode,
                  submissions.status AS submission_status
           FROM documents
           JOIN aruba_batch_documents AS batch_documents
             ON batch_documents.document_id = documents.id
           JOIN aruba_batches AS batches ON batches.id = batch_documents.batch_id
           JOIN aruba_submissions AS submissions
             ON submissions.batch_id = batches.id AND submissions.document_id = documents.id
           WHERE documents.id = $1`,
            [noteId],
          )
        ).rows[0],
        {
          status: "APPROVED",
          document_type: "TD04",
          mode: "ASSISTED",
          submission_status: "PENDING",
        },
      );
      importedOrder.updatedAt = "2026-08-18T09:00:00Z";
      importedOrder.refunds = [];
      await orders.importOrders([importedOrder], {
        id: Number(user.rows[0]!.id),
        requestId: "preserve-approved-linked-refund",
      });
      assert.equal(
        (
          await client.query(
            "SELECT credit_document_id FROM refunds WHERE external_refund_id = 'refund-1'",
          )
        ).rows[0].credit_document_id,
        noteId,
      );

      const concurrentA = await insertRefund("refund-2", 6000);
      const concurrentB = await insertRefund("refund-3", 6000);
      const outcomes = await Promise.allSettled([
        refunds.processRefund(concurrentA),
        refunds.processRefund(concurrentB),
      ]);
      assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
      assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
      const nextNoteId = outcomes.find((outcome) => outcome.status === "fulfilled")!.value;
      assert.notEqual(nextNoteId, noteId);
      assert.equal(
        (await client.query("SELECT status FROM documents WHERE id = $1", [nextNoteId])).rows[0]
          .status,
        "DRAFT",
      );
      assert.equal(
        (
          await client.query(
            "SELECT credited_amount FROM credit_note_balances WHERE invoice_document_id = $1",
            [invoice.rows[0]!.id],
          )
        ).rows[0].credited_amount,
        8500,
      );

      const excessive = await insertRefund("refund-4", 2000);
      await assert.rejects(
        refunds.processRefund(excessive),
        (error) => error instanceof AppError && error.code === "CREDIT_NOTE_LIMIT_EXCEEDED",
      );
      assert.equal(
        (await client.query("SELECT credit_document_id FROM refunds WHERE id = $1", [excessive]))
          .rows[0].credit_document_id,
        null,
      );

      const netCase = await client.query<{ id: string }>(
        `INSERT INTO billing_cases
          (customer_id, local_order_date, currency, status, customer_snapshot_json,
           fiscal_profile_version)
         VALUES ($1, '2026-08-19', 'EUR', 'APPROVED', $2, 1) RETURNING id`,
        [customer.rows[0]!.id, { ...recipient, email: "cliente@example.invalid" }],
      );
      const netOrder = await client.query<{ id: string }>(
        `INSERT INTO orders
          (provider, external_account_id, external_order_id, display_number, created_at_source,
           updated_at_source, local_order_date, currency, gross_amount,
           shopify_payments_fee_amount, deducted_shopify_payments_fee_amount,
           payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
           raw_snapshot_json, normalized_snapshot_json)
         VALUES ('SHOPIFY', 'shop', 'order-credit-net', '#CREDIT-NET',
           '2026-08-19T09:00:00Z', '2026-08-19T09:00:00Z', '2026-08-19',
           'EUR', 12200, 257, 257, 'PAID', 'FULFILLED', 'INVOICED', $1, $2, '{}', '{}')
         RETURNING id`,
        [customer.rows[0]!.id, netCase.rows[0]!.id],
      );
      const netInvoice = await client.query<{ id: string }>(
        `INSERT INTO documents
          (billing_case_id, kind, status, document_type, series, document_date,
           fiscal_profile_version, currency, total_amount, source_total_amount,
           difference_amount, draft_version, projection_sha256, payment_status,
           payment_method, recipient_snapshot_json)
         VALUES ($1, 'INVOICE', 'DRAFT', 'TD01', 'FPR', '2026-08-19', 1, 'EUR',
           11943, 11943, 0, 1, $2, 'PAID', 'MP08', $3) RETURNING id`,
        [netCase.rows[0]!.id, "d".repeat(64), recipient],
      );
      await client.query(
        `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
         VALUES ($1, 'INVOICE', $2, 11943)`,
        [netInvoice.rows[0]!.id, netOrder.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO document_lines
          (document_id, order_id, line_number, description, quantity, unit_amount,
           total_amount, tax_nature)
         VALUES ($1, $2, 1, 'Ordine Shopify #CREDIT-NET', 1, 11943, 11943, 'N5')`,
        [netInvoice.rows[0]!.id, netOrder.rows[0]!.id],
      );
      await client.query(
        `UPDATE documents
         SET status = 'APPROVED', origin = 'ARUBA_HISTORY', fiscal_year = 2026,
             fiscal_number = 9001, approved_at = now(), xml_sha256 = $2,
             immutable_snapshot_json = $3, fiscal_profile_snapshot_json = $4,
             storage_object_id = $5
         WHERE id = $1`,
        [
          netInvoice.rows[0]!.id,
          "e".repeat(64),
          { kind: "INVOICE" },
          profileFixture,
          stored.rows[0]!.id,
        ],
      );
      const grossRefund = (
        await client.query<{ id: string }>(
          `INSERT INTO refunds
            (provider, external_account_id, external_order_id, external_refund_id,
             order_id, status, amount, completed_at, raw_json)
           VALUES ('SHOPIFY', 'shop', 'order-credit-net', 'refund-credit-net', $1,
             'COMPLETED', 12200, now(), '{}') RETURNING id`,
          [netOrder.rows[0]!.id],
        )
      ).rows[0]!.id;
      const netCreditId = await refunds.processRefund(grossRefund);
      assert.ok(netCreditId);
      assert.deepEqual(
        (
          await client.query(
            `SELECT refunds.amount AS provider_amount, documents.total_amount,
                    document_orders.amount AS attributed_amount,
                    balances.credited_amount
             FROM refunds
             JOIN documents ON documents.id = refunds.credit_document_id
             JOIN document_orders ON document_orders.document_id = documents.id
               AND document_orders.order_id = refunds.order_id
             JOIN credit_note_balances AS balances
               ON balances.invoice_document_id = $2
             WHERE refunds.id = $1`,
            [grossRefund, netInvoice.rows[0]!.id],
          )
        ).rows[0],
        {
          provider_amount: 12_200,
          total_amount: 11_943,
          attributed_amount: 11_943,
          credited_amount: 11_943,
        },
      );

      const overrideCase = await client.query<{ id: string }>(
        `INSERT INTO billing_cases
          (customer_id, local_order_date, currency, status, customer_snapshot_json,
           fiscal_profile_version)
         VALUES ($1, '2026-08-20', 'EUR', 'APPROVED', $2, 1) RETURNING id`,
        [customer.rows[0]!.id, { ...recipient, email: "cliente@example.invalid" }],
      );
      const overrideOrders: string[] = [];
      for (const suffix of ["UP", "DOWN"]) {
        const result = await client.query<{ id: string }>(
          `INSERT INTO orders
            (provider, external_account_id, external_order_id, display_number,
             created_at_source, updated_at_source, local_order_date, currency, gross_amount,
             shopify_payments_fee_amount, deducted_shopify_payments_fee_amount,
             payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
             raw_snapshot_json, normalized_snapshot_json)
           VALUES ('SHOPIFY', 'shop', $1, $2, '2026-08-20T09:00:00Z',
             '2026-08-20T09:00:00Z', '2026-08-20', 'EUR', 10000, 500, 500,
             'PAID', 'FULFILLED', 'INVOICED', $3, $4, '{}', '{}') RETURNING id`,
          [
            `order-credit-override-${suffix.toLowerCase()}`,
            `#CREDIT-${suffix}`,
            customer.rows[0]!.id,
            overrideCase.rows[0]!.id,
          ],
        );
        overrideOrders.push(result.rows[0]!.id);
      }
      const overrideInvoice = await client.query<{ id: string }>(
        `INSERT INTO documents
          (billing_case_id, kind, status, document_type, series, document_date,
           fiscal_profile_version, currency, total_amount, source_total_amount,
           difference_amount, draft_version, projection_sha256, payment_status,
           payment_method, recipient_snapshot_json)
         VALUES ($1, 'INVOICE', 'DRAFT', 'TD01', 'FPR', '2026-08-20', 1, 'EUR',
           19000, 19000, 0, 1, $2, 'PAID', 'MP08', $3) RETURNING id`,
        [overrideCase.rows[0]!.id, "f".repeat(64), recipient],
      );
      for (const orderId of overrideOrders) {
        await client.query(
          `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
           VALUES ($1, 'INVOICE', $2, 9500)`,
          [overrideInvoice.rows[0]!.id, orderId],
        );
      }
      await client.query(
        `INSERT INTO document_lines
          (document_id, order_id, line_number, description, quantity, unit_amount,
           total_amount, tax_nature)
         VALUES
           ($1, $2, 1, 'Ordine Shopify #CREDIT-UP', 1, 10000, 10000, 'N5'),
           ($1, $3, 2, 'Ordine Shopify #CREDIT-DOWN', 1, 9000, 9000, 'N5')`,
        [overrideInvoice.rows[0]!.id, overrideOrders[0], overrideOrders[1]],
      );
      await client.query(
        `UPDATE documents
         SET status = 'APPROVED', fiscal_year = 2026,
             fiscal_number = 9002, approved_at = now(), xml_sha256 = $2,
             immutable_snapshot_json = $3, fiscal_profile_snapshot_json = $4,
             storage_object_id = $5
         WHERE id = $1`,
        [
          overrideInvoice.rows[0]!.id,
          "1".repeat(64),
          { kind: "INVOICE" },
          profileFixture,
          stored.rows[0]!.id,
        ],
      );
      const overrideBatchId = randomUUID();
      await client.query(
        `INSERT INTO aruba_batches
          (id, environment, mode, account_reference, manifest_sha256, document_count,
           status, created_by)
         VALUES ($1, 'MOCK', 'ASSISTED', 'synthetic', $2, 1, 'RECONCILED', $3)`,
        [overrideBatchId, "2".repeat(64), user.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO aruba_batch_documents
          (batch_id, document_id, position, document_revision, xml_sha256, filename)
         VALUES ($1, $2, 1, 1, $3, 'override-invoice.xml')`,
        [overrideBatchId, overrideInvoice.rows[0]!.id, "1".repeat(64)],
      );
      await client.query(
        `INSERT INTO aruba_submissions
          (batch_id, document_id, attempt_number, environment, mode, manifest_sha256,
           xml_sha256, status)
         VALUES ($1, $2, 1, 'MOCK', 'ASSISTED', $3, $4, 'DELIVERED')`,
        [overrideBatchId, overrideInvoice.rows[0]!.id, "2".repeat(64), "1".repeat(64)],
      );
      const overrideRefunds: string[] = [];
      for (const [index, amount] of [10000, 9500].entries()) {
        const result = await client.query<{ id: string }>(
          `INSERT INTO refunds
            (provider, external_account_id, external_order_id, external_refund_id,
             order_id, status, amount, completed_at, raw_json)
           VALUES ('SHOPIFY', 'shop', $1, $2, $3, 'COMPLETED', $4, now(), '{}')
           RETURNING id`,
          [
            `order-credit-override-${index === 0 ? "up" : "down"}`,
            `refund-credit-override-${index}`,
            overrideOrders[index],
            amount,
          ],
        );
        overrideRefunds.push(result.rows[0]!.id);
      }
      const overrideCreditId = await refunds.processRefund(overrideRefunds[0]!);
      assert.ok(overrideCreditId);
      assert.equal(await refunds.processRefund(overrideRefunds[1]!), overrideCreditId);
      assert.deepEqual(
        (
          await client.query(
            `SELECT refunds.amount AS provider_amount,
                    document_orders.amount AS attributed_amount
             FROM refunds
             JOIN document_orders
               ON document_orders.document_id = refunds.credit_document_id
              AND document_orders.order_id = refunds.order_id
             WHERE refunds.id = ANY($1::bigint[])
             ORDER BY refunds.external_order_id DESC`,
            [overrideRefunds],
          )
        ).rows,
        [
          { provider_amount: 10000, attributed_amount: 10000 },
          { provider_amount: 9500, attributed_amount: 9000 },
        ],
      );
      assert.equal(
        (await client.query("SELECT total_amount FROM documents WHERE id = $1", [overrideCreditId]))
          .rows[0].total_amount,
        19000,
      );

      const ambiguous = (
        await client.query<{ id: string }>(
          `INSERT INTO refunds
            (provider, external_account_id, external_order_id, external_refund_id,
             order_id, status, amount, raw_json)
           VALUES ('EBAY', 'ebay-shop', 'ebay-order', 'refund-ambiguous', $1,
             'AMBIGUOUS', NULL, '{}') RETURNING id`,
          [order.rows[0]!.id],
        )
      ).rows[0]!.id;
      assert.equal(await refunds.processRefund(ambiguous), null);
      const pendingWithoutAmount = (
        await client.query<{ id: string }>(
          `INSERT INTO refunds
            (provider, external_account_id, external_order_id, external_refund_id,
             order_id, status, amount, raw_json)
           VALUES ('SHOPIFY', 'shop', 'order-credit', 'refund-pending-no-amount', $1,
             'PENDING', NULL, '{}') RETURNING id`,
          [order.rows[0]!.id],
        )
      ).rows[0]!.id;
      const unresolvedRefundJob = await client.query<{ id: string }>(
        `INSERT INTO jobs (type, payload_json, status, attempts, max_attempts, last_error_code)
         VALUES ('process_refund', jsonb_build_object('refundId', $1::text), 'FAILED', 5, 5,
           'CREDIT_NOTE_LIMIT_EXCEEDED') RETURNING id`,
        [excessive],
      );
      const resolvedJob = await client.query<{ id: string }>(
        `INSERT INTO jobs (type, payload_json, status, attempts, max_attempts, last_error_code)
         VALUES ('process_refund', jsonb_build_object('refundId', $1::text), 'FAILED', 5, 5,
           'CREDIT_NOTE_LIMIT_EXCEEDED') RETURNING id`,
        [firstRefund],
      );
      const orderQueries = await import("./order-queries.server.ts");
      const activities = await orderQueries.listOpenActivities();
      assert.ok(
        activities.rows.some((activity) => activity.kind === "REFUND" && activity.id === ambiguous),
      );
      assert.ok(
        activities.rows.some(
          (activity) =>
            activity.kind === "REFUND_JOB" && activity.id === unresolvedRefundJob.rows[0]!.id,
        ),
      );
      assert.ok(
        !activities.rows.some(
          (activity) => activity.kind === "REFUND" && activity.id === pendingWithoutAmount,
        ),
      );
      assert.ok(
        !activities.rows.some(
          (activity) => activity.kind === "REFUND_JOB" && activity.id === resolvedJob.rows[0]!.id,
        ),
      );
      const creditNoteActivities = await orderQueries.listOpenActivities(undefined, "CREDIT_NOTE");
      assert.ok(creditNoteActivities.rows.length > 0);
      assert.ok(creditNoteActivities.rows.every((activity) => activity.kind === "CREDIT_NOTE"));
      assert.equal(
        creditNoteActivities.total,
        Number((await orderQueries.dashboardSummary()).credit_notes_to_approve),
      );
      const orderDetail = await orderQueries.getOrder(order.rows[0]!.id);
      assert.ok(orderDetail?.refunds.some((refund) => refund.id === ambiguous));

      const atomic = await insertRefund("refund-atomic", 1000);
      await client.query(
        `CREATE FUNCTION block_credit_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'REFUND_CREDIT_NOTE_LINKED' THEN RAISE EXCEPTION 'audit blocked'; END IF; RETURN NEW; END $$`,
      );
      await client.query(
        "CREATE TRIGGER audit_block BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION block_credit_audit()",
      );
      await assert.rejects(refunds.processRefund(atomic), /audit blocked|supera/);
      assert.equal(
        (await client.query("SELECT credit_document_id FROM refunds WHERE id = $1", [atomic]))
          .rows[0].credit_document_id,
        null,
      );
    } finally {
      await (await import("./client.server.ts")).closePool();
      await rm(storage, { recursive: true, force: true });
      await databaseFixture.drop();
    }
  },
);
