import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
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
      const orders = await import("./orders.server.ts");
      const database = await import("./client.server.ts");
      const fixture = JSON.parse(
        await readFile("tests/fixtures/orders/normalized.mock.json", "utf8"),
      );
      const syntheticFiscalProfile = fiscalProfileSchema.parse(profileFixture);
      const first = structuredClone(fixture[0]);
      const second = structuredClone(fixture[0]);
      const third = structuredClone(fixture[0]);
      second.externalOrderId = "shop-order-documents-second";
      second.displayNumber = "#DOC-2";
      second.createdAt = "2026-08-11T08:00:00Z";
      second.updatedAt = "2026-08-11T09:00:00Z";
      third.externalOrderId = "shop-order-documents-third";
      third.displayNumber = "#DOC-3";
      third.createdAt = "2026-08-12T08:00:00Z";
      third.updatedAt = "2026-08-12T09:00:00Z";
      await orders.importOrders([first, second, third], {
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
            numbering: { ...syntheticFiscalProfile.numbering, lastObservedNumber: 0 },
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
      const [firstProjection, secondProjection, thirdProjection] = await Promise.all(
        cases.map((billingCase) => save(billingCase.id)),
      );
      assert.equal((await documents.listMassApprovalCandidates()).length, 3);
      await assert.rejects(
        documents.approveInvoice(
          cases[0]!.id,
          {
            caseRevision: firstProjection.caseRevision,
            draftVersion: firstProjection.draftVersion,
            projectionSha256: firstProjection.projectionSha256,
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
            caseRevision: firstProjection.caseRevision,
            draftVersion: firstProjection.draftVersion,
            projectionSha256: "0".repeat(64),
            confirmPending: false,
            confirmDifference: false,
          },
          { id: 1, canApprove: true, requestId: "stale" },
        ),
        (error) => error instanceof AppError && error.code === "DOCUMENT_PROJECTION_STALE",
      );
      const approved = await Promise.all(
        [firstProjection, secondProjection].map((projection, index) =>
          documents.approveInvoice(
            cases[index]!.id,
            {
              caseRevision: projection.caseRevision,
              draftVersion: projection.draftVersion,
              projectionSha256: projection.projectionSha256,
              confirmPending: false,
              confirmDifference: false,
            },
            { id: 1, canApprove: true, requestId: `approve-${index}` },
          ),
        ),
      );
      assert.deepEqual(approved.map((document) => document!.fiscalNumber).sort(), [
        "FPR 0002/26",
        "FPR 0003/26",
      ]);
      assert.equal(thirdProjection.difference, 0);
      const approvalToken = (caseId: string, projection: typeof thirdProjection) =>
        `${caseId}:${projection.caseRevision}:${projection.draftVersion}:${projection.projectionSha256}`;
      await documents.saveInvoiceDraft(
        cases[2]!.id,
        {
          caseRevision: thirdProjection.caseRevision,
          draftVersion: thirdProjection.draftVersion,
          differenceReason: "",
          lines: thirdProjection.lines,
        },
        { id: 1, canApprove: true, requestId: "save-third-again" },
      );
      assert.deepEqual(
        await documents.approveInvoices([approvalToken(cases[2]!.id, thirdProjection)], {
          id: 1,
          canApprove: true,
          requestId: "approve-mass-stale",
        }),
        { approved: 0, failed: 1 },
      );
      const freshThirdProjection = await documents.getInvoiceProjection(cases[2]!.id);
      assert.ok(
        freshThirdProjection &&
          !freshThirdProjection.profileMissing &&
          "lines" in freshThirdProjection,
      );
      assert.deepEqual(
        await documents.approveInvoices([approvalToken(cases[2]!.id, freshThirdProjection)], {
          id: 1,
          canApprove: true,
          requestId: "approve-mass",
        }),
        { approved: 1, failed: 0 },
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
        const xml = await documents.readDocumentXml(row.id);
        assert.ok(xml?.includes(Buffer.from("<RegimeFiscale>RF14</RegimeFiscale>")));
      }
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
      await database.closePool();
    } finally {
      await import("./client.server.ts").then(({ closePool }) => closePool());
      await databaseFixture.drop();
      await rm(storage, { recursive: true });
    }
  },
);
