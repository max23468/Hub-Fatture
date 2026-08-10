import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  { timeout: 30_000 },
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
      const documents = await import("./documents.server.ts");
      const aruba = await import("./aruba.server.ts");
      const orders = await import("./orders.server.ts");
      const database = await import("./client.server.ts");
      await database
        .getPool()
        .query(
          "INSERT INTO users (username, password_hash, can_approve) VALUES ('matteo', 'synthetic', true)",
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
      await documents.activateFiscalProfile(syntheticFiscalProfile, "a".repeat(64), {
        id: 1,
        canApprove: true,
        requestId: "documents-profile",
      });
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
            confirmApproval: true,
            confirmPending: true,
            confirmDifference: true,
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
            confirmApproval: true,
            confirmPending: false,
            confirmDifference: false,
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
            projectionSha256: regeneratedFirstProjection.projectionSha256,
            confirmApproval: false,
            confirmPending: false,
            confirmDifference: false,
          },
          { id: 1, canApprove: true, requestId: "missing-final-confirmation" },
        ),
        (error) => error instanceof AppError && error.code === "DOCUMENT_NOT_APPROVABLE",
      );
      await assert.rejects(
        documents.approveInvoice(
          cases[0]!.id,
          {
            caseRevision: regeneratedFirstProjection.caseRevision,
            draftVersion: regeneratedFirstProjection.draftVersion,
            projectionSha256: "0".repeat(64),
            confirmApproval: true,
            confirmPending: false,
            confirmDifference: false,
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
              confirmApproval: true,
              confirmPending: index === 1,
              confirmDifference: index === 1,
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
      assert.ok(assistedBatchId && invalidBatchId);
      await assert.rejects(
        aruba.issueHelperToken(assistedBatchId, {
          id: 2,
          canApprove: false,
          requestId: "aruba-not-owner",
        }),
        (error) => error instanceof AppError && error.code === "ARUBA_PERMIT_FORBIDDEN",
      );
      const assistedToken = await aruba.issueHelperToken(assistedBatchId, owner);
      const assistedManifest = await aruba.helperManifest(assistedToken.token);
      assert.equal(assistedManifest.mode, "ASSISTED");
      assert.equal(assistedManifest.accountReference, "synthetic-aruba-account");
      assert.deepEqual(
        (
          await database
            .getPool()
            .query(
              "SELECT provider, account_reference, encrypted_credentials FROM connections WHERE provider = 'ARUBA'",
            )
        ).rows,
        [
          {
            provider: "ARUBA",
            account_reference: "synthetic-aruba-account",
            encrypted_credentials: null,
          },
        ],
      );
      assert.equal(assistedManifest.operation, "UPLOAD");
      assert.equal(assistedManifest.documents.length, 1);
      const assistedXml = await aruba.helperDocumentXml(
        assistedToken.token,
        assistedManifest.documents[0]!.id,
      );
      assert.equal(
        createHash("sha256").update(assistedXml).digest("hex"),
        assistedManifest.documents[0]!.sha256,
      );
      await assert.rejects(
        database
          .getPool()
          .query("UPDATE aruba_batch_documents SET filename = 'alterato.xml' WHERE batch_id = $1", [
            assistedBatchId,
          ]),
        /immutabile/,
      );
      await aruba.recordHelperEvent(assistedToken.token, {
        type: "HELPER_STARTED",
        browser: "chromium",
      });
      await aruba.recordHelperEvent(assistedToken.token, {
        type: "VALIDATION",
        documents: [{ id: assistedManifest.documents[0]!.id, status: "VALID" }],
      });
      await aruba.recordHelperEvent(assistedToken.token, { type: "ASSISTED_STOP" });
      await assert.rejects(
        aruba.consumeArubaPermit(assistedToken.token, assistedManifest.manifestSha256),
        (error) => error instanceof AppError && error.code === "ARUBA_PERMIT_INVALID",
      );
      await aruba.importOfficialArubaFile(
        assistedManifest.documents[0]!.id,
        "ARUBA_XML",
        assistedXml,
        owner,
      );
      await aruba.importOfficialArubaFile(
        assistedManifest.documents[0]!.id,
        "ARUBA_PDF",
        Buffer.from("%PDF-1.7\n% file sintetico"),
        owner,
      );
      await aruba.importOfficialArubaFile(
        assistedManifest.documents[0]!.id,
        "ARUBA_P7M",
        Buffer.from("0file-p7m-sintetico"),
        owner,
      );
      await aruba.importOfficialArubaFile(
        assistedManifest.documents[0]!.id,
        "SDI_NOTIFICATION",
        Buffer.from('<?xml version="1.0"?><RicevutaConsegna></RicevutaConsegna>'),
        owner,
      );
      await aruba.importOfficialArubaFile(
        assistedManifest.documents[0]!.id,
        "SDI_NOTIFICATION",
        Buffer.from('<?xml version="1.0"?><NotificaScarto></NotificaScarto>'),
        owner,
      );
      assert.equal(
        (
          await database
            .getPool()
            .query("SELECT status FROM aruba_submissions WHERE batch_id = $1", [assistedBatchId])
        ).rows[0].status,
        "DELIVERED",
      );

      const invalidToken = await aruba.issueHelperToken(invalidBatchId, owner);
      const invalidManifest = await aruba.helperManifest(invalidToken.token);
      await aruba.recordHelperEvent(invalidToken.token, {
        type: "VALIDATION",
        documents: [
          {
            id: invalidManifest.documents[0]!.id,
            status: "INVALID",
            message: "Errore sintetico",
          },
        ],
      });
      await aruba.recordHelperEvent(invalidToken.token, {
        type: "READBACK",
        documents: [{ id: invalidManifest.documents[0]!.id, status: "REMOVED" }],
      });
      await assert.rejects(
        aruba.issueHelperToken(invalidBatchId, owner),
        (error) => error instanceof AppError && error.code === "ARUBA_BATCH_INVALID",
      );
      const retryBatchId = await aruba.retryArubaBatch(invalidBatchId, owner);
      const retryToken = await aruba.issueHelperToken(retryBatchId, owner);
      assert.equal((await aruba.helperManifest(retryToken.token)).attemptNumber, 2);
      await aruba.recordHelperEvent(retryToken.token, {
        type: "RECONCILIATION_REQUIRED",
        reason: "UNKNOWN_RESULT",
      });
      assert.equal((await aruba.helperManifest(retryToken.token)).operation, "READBACK");
      await assert.rejects(
        aruba.consumeArubaPermit(
          retryToken.token,
          (await aruba.helperManifest(retryToken.token)).manifestSha256,
        ),
        (error) => error instanceof AppError && error.code === "ARUBA_PERMIT_INVALID",
      );
      await aruba.recordHelperEvent(retryToken.token, {
        type: "READBACK",
        documents: [{ id: invalidManifest.documents[0]!.id, status: "NOT_FOUND" }],
      });
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
            confirmApproval: true,
            confirmPending: false,
            confirmDifference: false,
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
      await aruba.setArubaSettings(
        {
          mode: "AUTOMATIC",
          modeVersion: arubaSettings.mode.version,
          authProtection: "TWO_FACTOR",
          authVersion: arubaSettings.authProtection.version,
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
          ),
          { approved: 1, failed: 0, storagePending: 1 },
        );
      } finally {
        await chmod(finalStorageDirectory, 0o700);
      }
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
        const xml = await documents.readDocumentXml(row.id);
        assert.ok(xml?.includes(Buffer.from("<RegimeFiscale>RF14</RegimeFiscale>")));
      }
      const automaticBatch = (await aruba.listArubaBatches()).find(
        (batch) => batch.mode === "AUTOMATIC",
      );
      assert.ok(automaticBatch);
      const automaticToken = await aruba.issueHelperToken(automaticBatch.id, owner);
      const automaticManifest = await aruba.helperManifest(automaticToken.token);
      assert.equal(automaticManifest.operation, "UPLOAD");
      await aruba.recordHelperEvent(automaticToken.token, {
        type: "VALIDATION",
        documents: automaticManifest.documents.map((document) => ({
          id: document.id,
          status: "VALID",
        })),
      });
      await assert.rejects(
        aruba.consumeArubaPermit(automaticToken.token, "0".repeat(64)),
        (error) => error instanceof AppError && error.code === "ARUBA_PERMIT_INVALID",
      );
      await aruba.consumeArubaPermit(automaticToken.token, automaticManifest.manifestSha256);
      await assert.rejects(
        aruba.consumeArubaPermit(automaticToken.token, automaticManifest.manifestSha256),
        (error) => error instanceof AppError && error.code === "ARUBA_PERMIT_INVALID",
      );
      const remoteIds = Object.fromEntries(
        automaticManifest.documents.map((document) => [document.id, "MOCK-AUTOMATIC-1"]),
      );
      await aruba.recordHelperEvent(automaticToken.token, { type: "SUBMITTED", remoteIds });
      await aruba.recordHelperEvent(automaticToken.token, {
        type: "READBACK",
        documents: automaticManifest.documents.map((document) => ({
          id: document.id,
          status: "SUBMITTED",
          remoteId: remoteIds[document.id],
        })),
      });
      const automaticReadbackToken = await aruba.issueHelperToken(automaticBatch.id, owner);
      assert.equal(
        (await aruba.helperManifest(automaticReadbackToken.token)).operation,
        "READBACK",
      );
      assert.equal(
        (
          await database
            .getPool()
            .query("SELECT count(*) FROM aruba_send_permits WHERE consumed_at IS NOT NULL")
        ).rows[0].count,
        "1",
      );
      await unlink(path.join(storage, rows[0]!.relative_path));
      assert.ok(
        (await documents.readDocumentXml(rows[0]!.id))?.includes(
          Buffer.from("<RegimeFiscale>RF14</RegimeFiscale>"),
        ),
      );
      await assert.rejects(
        database.getPool().query("UPDATE documents SET total_amount = total_amount + 1"),
        /immutabile/,
      );
      await assert.rejects(
        database
          .getPool()
          .query(
            "INSERT INTO users (username, password_hash, can_approve) VALUES ('codex', 'x', true)",
          ),
        /users_approval_identity_check/,
      );
      assert.equal(
        (
          await database
            .getPool()
            .query("SELECT count(*) FROM audit_events WHERE action = 'DOCUMENT_APPROVED'")
        ).rows[0].count,
        "3",
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
