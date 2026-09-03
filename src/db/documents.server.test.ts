import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import profileFixture from "../../tests/fixtures/fatturapa/profile.mock.json" with { type: "json" };

import { AppError } from "../errors.ts";
import { fiscalProfileSchema } from "../documents.ts";
import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

test(
  "approvazione, numerazione concorrente, stale e storage sono fail-closed",
  { timeout: 60_000 },
  async () => {
    const databaseFixture = await temporaryDatabase("documents");
    const storage = await mkdtemp(path.join(tmpdir(), "hub-fatture-documents-"));
    try {
      await runMigrations({ connectionString: databaseFixture.connectionString });
      process.env.APP_ENV = "test";
      process.env.APP_BASE_URL = "http://localhost:8080";
      process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
      process.env.DATABASE_URL = databaseFixture.connectionString;
      process.env.DOCUMENT_STORAGE_ROOT = storage;
      process.env.SMTP_FROM = "approvazioni@example.invalid";
      const documents = {
        ...(await import("./documents.server.ts")),
        ...(await import("./document-mass-approval.server.ts")),
      };
      const documentStorage = await import("./document-storage.server.ts");
      const aruba = await import("./aruba.server.ts");
      const arubaOutbound = await import("./aruba-api-outbound.server.ts");
      const jobs = await import("./connector-jobs.server.ts");
      const orders = {
        ...(await import("./billing-cases.server.ts")),
        ...(await import("./order-commands.server.ts")),
        ...(await import("./order-import.server.ts")),
        ...(await import("./order-queries.server.ts")),
      };
      const database = await import("./client.server.ts");
      await database
        .getPool()
        .query(
          "INSERT INTO users (username, password_hash, can_approve) VALUES ('Massimo', 'synthetic', true)",
        );
      await database.getPool().query(
        `INSERT INTO aruba_sync_runs
          (id, environment, api_environment, account_reference, kind, authority_mode, status,
           window_start, window_end, checkpoint_start, checkpoint_end, lease_expires_at,
           completed_at, full_scan_completed_at)
         VALUES ('00000000-0000-4000-8000-000000000301', 'MOCK', 'DEMO',
           'synthetic-aruba-account', 'FULL', 'CANONICAL', 'COMPLETED', now() - interval '2 days',
           now(), now() - interval '2 days', now(), now(), now(), now())`,
      );
      const fixture = JSON.parse(
        await readFile("tests/fixtures/orders/normalized.mock.json", "utf8"),
      );
      const syntheticFiscalProfile = fiscalProfileSchema.parse(profileFixture);
      const first = structuredClone(fixture[0]);
      const second = structuredClone(fixture[0]);
      const third = structuredClone(fixture[0]);
      const fourth = structuredClone(fixture[0]);
      const fifth = structuredClone(fixture[0]);
      second.externalOrderId = "shop-order-documents-second";
      second.displayNumber = "#DOC-2";
      second.createdAt = "2026-08-11T08:00:00Z";
      second.updatedAt = "2026-08-11T09:00:00Z";
      third.externalOrderId = "shop-order-documents-third";
      third.displayNumber = "#DOC-3";
      third.createdAt = "2026-08-12T08:00:00Z";
      third.updatedAt = "2026-08-12T09:00:00Z";
      fourth.externalOrderId = "shop-order-documents-fourth";
      fourth.displayNumber = "#DOC-4";
      fourth.updatedAt = "2026-08-10T10:00:00Z";
      fifth.externalOrderId = "shop-order-documents-fifth";
      fifth.displayNumber = "#DOC-5";
      fifth.updatedAt = "2026-08-10T11:00:00Z";
      await orders.importOrders([first, second, third, fourth], {
        id: 1,
        requestId: "documents-import",
      });
      const profileActivation = await documents.activateFiscalProfile(
        syntheticFiscalProfile,
        "a".repeat(64),
        0,
        {
          id: 1,
          canApprove: true,
          requestId: "documents-profile",
        },
      );
      assert.deepEqual(
        { version: profileActivation.version, created: profileActivation.created },
        { version: 1, created: true },
      );
      const repeatedProfileActivation = await documents.activateFiscalProfile(
        {
          ...syntheticFiscalProfile,
          numbering: {
            ...syntheticFiscalProfile.numbering,
            approvedAt: "2026-08-12T10:00:00.000Z",
          },
        },
        "a".repeat(64),
        0,
        { id: 1, canApprove: true, requestId: "documents-profile-retry" },
      );
      assert.deepEqual(
        { version: repeatedProfileActivation.version, created: repeatedProfileActivation.created },
        { version: 1, created: false },
      );
      assert.equal(
        Number(
          (
            await database
              .getPool()
              .query<{ count: string }>(
                "SELECT count(*) AS count FROM audit_events WHERE action = 'FISCAL_PROFILE_ACTIVATED'",
              )
          ).rows[0]!.count,
        ),
        1,
      );
      await assert.rejects(
        documents.activateFiscalProfile(
          { ...syntheticFiscalProfile, legalReference: "Regime del margine Art. 36 41/95" },
          "b".repeat(64),
          0,
          { id: 1, canApprove: true, requestId: "documents-profile-conflict" },
        ),
        (error) => error instanceof AppError && error.code === "CONFLICT_REVISION",
      );
      const importedXml = await readFile(
        "tests/fixtures/fatturapa/accepted-invoice.anonymized.xml",
        "utf8",
      );
      const importedPath = "invoices/history/concurrent-import.xml";
      const firstClient = await database.getPool().connect();
      const secondClient = await database.getPool().connect();
      await firstClient.query("BEGIN");
      await secondClient.query("BEGIN");
      const firstArchive = await documentStorage.archiveImportedInvoiceXml(
        firstClient,
        importedPath,
        importedXml,
      );
      let secondArchiveFinished = false;
      const secondArchivePending = documentStorage
        .archiveImportedInvoiceXml(secondClient, importedPath, importedXml)
        .then((archive) => {
          secondArchiveFinished = true;
          return archive;
        });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(secondArchiveFinished, false);
      await firstArchive.cleanupIfUnreferenced();
      await firstClient.query("COMMIT");
      firstClient.release();
      const secondArchive = await secondArchivePending;
      await secondClient.query(
        `INSERT INTO storage_objects
          (kind, relative_path, sha256, size_bytes, content_type)
         VALUES ('INVOICE_XML', $1, $2, $3, 'application/xml')`,
        [importedPath, secondArchive.sha256, secondArchive.sizeBytes],
      );
      await secondClient.query("COMMIT");
      secondClient.release();
      assert.equal(await readFile(path.join(storage, importedPath), "utf8"), importedXml);
      await assert.rejects(
        documents.activateFiscalProfile(
          {
            ...syntheticFiscalProfile,
            numbering: {
              ...syntheticFiscalProfile.numbering,
              lastObservedYear: syntheticFiscalProfile.numbering.lastObservedYear - 1,
              lastObservedNumber: syntheticFiscalProfile.numbering.lastObservedNumber + 100,
            },
          },
          "b".repeat(64),
          1,
          { id: 1, canApprove: true, requestId: "documents-profile-stale" },
        ),
        (error) => error instanceof AppError && error.code === "DOCUMENT_INVALID",
      );
      const cases = (
        await database
          .getPool()
          .query<{ id: string; status: string }>("SELECT id, status FROM billing_cases ORDER BY id")
      ).rows;
      assert.equal(cases.length, 3);
      assert.ok(cases.every((billingCase) => billingCase.status === "READY"));
      const transferOrders = await database
        .getPool()
        .query<{ id: string; gross_amount: number }>(
          "SELECT id::text, gross_amount FROM orders WHERE billing_case_id = $1 ORDER BY id",
          [cases[0]!.id],
        );
      await database
        .getPool()
        .query("DELETE FROM payments WHERE order_id = ANY($1::bigint[])", [
          transferOrders.rows.map(({ id }) => id),
        ]);
      for (const order of transferOrders.rows) {
        await database.getPool().query(
          `INSERT INTO payments
             (order_id, external_payment_id, method, status, amount, paid_at, raw_json)
           VALUES
             ($1, $2, 'Bonifico Bancario', 'PENDING', $4, now() - interval '1 hour', '{}'),
             ($1, $3, 'manual', 'PAID', $4, now(), '{}')`,
          [
            order.id,
            `bank-transfer-${order.id}`,
            `manual-confirmation-${order.id}`,
            order.gross_amount,
          ],
        );
      }
      const bankTransferProjection = await documents.getInvoiceProjection(cases[0]!.id);
      assert.ok(
        bankTransferProjection &&
          !bankTransferProjection.profileMissing &&
          "lines" in bankTransferProjection,
      );
      assert.equal(bankTransferProjection.paymentMethod, "MP05");
      assert.match(bankTransferProjection.comparison.payment[0]!.projected, /TP02 · MP05/);
      await database
        .getPool()
        .query("DELETE FROM payments WHERE order_id = ANY($1::bigint[])", [
          transferOrders.rows.map(({ id }) => id),
        ]);
      for (const order of transferOrders.rows) {
        await database.getPool().query(
          `INSERT INTO payments
             (order_id, external_payment_id, method, status, amount, paid_at, raw_json)
           VALUES ($1, $2, 'Carta di pagamento', 'PAID', $3, now(), '{}')`,
          [order.id, `card-${order.id}`, order.gross_amount],
        );
      }
      const unsavedCandidates = await documents.listMassApprovalCandidates();
      assert.deepEqual(
        unsavedCandidates.map(({ billing_case_id, draft_version }) => ({
          billing_case_id,
          draft_version,
        })),
        cases.map(({ id }) => ({ billing_case_id: id, draft_version: 0 })),
      );
      assert.equal(
        (await database.getPool().query("SELECT count(*) FROM documents")).rows[0].count,
        "0",
      );
      assert.equal((await orders.dashboardSummary()).ready_cases, "3");
      const save = async (caseId: string) => {
        const projection = await documents.getInvoiceProjection(caseId);
        assert.ok(projection && !projection.profileMissing && "lines" in projection);
        assert.equal(projection.comparison.recipient[0]!.source, "Mario Rossi");
        assert.match(projection.comparison.lines[0]!.projected, /N5/);
        assert.match(projection.comparison.payment[0]!.projected, /TP02 · MP08/);
        await documents.saveInvoiceDraft(
          caseId,
          {
            caseRevision: projection.caseRevision,
            draftVersion: projection.draftVersion,
            differenceReason: "",
            paymentStatus: projection.paymentStatus,
            paymentMethod: projection.paymentMethod,
            causale: "",
            notes: "",
            lines: projection.lines,
          },
          { id: 1, canApprove: true, requestId: `save-${caseId}` },
        );
        const saved = await documents.getInvoiceProjection(caseId);
        assert.ok(saved && !saved.profileMissing && "lines" in saved);
        assert.equal(
          saved.documentDate,
          new Intl.DateTimeFormat("en-CA", {
            timeZone: "Europe/Rome",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date()),
        );
        return saved;
      };
      let [firstProjection, secondProjection, thirdProjection] = await Promise.all(
        cases.map((billingCase) => save(billingCase.id)),
      );
      assert.equal(secondProjection.lines.length, 1);
      assert.equal(secondProjection.lines[0]!.unitAmount % 2, 0);
      await documents.saveInvoiceDraft(
        cases[1]!.id,
        {
          caseRevision: secondProjection.caseRevision,
          draftVersion: secondProjection.draftVersion,
          differenceReason: "",
          paymentStatus: secondProjection.paymentStatus,
          paymentMethod: secondProjection.paymentMethod,
          causale: "",
          notes: "",
          lines: [
            {
              ...secondProjection.lines[0]!,
              quantity: 2,
              unitAmount: secondProjection.lines[0]!.unitAmount / 2,
            },
          ],
        },
        { id: 1, canApprove: true, requestId: "documents-split-line-before-refund" },
      );
      const splitLineProjection = await documents.getInvoiceProjection(cases[1]!.id);
      assert.ok(
        splitLineProjection &&
          !splitLineProjection.profileMissing &&
          "lines" in splitLineProjection,
      );
      secondProjection = splitLineProjection;
      second.updatedAt = "2026-08-11T10:00:00Z";
      second.refunds = [
        {
          externalRefundId: "shop-refund-before-issue",
          status: "COMPLETED",
          amount: "25.00",
          completedAt: "2026-08-11T09:30:00Z",
          raw: {},
        },
      ];
      await orders.importOrders([second], {
        id: 1,
        requestId: "documents-partial-refund-before-issue",
      });
      const partialRefundProjection = await documents.getInvoiceProjection(cases[1]!.id);
      assert.ok(
        partialRefundProjection &&
          !partialRefundProjection.profileMissing &&
          "lines" in partialRefundProjection,
      );
      assert.equal(partialRefundProjection.total, 9700);
      assert.equal(partialRefundProjection.sourceTotal, 9700);
      assert.equal(partialRefundProjection.requiresResave, false);
      assert.deepEqual(
        partialRefundProjection.lines.map(({ quantity, unitAmount }) => ({ quantity, unitAmount })),
        [{ quantity: 1, unitAmount: 9700 }],
      );
      assert.deepEqual(
        (
          await database.getPool().query(
            `SELECT applied_before_issue,
                    (SELECT count(*)::int FROM jobs
                     WHERE type = 'process_refund'
                       AND payload_json ->> 'refundId' = refunds.id::text) AS jobs
             FROM refunds WHERE external_refund_id = 'shop-refund-before-issue'`,
          )
        ).rows[0],
        { applied_before_issue: true, jobs: 0 },
      );
      await orders.importOrders([second], {
        id: 1,
        requestId: "documents-partial-refund-idempotent",
      });
      const repeatedPartialRefund = await documents.getInvoiceProjection(cases[1]!.id);
      assert.ok(
        repeatedPartialRefund &&
          !repeatedPartialRefund.profileMissing &&
          "lines" in repeatedPartialRefund,
      );
      assert.equal(repeatedPartialRefund.draftVersion, partialRefundProjection.draftVersion);
      assert.equal(
        (
          await database
            .getPool()
            .query("SELECT count(*) FROM audit_events WHERE action = 'REFUND_APPLIED_BEFORE_ISSUE'")
        ).rows[0].count,
        "1",
      );
      second.updatedAt = "2026-08-11T11:00:00Z";
      second.refunds = [
        {
          externalRefundId: "shop-refund-before-issue",
          status: "PENDING",
          amount: null,
          completedAt: null,
          raw: {},
        },
      ];
      await orders.importOrders([second], {
        id: 1,
        requestId: "documents-partial-refund-reversed",
      });
      const restoredRefundProjection = await documents.getInvoiceProjection(cases[1]!.id);
      assert.ok(
        restoredRefundProjection &&
          !restoredRefundProjection.profileMissing &&
          "lines" in restoredRefundProjection,
      );
      assert.equal(restoredRefundProjection.total, 12_200);
      assert.equal(restoredRefundProjection.sourceTotal, 12_200);
      assert.equal(restoredRefundProjection.requiresResave, false);
      assert.deepEqual(
        restoredRefundProjection.lines.map(({ quantity, unitAmount }) => ({
          quantity,
          unitAmount,
        })),
        [{ quantity: 1, unitAmount: 12_200 }],
      );
      assert.deepEqual(
        (
          await database.getPool().query(
            `SELECT orders.trigger_status, billing_cases.status AS case_status,
                    refunds.applied_before_issue
             FROM orders
             JOIN billing_cases ON billing_cases.id = orders.billing_case_id
             JOIN refunds ON refunds.order_id = orders.id
             WHERE refunds.external_refund_id = 'shop-refund-before-issue'`,
          )
        ).rows[0],
        { trigger_status: "GROUPED", case_status: "READY", applied_before_issue: false },
      );
      assert.equal(
        (
          await database
            .getPool()
            .query(
              "SELECT count(*) FROM audit_events WHERE action = 'REFUND_REVERSED_BEFORE_ISSUE'",
            )
        ).rows[0].count,
        "1",
      );
      second.updatedAt = "2026-08-11T12:00:00Z";
      second.refunds = [
        {
          externalRefundId: "shop-refund-before-issue",
          status: "COMPLETED",
          amount: "25.00",
          completedAt: "2026-08-11T09:30:00Z",
          raw: {},
        },
      ];
      await orders.importOrders([second], {
        id: 1,
        requestId: "documents-partial-refund-reapplied",
      });
      const reappliedRefundProjection = await documents.getInvoiceProjection(cases[1]!.id);
      assert.ok(
        reappliedRefundProjection &&
          !reappliedRefundProjection.profileMissing &&
          "lines" in reappliedRefundProjection,
      );
      assert.equal(reappliedRefundProjection.total, 9700);
      assert.equal(reappliedRefundProjection.requiresResave, false);
      secondProjection = reappliedRefundProjection;
      await orders.correctBillingCaseCustomer(
        cases[2]!.id,
        {
          ...structuredClone(first.customer),
          billingAddress: { ...first.customer.billingAddress, line1: "Via Milano 3" },
        },
        thirdProjection.caseRevision,
        "Indirizzo verificato",
        { id: 1, requestId: "invalidate-standard-draft-after-correction" },
      );
      const correctedThirdProjection = await documents.getInvoiceProjection(cases[2]!.id);
      assert.ok(
        correctedThirdProjection &&
          !correctedThirdProjection.profileMissing &&
          "lines" in correctedThirdProjection,
      );
      assert.equal(correctedThirdProjection.requiresResave, true);
      assert.equal((await documents.listMassApprovalCandidates()).length, 2);
      thirdProjection = await save(cases[2]!.id);
      await orders.importOrders([fifth], { id: 1, requestId: "reconcile-draft-after-grouping" });
      const groupedProjection = await documents.getInvoiceProjection(cases[0]!.id);
      assert.ok(
        groupedProjection && !groupedProjection.profileMissing && "lines" in groupedProjection,
      );
      assert.equal(groupedProjection.draftVersion, firstProjection.draftVersion + 1);
      assert.equal(groupedProjection.lines.length, 3);
      assert.equal(groupedProjection.requiresResave, true);
      assert.equal((await documents.listMassApprovalCandidates()).length, 2);
      firstProjection = await save(cases[0]!.id);
      const firstOrderIds = (
        await database
          .getPool()
          .query<{ id: string }>("SELECT id FROM orders WHERE billing_case_id = $1 ORDER BY id", [
            cases[0]!.id,
          ])
      ).rows;
      assert.equal(firstOrderIds.length, 3);
      await orders.separateOrderFromBillingCase(
        cases[0]!.id,
        firstOrderIds[1]!.id,
        firstProjection.caseRevision,
        { id: 1, requestId: "invalidate-draft-after-separation" },
      );
      const invalidated = await documents.getInvoiceProjection(cases[0]!.id);
      assert.ok(invalidated && !invalidated.profileMissing && "lines" in invalidated);
      assert.equal(invalidated.draftVersion, firstProjection.draftVersion + 1);
      assert.equal(invalidated.lines.length, 2);
      assert.equal(invalidated.requiresResave, true);
      await database.getPool().query(
        `UPDATE orders
         SET normalized_snapshot_json = jsonb_set(
           normalized_snapshot_json, '{customer,billingAddress,line1}', '"Via Origine 5"'
         )
         WHERE external_order_id = $1`,
        [fifth.externalOrderId],
      );
      const regeneratedFirstProjection = await save(cases[0]!.id);
      const reconciliationAudit = (
        await database.getPool().query<{
          before_json: { lines: unknown[] };
          after_json: { lines: unknown[] };
        }>(
          `SELECT before_json, after_json FROM audit_events
           WHERE action = 'ORDER_SEPARATED' AND request_id = $1`,
          ["invalidate-draft-after-separation"],
        )
      ).rows[0]!;
      assert.equal(reconciliationAudit.before_json.lines.length, 3);
      assert.equal(reconciliationAudit.after_json.lines.length, 2);
      const sourceAudit = (
        await database.getPool().query<{
          before_json: {
            imported: { recipients: Array<{ recipient: { address: { line1: string } } }> };
          };
        }>(
          `SELECT before_json FROM audit_events
           WHERE action = 'DOCUMENT_DRAFT_SAVED' AND request_id = $1
           ORDER BY id DESC LIMIT 1`,
          [`save-${cases[0]!.id}`],
        )
      ).rows[0]!.before_json.imported.recipients;
      assert.deepEqual(
        sourceAudit.map(({ recipient: importedRecipient }) => importedRecipient.address.line1),
        ["Via Esempio 1", "Via Origine 5"],
      );
      await documents.saveInvoiceDraft(
        cases[1]!.id,
        {
          caseRevision: secondProjection.caseRevision,
          draftVersion: secondProjection.draftVersion,
          differenceReason: "Incasso e arrotondamento verificati",
          paymentStatus: "PENDING",
          paymentMethod: "MP05",
          causale: "Cessione beni usati",
          notes: "Incasso da registrare",
          lines: secondProjection.lines.map((line, index) =>
            index === 0 ? { ...line, unitAmount: line.unitAmount + 1 } : line,
          ),
        },
        { id: 1, canApprove: true, requestId: "save-exceptional-second" },
      );
      let exceptionalSecondProjection = await documents.getInvoiceProjection(cases[1]!.id);
      assert.ok(
        exceptionalSecondProjection &&
          !exceptionalSecondProjection.profileMissing &&
          "lines" in exceptionalSecondProjection,
      );
      assert.equal(exceptionalSecondProjection.paymentStatus, "PENDING");
      assert.equal(exceptionalSecondProjection.paymentMethod, "MP05");
      assert.equal(exceptionalSecondProjection.difference, 1);
      await orders.correctBillingCaseCustomer(
        cases[1]!.id,
        {
          kind: "PRIVATE_IT",
          displayName: "Mario Rossi",
          firstName: "Mario",
          lastName: "Rossi",
          email: "mario.rossi@example.invalid",
          billingAddress: {
            line1: "Via Roma 2",
            postalCode: "00100",
            city: "Roma",
            province: "RM",
            countryCode: "IT",
          },
          taxIdentifiers: [
            {
              type: "CODICE_FISCALE",
              value: "RSSMRA80A01H501U",
              sourceField: "correzione-manuale",
            },
          ],
        },
        exceptionalSecondProjection.caseRevision,
        "Indirizzo verificato",
        { id: 1, requestId: "correct-customer-with-draft" },
      );
      const correctedSecondProjection = await documents.getInvoiceProjection(cases[1]!.id);
      assert.ok(
        correctedSecondProjection &&
          !correctedSecondProjection.profileMissing &&
          "lines" in correctedSecondProjection,
      );
      assert.equal(
        correctedSecondProjection.draftVersion,
        exceptionalSecondProjection.draftVersion,
      );
      assert.equal(correctedSecondProjection.paymentStatus, "PENDING");
      assert.equal(correctedSecondProjection.paymentMethod, "MP05");
      assert.equal(correctedSecondProjection.causale, "Cessione beni usati");
      assert.equal(correctedSecondProjection.notes, "Incasso da registrare");
      assert.equal(correctedSecondProjection.requiresResave, true);
      await assert.rejects(
        documents.approveInvoice(
          cases[1]!.id,
          {
            caseRevision: correctedSecondProjection.caseRevision,
            draftVersion: correctedSecondProjection.draftVersion,
            projectionSha256: exceptionalSecondProjection.projectionSha256,
            confirmPending: true,
            confirmDifference: true,
            emailChoice: "SKIP",
            emailModeVersion: correctedSecondProjection.customerEmail.version,
          },
          { id: 1, canApprove: true, requestId: "customer-correction-stale" },
        ),
        (error) => error instanceof AppError && error.code === "DOCUMENT_PROJECTION_STALE",
      );
      await documents.saveInvoiceDraft(
        cases[1]!.id,
        {
          caseRevision: correctedSecondProjection.caseRevision,
          draftVersion: correctedSecondProjection.draftVersion,
          differenceReason: correctedSecondProjection.differenceReason,
          paymentStatus: correctedSecondProjection.paymentStatus,
          paymentMethod: correctedSecondProjection.paymentMethod,
          causale: correctedSecondProjection.causale,
          notes: correctedSecondProjection.notes,
          lines: correctedSecondProjection.lines,
        },
        { id: 1, canApprove: true, requestId: "resave-after-customer-correction" },
      );
      exceptionalSecondProjection = await documents.getInvoiceProjection(cases[1]!.id);
      assert.ok(
        exceptionalSecondProjection &&
          !exceptionalSecondProjection.profileMissing &&
          "lines" in exceptionalSecondProjection,
      );
      assert.equal(exceptionalSecondProjection.requiresResave, false);
      const correctionAudit = (
        await database.getPool().query<{
          before_json: Record<string, unknown>;
          after_json: Record<string, unknown>;
        }>(
          `SELECT before_json, after_json FROM audit_events
           WHERE action = 'DOCUMENT_DRAFT_SAVED' AND request_id = $1`,
          ["resave-after-customer-correction"],
        )
      ).rows[0]!;
      const correctionBefore = correctionAudit.before_json as {
        imported: { recipients: Array<{ recipient: { address: { line1: string } } }> };
        previous: { recipient: { address: { line1: string } } };
      };
      const correctionAfter = correctionAudit.after_json as {
        current: { recipient: { address: { line1: string } } };
      };
      assert.equal(
        correctionBefore.imported.recipients[0]!.recipient.address.line1,
        "Via Esempio 1",
      );
      assert.equal(correctionBefore.previous.recipient.address.line1, "Via Esempio 1");
      assert.equal(correctionAfter.current.recipient.address.line1, "Via Roma 2");
      assert.equal((await documents.listMassApprovalCandidates()).length, 2);
      await assert.rejects(
        documents.approveInvoice(
          cases[0]!.id,
          {
            caseRevision: regeneratedFirstProjection.caseRevision,
            draftVersion: regeneratedFirstProjection.draftVersion,
            projectionSha256: regeneratedFirstProjection.projectionSha256,
            confirmPending: false,
            confirmDifference: false,
            emailChoice: "SKIP",
            emailModeVersion: regeneratedFirstProjection.customerEmail.version,
          },
          { id: 2, canApprove: false, requestId: "codex-direct" },
        ),
        (error) => error instanceof AppError && error.code === "DOCUMENT_APPROVAL_FORBIDDEN",
      );
      await assert.rejects(
        documents.approveInvoice(
          cases[0]!.id,
          {
            caseRevision: regeneratedFirstProjection.caseRevision,
            draftVersion: regeneratedFirstProjection.draftVersion,
            projectionSha256: "0".repeat(64),
            confirmPending: false,
            confirmDifference: false,
            emailChoice: "SKIP",
            emailModeVersion: regeneratedFirstProjection.customerEmail.version,
          },
          { id: 1, canApprove: true, requestId: "stale" },
        ),
        (error) => error instanceof AppError && error.code === "DOCUMENT_PROJECTION_STALE",
      );
      const approved = await Promise.all(
        [regeneratedFirstProjection, exceptionalSecondProjection].map((projection, index) =>
          documents.approveInvoice(
            cases[index]!.id,
            {
              caseRevision: projection.caseRevision,
              draftVersion: projection.draftVersion,
              projectionSha256: projection.projectionSha256,
              confirmPending: index === 1,
              confirmDifference: index === 1,
              emailChoice: "SKIP",
              emailModeVersion: projection.customerEmail.version,
            },
            { id: 1, canApprove: true, requestId: `approve-${index}` },
          ),
        ),
      );
      const expectedYear = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Rome",
        year: "2-digit",
      }).format(new Date());
      const expectedFullYear = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Rome",
        year: "numeric",
      }).format(new Date());
      assert.deepEqual(approved.map((document) => document!.fiscalNumber).sort(), [
        `FPR 0002/${expectedYear}`,
        `FPR 0003/${expectedYear}`,
      ]);
      const owner = { id: 1, canApprove: true, requestId: "aruba-m5" };
      const assistedBatchId = approved[0]!.batchId;
      const invalidBatchId = approved[1]!.batchId;
      const invalidDocumentId = (
        await database
          .getPool()
          .query<{ document_id: string }>(
            "SELECT document_id FROM aruba_batch_documents WHERE batch_id = $1",
            [invalidBatchId],
          )
      ).rows[0]!.document_id;
      assert.deepEqual(
        (
          await database.getPool().query(
            `SELECT transport, mode, status FROM aruba_batches
             WHERE id = ANY($1::uuid[]) ORDER BY id`,
            [[assistedBatchId, invalidBatchId]],
          )
        ).rows,
        [
          { transport: "API", mode: "DOCUMENT_ONLY", status: "DOCUMENT_ONLY" },
          { transport: "API", mode: "DOCUMENT_ONLY", status: "DOCUMENT_ONLY" },
        ],
      );
      const approvedEvidence = (
        await database.getPool().query<{
          id: string;
          pending_payment_confirmed_at: string | null;
          amount_difference_confirmed_at: string | null;
        }>(
          `SELECT id, pending_payment_confirmed_at, amount_difference_confirmed_at
           FROM documents WHERE billing_case_id = $1`,
          [cases[0]!.id],
        )
      ).rows[0]!;
      assert.equal(approvedEvidence.pending_payment_confirmed_at, null);
      assert.equal(approvedEvidence.amount_difference_confirmed_at, null);
      assert.deepEqual(
        (
          await database.getPool().query<{ action: string }>(
            `SELECT action FROM audit_events
             WHERE action IN ('DOCUMENT_PENDING_PAYMENT_CONFIRMED', 'DOCUMENT_AMOUNT_DIFFERENCE_CONFIRMED')
             ORDER BY action`,
          )
        ).rows.map((row) => row.action),
        ["DOCUMENT_AMOUNT_DIFFERENCE_CONFIRMED", "DOCUMENT_PENDING_PAYMENT_CONFIRMED"],
      );
      const approvedProjection = await documents.getInvoiceProjection(cases[0]!.id);
      assert.ok(
        approvedProjection && !approvedProjection.profileMissing && "xml" in approvedProjection,
      );
      assert.doesNotMatch(approvedProjection.xml, /FPR 0000\//);
      assert.match(
        approvedProjection.xml,
        new RegExp(approved[0]!.fiscalNumber.replace("/", "\\/")),
      );
      await assert.rejects(
        database.getPool().query(
          `UPDATE document_lines
           SET document_id = $1
           WHERE document_id = (SELECT id FROM documents WHERE billing_case_id = $2)`,
          [approvedEvidence.id, cases[2]!.id],
        ),
        /immutabili/,
      );
      assert.equal(thirdProjection.difference, 0);
      const approvalToken = (caseId: string, projection: typeof thirdProjection) =>
        `${caseId}:${projection.caseRevision}:${projection.draftVersion}:${projection.projectionSha256}`;
      await assert.rejects(
        documents.approveInvoices([approvalToken(cases[2]!.id, thirdProjection)], {
          id: 1,
          canApprove: true,
          requestId: "approve-mass-without-confirmation",
        }),
        (error) => error instanceof AppError && error.code === "DOCUMENT_NOT_APPROVABLE",
      );
      await database
        .getPool()
        .query("UPDATE documents SET document_date = current_date - 1 WHERE billing_case_id = $1", [
          cases[2]!.id,
        ]);
      const dateChangedProjection = await documents.getInvoiceProjection(cases[2]!.id);
      assert.ok(
        dateChangedProjection &&
          !dateChangedProjection.profileMissing &&
          "lines" in dateChangedProjection,
      );
      assert.equal(dateChangedProjection.requiresResave, true);
      assert.equal((await documents.listMassApprovalCandidates()).length, 0);
      await documents.saveInvoiceDraft(
        cases[2]!.id,
        {
          caseRevision: dateChangedProjection.caseRevision,
          draftVersion: dateChangedProjection.draftVersion,
          differenceReason: "",
          paymentStatus: dateChangedProjection.paymentStatus,
          paymentMethod: dateChangedProjection.paymentMethod,
          causale: "Cessione beni usati",
          notes: "Pagamento verificato",
          lines: dateChangedProjection.lines,
        },
        { id: 1, canApprove: true, requestId: "save-third-again" },
      );
      assert.deepEqual(
        await documents.approveInvoices(
          [approvalToken(cases[2]!.id, thirdProjection)],
          { id: 1, canApprove: true, requestId: "approve-mass-stale" },
          true,
          "DOCUMENT_ONLY",
          { [cases[2]!.id]: "SKIP" },
          thirdProjection.customerEmail.version,
        ),
        { approved: 0, failed: 1, storagePending: 0 },
      );
      const freshThirdProjection = await documents.getInvoiceProjection(cases[2]!.id);
      assert.ok(
        freshThirdProjection &&
          !freshThirdProjection.profileMissing &&
          "lines" in freshThirdProjection,
      );
      const thirdOrderId = (
        await database
          .getPool()
          .query<{ id: string }>("SELECT id FROM orders WHERE billing_case_id = $1", [cases[2]!.id])
      ).rows[0]!.id;
      await database
        .getPool()
        .query("UPDATE orders SET billing_case_id = NULL WHERE id = $1", [thirdOrderId]);
      await database
        .getPool()
        .query("UPDATE documents SET projection_sha256 = $2 WHERE billing_case_id = $1", [
          cases[2]!.id,
          freshThirdProjection.projectionSha256,
        ]);
      await assert.rejects(
        documents.approveInvoice(
          cases[2]!.id,
          {
            caseRevision: freshThirdProjection.caseRevision,
            draftVersion: freshThirdProjection.draftVersion,
            projectionSha256: freshThirdProjection.projectionSha256,
            confirmPending: false,
            confirmDifference: false,
            emailChoice: "SKIP",
            emailModeVersion: freshThirdProjection.customerEmail.version,
          },
          { id: 1, canApprove: true, requestId: "old-app-membership-change" },
        ),
        (error) => error instanceof AppError && error.code === "DOCUMENT_PROJECTION_STALE",
      );
      await database
        .getPool()
        .query("UPDATE orders SET billing_case_id = $2 WHERE id = $1", [
          thirdOrderId,
          cases[2]!.id,
        ]);
      const restoredThirdProjection = await documents.getInvoiceProjection(cases[2]!.id);
      assert.ok(
        restoredThirdProjection &&
          !restoredThirdProjection.profileMissing &&
          "lines" in restoredThirdProjection,
      );
      await documents.saveInvoiceDraft(
        cases[2]!.id,
        {
          caseRevision: restoredThirdProjection.caseRevision,
          draftVersion: restoredThirdProjection.draftVersion,
          differenceReason: restoredThirdProjection.differenceReason,
          paymentStatus: restoredThirdProjection.paymentStatus,
          paymentMethod: restoredThirdProjection.paymentMethod,
          causale: restoredThirdProjection.causale,
          notes: restoredThirdProjection.notes,
          lines: restoredThirdProjection.lines,
        },
        { id: 1, canApprove: true, requestId: "resave-after-old-app-membership-change" },
      );
      const approvableThirdProjection = await documents.getInvoiceProjection(cases[2]!.id);
      assert.ok(
        approvableThirdProjection &&
          !approvableThirdProjection.profileMissing &&
          "lines" in approvableThirdProjection,
      );
      const arubaSettings = await aruba.getArubaSettings();
      const runtimeConfigForOutbound = (await import("../config.server.ts")).getConfig();
      Object.assign(runtimeConfigForOutbound, { ARUBA_SUBMISSION_ENABLED: true });
      await database.getPool().query(
        `INSERT INTO connections
           (provider, environment, account_reference, encrypted_credentials, status,
            credentials_verified_at, api_paused, automatic_authority)
         VALUES ('ARUBA', 'DEVELOPMENT', 'synthetic-aruba-account', 'synthetic', 'CONNECTED',
           now(), false, 'API')
         ON CONFLICT (provider, environment) DO UPDATE SET
           encrypted_credentials = EXCLUDED.encrypted_credentials,
           status = EXCLUDED.status,
           credentials_verified_at = EXCLUDED.credentials_verified_at,
           api_paused = EXCLUDED.api_paused,
           automatic_authority = EXCLUDED.automatic_authority`,
      );
      await aruba.setArubaSettings(
        {
          mode: "AUTOMATIC_AFTER_APPROVAL",
          modeVersion: arubaSettings.mode.version,
        },
        owner,
      );
      const finalStorageDirectory = path.join(storage, "invoices", expectedFullYear);
      await chmod(finalStorageDirectory, 0o500);
      try {
        assert.deepEqual(
          await documents.approveInvoices(
            [approvalToken(cases[2]!.id, approvableThirdProjection)],
            { id: 1, canApprove: true, requestId: "approve-mass" },
            true,
            "AUTOMATIC_AFTER_APPROVAL",
            { [cases[2]!.id]: "SEND" },
            approvableThirdProjection.customerEmail.version,
          ),
          { approved: 1, failed: 0, storagePending: 1 },
        );
      } finally {
        await chmod(finalStorageDirectory, 0o700);
      }
      assert.deepEqual(
        (
          await database
            .getPool()
            .query(
              "SELECT customer_email_choice, customer_email_sender FROM documents WHERE billing_case_id = $1",
              [cases[2]!.id],
            )
        ).rows[0],
        { customer_email_choice: "SEND", customer_email_sender: "approvazioni@example.invalid" },
      );
      const rows = (
        await database.getPool().query<{
          id: string;
          fiscal_number: number;
          relative_path: string;
          sha256: string;
        }>(
          `SELECT documents.id, documents.fiscal_number, storage_objects.relative_path,
                  storage_objects.sha256
           FROM documents JOIN storage_objects ON storage_objects.id = documents.storage_object_id
           ORDER BY documents.fiscal_number`,
        )
      ).rows;
      assert.equal(rows.length, 3);
      for (const row of rows) {
        const xml = await documentStorage.readDocumentXml(row.id);
        assert.ok(xml?.includes(Buffer.from("<RegimeFiscale>RF14</RegimeFiscale>")));
      }
      const mixedDocuments = (
        await database.getPool().query<{
          id: string;
          draft_version: number;
          xml_sha256: string;
          size_bytes: number;
          series: string;
          fiscal_number: number;
          fiscal_year: number;
          document_date: string;
          total_amount: number;
        }>(
          `SELECT documents.id, documents.draft_version, documents.xml_sha256,
                  storage.size_bytes, documents.series, documents.fiscal_number,
                  documents.fiscal_year, documents.document_date::text, documents.total_amount
           FROM documents
           JOIN storage_objects AS storage ON storage.id = documents.storage_object_id
           WHERE documents.status = 'APPROVED'
           ORDER BY documents.id LIMIT 2`,
        )
      ).rows.map((row) => ({
        id: row.id,
        revision: row.draft_version,
        sha256: row.xml_sha256,
        filename: `${row.series}-${String(row.fiscal_number).padStart(4, "0")}-${String(row.fiscal_year).slice(-2)}.xml`,
        sizeBytes: row.size_bytes,
        fiscalNumber: `${row.series} ${String(row.fiscal_number).padStart(4, "0")}/${String(row.fiscal_year).slice(-2)}`,
        documentDate: row.document_date,
        totalAmount: row.total_amount,
      }));
      const runtimeConfig = (await import("../config.server.ts")).getConfig();
      const originalArubaRuntime = {
        APP_ENV: runtimeConfig.APP_ENV,
        ARUBA_ACCOUNT_REFERENCE: runtimeConfig.ARUBA_ACCOUNT_REFERENCE,
        ARUBA_SUBMISSION_ENABLED: runtimeConfig.ARUBA_SUBMISSION_ENABLED,
      };
      Object.assign(runtimeConfig, {
        APP_ENV: "production",
        ARUBA_ACCOUNT_REFERENCE: "qualified-production-account",
        ARUBA_SUBMISSION_ENABLED: false,
      });
      await assert.rejects(
        database.withTransaction((client) =>
          arubaOutbound.createArubaApiBatch(client, mixedDocuments, owner, "DOCUMENT_ONLY"),
        ),
        (error) => error instanceof AppError && error.code === "DOCUMENT_NOT_APPROVABLE",
      );
      await database.getPool().query(
        `UPDATE connections SET environment = 'PRODUCTION',
           account_reference = 'qualified-production-account', status = 'CONNECTED',
           encrypted_credentials = 'synthetic-invalid-ciphertext',
           credentials_verified_at = now(), api_paused = false
         WHERE provider = 'ARUBA'`,
      );
      const qualificationBatchId = await database.withTransaction((client) =>
        arubaOutbound.createArubaApiBatch(
          client,
          [mixedDocuments[0]!],
          owner,
          "DOCUMENT_ONLY",
          true,
        ),
      );
      await assert.rejects(
        arubaOutbound.authorizeArubaApiDryRunQualification(qualificationBatchId, owner, false),
        (error) => error instanceof AppError && error.code === "ARUBA_BATCH_INVALID",
      );
      const qualification = await arubaOutbound.authorizeArubaApiDryRunQualification(
        qualificationBatchId,
        owner,
        true,
      );
      assert.match(qualification.qualificationId, /^[0-9a-f-]{36}$/);
      assert.equal(qualification.queued, 1);
      await database.getPool().query(
        `UPDATE jobs SET run_at = now() + interval '1 hour'
         WHERE status = 'PENDING' AND id <> (
           SELECT jobs.id FROM jobs
           JOIN aruba_submissions AS submissions
             ON jobs.payload_json ->> 'submissionId' = submissions.id::text
           WHERE submissions.batch_id = $1 AND jobs.type = 'aruba_dry_run_submission'
         )`,
        [qualificationBatchId],
      );
      const qualificationJob = await jobs.claimJob("aruba-dry-run-qualification-worker");
      assert.equal(qualificationJob?.type, "aruba_dry_run_submission");
      const qualificationResult = await arubaOutbound.runArubaApiOutboundJob(qualificationJob!);
      assert.equal(qualificationResult.accepted, false);
      assert.equal(await jobs.completeJob(qualificationJob!, qualificationResult), true);
      assert.deepEqual(
        (
          await database.getPool().query(
            `SELECT qualifications.status, qualifications.consumed_at IS NOT NULL AS consumed,
                    qualifications.completed_at IS NOT NULL AS completed,
                    batches.status AS batch_status, submissions.status AS submission_status
             FROM aruba_dry_run_qualifications AS qualifications
             JOIN aruba_batches AS batches ON batches.id = qualifications.batch_id
             JOIN aruba_submissions AS submissions ON submissions.batch_id = batches.id
             WHERE batches.id = $1`,
            [qualificationBatchId],
          )
        ).rows[0],
        {
          status: "FAILED",
          consumed: true,
          completed: true,
          batch_status: "DRY_RUN_FAILED",
          submission_status: "DRY_RUN_FAILED",
        },
      );
      assert.equal(runtimeConfig.ARUBA_SUBMISSION_ENABLED, false);
      await assert.rejects(
        arubaOutbound.authorizeArubaApiDryRunQualification(qualificationBatchId, owner, true),
        (error) => error instanceof AppError && error.code === "ARUBA_BATCH_INVALID",
      );
      const interruptedBatchId = await database.withTransaction((client) =>
        arubaOutbound.createArubaApiBatch(
          client,
          [mixedDocuments[0]!],
          owner,
          "DOCUMENT_ONLY",
          true,
        ),
      );
      await arubaOutbound.authorizeArubaApiDryRunQualification(interruptedBatchId, owner, true);
      await database.getPool().query(
        `UPDATE jobs SET run_at = now() + interval '1 hour'
         WHERE status = 'PENDING' AND id <> (
           SELECT jobs.id FROM jobs
           JOIN aruba_submissions AS submissions
             ON jobs.payload_json ->> 'submissionId' = submissions.id::text
           WHERE submissions.batch_id = $1 AND jobs.type = 'aruba_dry_run_submission'
         )`,
        [interruptedBatchId],
      );
      const interruptedJob = await jobs.claimJob("aruba-dry-run-recovery-worker");
      assert.equal(interruptedJob?.type, "aruba_dry_run_submission");
      await database.getPool().query(
        `UPDATE aruba_dry_run_qualifications
         SET status = 'CONSUMED', consumed_at = now()
         WHERE batch_id = $1`,
        [interruptedBatchId],
      );
      await database.getPool().query(
        `INSERT INTO aruba_submission_attempts
           (id, submission_id, operation, attempt_number, request_fingerprint,
            xml_sha256, status, started_at)
         SELECT $2, submissions.id, 'DRY_RUN', 1, repeat('9', 64),
                submissions.xml_sha256, 'RUNNING', now()
         FROM aruba_submissions AS submissions WHERE submissions.batch_id = $1`,
        [interruptedBatchId, "40000000-0000-4000-8000-000000000040"],
      );
      const recoveredDryRun = await arubaOutbound.runArubaApiOutboundJob(interruptedJob!);
      assert.deepEqual(recoveredDryRun, {
        accepted: false,
        unknownRemoteState: true,
        submissionId: interruptedJob!.payload.submissionId,
        batchId: interruptedBatchId,
      });
      assert.equal(await jobs.completeJob(interruptedJob!, recoveredDryRun), true);
      assert.deepEqual(
        (
          await database.getPool().query(
            `SELECT qualifications.status, batches.status AS batch_status,
                    batches.requires_reconciliation, submissions.status AS submission_status,
                    attempts.status AS attempt_status
             FROM aruba_dry_run_qualifications AS qualifications
             JOIN aruba_batches AS batches ON batches.id = qualifications.batch_id
             JOIN aruba_submissions AS submissions ON submissions.batch_id = batches.id
             JOIN aruba_submission_attempts AS attempts
               ON attempts.submission_id = submissions.id
             WHERE batches.id = $1`,
            [interruptedBatchId],
          )
        ).rows[0],
        {
          status: "UNKNOWN_REMOTE_STATE",
          batch_status: "UNKNOWN_REMOTE_STATE",
          requires_reconciliation: true,
          submission_status: "UNKNOWN_REMOTE_STATE",
          attempt_status: "UNKNOWN_REMOTE_STATE",
        },
      );
      const cancelledBatchId = await database.withTransaction((client) =>
        arubaOutbound.createArubaApiBatch(
          client,
          [mixedDocuments[0]!],
          owner,
          "DOCUMENT_ONLY",
          true,
        ),
      );
      await arubaOutbound.authorizeArubaApiDryRunQualification(cancelledBatchId, owner, true);
      await database.getPool().query(
        `UPDATE jobs SET run_at = now() + interval '1 hour'
         WHERE status = 'PENDING' AND id <> (
           SELECT jobs.id FROM jobs
           JOIN aruba_submissions AS submissions
             ON jobs.payload_json ->> 'submissionId' = submissions.id::text
           WHERE submissions.batch_id = $1 AND jobs.type = 'aruba_dry_run_submission'
         )`,
        [cancelledBatchId],
      );
      await database
        .getPool()
        .query("UPDATE connections SET api_paused = true WHERE provider = 'ARUBA'");
      const cancelledJob = await jobs.claimJob("aruba-dry-run-cancelled-worker");
      const cancelledResult = await arubaOutbound.runArubaApiOutboundJob(cancelledJob!);
      assert.equal(cancelledResult.accepted, false);
      assert.equal(await jobs.completeJob(cancelledJob!, cancelledResult), true);
      assert.deepEqual(
        (
          await database.getPool().query(
            `SELECT qualifications.status, batches.status AS batch_status,
                    submissions.status AS submission_status
             FROM aruba_dry_run_qualifications AS qualifications
             JOIN aruba_batches AS batches ON batches.id = qualifications.batch_id
             JOIN aruba_submissions AS submissions ON submissions.batch_id = batches.id
             WHERE batches.id = $1`,
            [cancelledBatchId],
          )
        ).rows[0],
        {
          status: "CANCELLED",
          batch_status: "DRY_RUN_FAILED",
          submission_status: "DRY_RUN_FAILED",
        },
      );
      await database.getPool().query(
        `UPDATE connections SET environment = 'DEVELOPMENT',
           account_reference = 'synthetic-aruba-account', status = 'CONNECTED',
           encrypted_credentials = 'synthetic', credentials_verified_at = now(),
           api_paused = false, automatic_authority = 'API'
         WHERE provider = 'ARUBA'`,
      );
      Object.assign(runtimeConfig, originalArubaRuntime);
      await assert.rejects(
        database.withTransaction((client) =>
          arubaOutbound.createArubaApiBatch(
            client,
            [{ ...mixedDocuments[0]!, sizeBytes: 30_000_001 }],
            owner,
            undefined,
            true,
          ),
        ),
        (error) => error instanceof AppError && error.code === "ARUBA_BATCH_INVALID",
      );
      const batchCountBeforeAuditFailure = (
        await database.getPool().query("SELECT count(*) FROM aruba_batches")
      ).rows[0].count;
      await database.getPool().query(`
        CREATE FUNCTION reject_test_aruba_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.action = 'ARUBA_BATCH_CREATED' THEN
            RAISE EXCEPTION 'test audit rollback';
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER reject_test_aruba_audit
        BEFORE INSERT ON audit_events
        FOR EACH ROW EXECUTE FUNCTION reject_test_aruba_audit();
      `);
      await assert.rejects(
        database.withTransaction((client) =>
          arubaOutbound.createArubaApiBatch(client, mixedDocuments, owner, undefined, true),
        ),
        /test audit rollback/,
      );
      assert.equal(
        (await database.getPool().query("SELECT count(*) FROM aruba_batches")).rows[0].count,
        batchCountBeforeAuditFailure,
      );
      await database.getPool().query(`
        DROP TRIGGER reject_test_aruba_audit ON audit_events;
        DROP FUNCTION reject_test_aruba_audit();
      `);
      const automaticBatchId = (
        await database.getPool().query<{ id: string }>(
          `SELECT id FROM aruba_batches
           WHERE mode = 'AUTOMATIC_AFTER_APPROVAL' AND transport = 'API'
           ORDER BY created_at DESC LIMIT 1`,
        )
      ).rows[0]!.id;
      assert.deepEqual(
        (
          await database.getPool().query(
            `SELECT batches.status, submissions.status AS submission_status,
                    jobs.max_attempts
             FROM aruba_batches AS batches
             JOIN aruba_submissions AS submissions ON submissions.batch_id = batches.id
             JOIN jobs ON jobs.payload_json ->> 'submissionId' = submissions.id::text
             WHERE batches.id = $1`,
            [automaticBatchId],
          )
        ).rows[0],
        {
          status: "DRY_RUN_PENDING",
          submission_status: "DRY_RUN_PENDING",
          max_attempts: 1,
        },
      );
      await database
        .getPool()
        .query("ALTER TABLE aruba_batch_documents DISABLE TRIGGER aruba_batch_documents_immutable");
      await database
        .getPool()
        .query("DELETE FROM aruba_batch_documents WHERE document_id = $1", [invalidDocumentId]);
      await database
        .getPool()
        .query("ALTER TABLE aruba_batch_documents ENABLE TRIGGER aruba_batch_documents_immutable");
      const concurrentBatches = await Promise.allSettled([
        aruba.createBatchForDocuments([invalidDocumentId], owner),
        aruba.createBatchForDocuments([invalidDocumentId], owner),
      ]);
      assert.equal(concurrentBatches.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(concurrentBatches.filter((result) => result.status === "rejected").length, 1);
      await unlink(path.join(storage, rows[0]!.relative_path));
      assert.ok(
        (await documentStorage.readDocumentXml(rows[0]!.id))?.includes(
          Buffer.from("<RegimeFiscale>RF14</RegimeFiscale>"),
        ),
      );
      await assert.rejects(
        database.getPool().query("UPDATE documents SET total_amount = total_amount + 1"),
        /immutabile/,
      );
      assert.ok(
        (
          await database.getPool().query<{ can_approve: boolean }>("SELECT can_approve FROM users")
        ).rows.every((user) => user.can_approve),
      );
      const directOrder = structuredClone(fixture[0]);
      directOrder.externalOrderId = "shop-order-documents-direct-approval";
      directOrder.displayNumber = "#DOC-DIRECT";
      directOrder.createdAt = "2026-08-13T08:00:00Z";
      directOrder.updatedAt = "2026-08-13T09:00:00Z";
      await orders.importOrders([directOrder], {
        id: 1,
        requestId: "documents-direct-approval-import",
      });
      const directCase = (
        await database.getPool().query<{ id: string }>(
          `SELECT billing_cases.id
           FROM billing_cases
           JOIN orders ON orders.billing_case_id = billing_cases.id
           WHERE orders.external_order_id = $1`,
          [directOrder.externalOrderId],
        )
      ).rows[0]!;
      const directProjection = await documents.getInvoiceProjection(directCase.id);
      assert.ok(
        directProjection && !directProjection.profileMissing && "lines" in directProjection,
      );
      assert.equal(directProjection.draftVersion, 0);
      assert.equal(
        (
          await database
            .getPool()
            .query("SELECT count(*) FROM documents WHERE billing_case_id = $1", [directCase.id])
        ).rows[0].count,
        "0",
      );
      const directCandidate = (await documents.listMassApprovalCandidates()).find(
        ({ billing_case_id }) => billing_case_id === directCase.id,
      );
      assert.ok(directCandidate);
      assert.equal(directCandidate.draft_version, 0);
      assert.deepEqual(
        await documents.approveInvoices(
          [
            `${directCandidate.billing_case_id}:${directCandidate.case_revision}:${directCandidate.draft_version}:${directCandidate.projection_sha256}`,
          ],
          { id: 1, canApprove: true, requestId: "documents-mass-direct-approval" },
          true,
          directProjection.arubaMode,
          { [directCase.id]: "SKIP" },
          directProjection.customerEmail.version,
          true,
        ),
        { approved: 1, failed: 0, storagePending: 0 },
      );
      assert.deepEqual(
        (
          await database.getPool().query(
            `SELECT documents.status, documents.draft_version, billing_cases.status AS case_status
             FROM documents
             JOIN billing_cases ON billing_cases.id = documents.billing_case_id
             WHERE documents.billing_case_id = $1`,
            [directCase.id],
          )
        ).rows[0],
        { status: "APPROVED", draft_version: 1, case_status: "APPROVED" },
      );

      const staleIssuedCase = await database.getPool().query<{ id: string }>(
        `INSERT INTO billing_cases
          (customer_id, local_order_date, currency, status, customer_snapshot_json,
           fiscal_profile_version)
         SELECT customer_id, local_order_date, currency, 'READY', customer_snapshot_json,
                fiscal_profile_version
         FROM billing_cases WHERE id = $1
         RETURNING id`,
        [directCase.id],
      );
      await database.getPool().query(
        `UPDATE orders SET billing_case_id = $2, trigger_status = 'GROUPED'
         WHERE external_order_id = $1`,
        [directOrder.externalOrderId, staleIssuedCase.rows[0]!.id],
      );
      assert.equal(
        (await documents.listMassApprovalCandidates()).some(
          ({ billing_case_id }) => billing_case_id === staleIssuedCase.rows[0]!.id,
        ),
        false,
      );
      assert.equal(
        await documents.getStandardInvoiceApprovalProjection(staleIssuedCase.rows[0]!.id),
        null,
      );

      const reimportedIssuedOrder = structuredClone(directOrder);
      reimportedIssuedOrder.updatedAt = "2026-08-13T10:00:00Z";
      await orders.importOrders([reimportedIssuedOrder], {
        id: 1,
        requestId: "documents-reimport-already-invoiced",
      });
      assert.deepEqual(
        (
          await database.getPool().query(
            `SELECT orders.billing_case_id, orders.trigger_status,
                    stale_case.status AS stale_case_status,
                    original_case.status AS original_case_status,
                    count(audit_events.id)::integer AS reconciliation_events
             FROM orders
             JOIN billing_cases AS stale_case ON stale_case.id = $2
             JOIN billing_cases AS original_case ON original_case.id = $3
             LEFT JOIN audit_events
               ON audit_events.entity_type = 'ORDER'
              AND audit_events.entity_id = orders.id::text
              AND audit_events.action = 'ORDER_ALREADY_INVOICED_RECONCILED'
             WHERE orders.external_order_id = $1
             GROUP BY orders.id, stale_case.status, original_case.status`,
            [directOrder.externalOrderId, staleIssuedCase.rows[0]!.id, directCase.id],
          )
        ).rows[0],
        {
          billing_case_id: null,
          trigger_status: "INVOICED",
          stale_case_status: "CLOSED",
          original_case_status: "APPROVED",
          reconciliation_events: 1,
        },
      );
      await assert.rejects(
        orders.forcePrepareOrder(
          (
            await database
              .getPool()
              .query("SELECT id FROM orders WHERE external_order_id = $1", [
                directOrder.externalOrderId,
              ])
          ).rows[0].id,
          { id: 1, requestId: "documents-force-already-invoiced" },
        ),
        (error) => error instanceof AppError && error.code === "ORDER_NOT_PREPARABLE",
      );

      const blockedOrder = structuredClone(fixture[0]);
      blockedOrder.externalOrderId = "shop-order-documents-blocked-inventory";
      blockedOrder.displayNumber = "#DOC-BLOCKED";
      blockedOrder.createdAt = "2026-08-14T08:00:00Z";
      blockedOrder.updatedAt = "2026-08-14T09:00:00Z";
      await orders.importOrders([blockedOrder], {
        id: 1,
        requestId: "documents-blocked-inventory-import",
      });
      const blockedCase = (
        await database.getPool().query<{ id: string }>(
          `SELECT billing_cases.id
           FROM billing_cases
           JOIN orders ON orders.billing_case_id = billing_cases.id
           WHERE orders.external_order_id = $1`,
          [blockedOrder.externalOrderId],
        )
      ).rows[0]!;
      const blockedProjection = await documents.getInvoiceProjection(blockedCase.id);
      assert.ok(
        blockedProjection && !blockedProjection.profileMissing && "lines" in blockedProjection,
      );
      const inventoryLock = await database.getPool().connect();
      await inventoryLock.query("BEGIN");
      await inventoryLock.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "aruba-read:MOCK:synthetic-aruba-account",
      ]);
      let approvalSettled = false;
      const blockedApproval = documents
        .approveInvoice(
          blockedCase.id,
          {
            caseRevision: blockedProjection.caseRevision,
            draftVersion: blockedProjection.draftVersion,
            projectionSha256: blockedProjection.projectionSha256,
            confirmPending: false,
            confirmDifference: false,
            emailChoice: "SKIP",
            emailModeVersion: blockedProjection.customerEmail.version,
          },
          { id: 1, canApprove: true, requestId: "documents-blocked-inventory" },
        )
        .then(
          (value) => ({ value, error: null }),
          (error: unknown) => ({ value: null, error }),
        )
        .finally(() => {
          approvalSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(approvalSettled, false);
      await inventoryLock.query(
        `UPDATE aruba_sync_runs
         SET completed_at = now() - interval '25 hours',
             full_scan_completed_at = now() - interval '25 hours'`,
      );
      await inventoryLock.query("COMMIT");
      inventoryLock.release();
      const blockedOutcome = await blockedApproval;
      assert.ok(
        blockedOutcome.error instanceof AppError &&
          blockedOutcome.error.code === "ARUBA_INVENTORY_BLOCKED",
      );
      assert.equal(blockedOutcome.value, null);
      await database.getPool().query(
        `UPDATE aruba_sync_runs
         SET completed_at = now(), full_scan_completed_at = now()
         WHERE id = '00000000-0000-4000-8000-000000000301'`,
      );
      const blockedOrderId = (
        await database
          .getPool()
          .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
            blockedOrder.externalOrderId,
          ])
      ).rows[0]!.id;
      const conflictingRemote = await database.getPool().query<{ id: string }>(
        `INSERT INTO aruba_remote_documents
          (environment, account_reference, remote_id, document_type, fiscal_year,
           document_date, total_amount, remote_status, remote_status_observed_at,
           metadata_digest, automatic_source, provider_group_id, xml_sha256)
         VALUES ('MOCK', 'synthetic-aruba-account', 'documents-correlated-conflict', 'TD01',
                 2026, '2026-08-14', 1000, 'DELIVERED', now(), repeat('e', 64),
                 'API', 'documents-correlated-conflict', repeat('f', 64))
         RETURNING id`,
      );
      await database.getPool().query(
        `INSERT INTO aruba_document_matches
          (remote_document_id, status, method, matcher_version, candidates_json)
         VALUES ($1, 'AMBIGUOUS', 'NONE', 1,
           jsonb_build_array(jsonb_build_object(
             'candidateId', $2::text, 'probe', false, 'potential', false,
             'compatible', false, 'reviewable', false,
             'signals', jsonb_build_object(
               'provider', true, 'nearDate', true, 'recipient', true, 'total', false))))`,
        [conflictingRemote.rows[0]!.id, blockedOrderId],
      );
      const correlatedProjection = await documents.getInvoiceProjection(blockedCase.id);
      assert.ok(
        correlatedProjection &&
          !correlatedProjection.profileMissing &&
          "lines" in correlatedProjection,
      );
      assert.equal(correlatedProjection.arubaApprovalBlocked, false);
      await assert.rejects(
        documents.approveInvoice(
          blockedCase.id,
          {
            caseRevision: correlatedProjection.caseRevision,
            draftVersion: correlatedProjection.draftVersion,
            projectionSha256: correlatedProjection.projectionSha256,
            confirmPending: false,
            confirmDifference: false,
            emailChoice: "SKIP",
            emailModeVersion: correlatedProjection.customerEmail.version,
          },
          { id: 1, canApprove: true, requestId: "documents-correlated-aruba-conflict" },
        ),
        (error) => error instanceof AppError && error.code === "ARUBA_INVENTORY_BLOCKED",
      );
      assert.equal(
        (
          await database
            .getPool()
            .query("SELECT count(*) FROM documents WHERE billing_case_id = $1", [blockedCase.id])
        ).rows[0].count,
        "0",
      );
      assert.equal(
        (
          await database
            .getPool()
            .query("SELECT count(*) FROM audit_events WHERE action = 'DOCUMENT_APPROVED'")
        ).rows[0].count,
        "4",
      );
      const draftAudit = (
        await database.getPool().query<{
          before_json: unknown;
          after_json: unknown;
        }>(
          `SELECT before_json, after_json FROM audit_events
           WHERE action = 'DOCUMENT_DRAFT_SAVED' ORDER BY id DESC LIMIT 1`,
        )
      ).rows[0]!;
      assert.ok(draftAudit.before_json);
      assert.ok(draftAudit.after_json);
      await database.closePool();
    } finally {
      await import("./client.server.ts").then(({ closePool }) => closePool());
      await databaseFixture.drop();
      await rm(storage, { recursive: true });
    }
  },
);
