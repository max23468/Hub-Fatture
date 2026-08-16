import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acceptedInvoiceFromXml, fiscalProfileFromAcceptedInvoiceXml } from "../documents.ts";
import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

test("una fattura Aruba storica senza document_lines resta apribile dallo snapshot immutabile", async () => {
  const fixture = await temporaryDatabase("aruba_history_projection");
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "hub-fatture-aruba-history-"));
  try {
    await runMigrations({ connectionString: fixture.connectionString });
    process.env.APP_ENV = "test";
    process.env.APP_BASE_URL = "http://localhost:8080";
    process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
    process.env.DATABASE_URL = fixture.connectionString;
    process.env.DOCUMENT_STORAGE_ROOT = storageRoot;

    const xml = await readFile("tests/fixtures/fatturapa/accepted-invoice.anonymized.xml", "utf8");
    const approvedAt = "2026-08-12T10:00:00Z";
    const profile = fiscalProfileFromAcceptedInvoiceXml(xml, approvedAt);
    const imported = acceptedInvoiceFromXml(xml, approvedAt);
    const sha256 = createHash("sha256").update(xml).digest("hex");
    const relativePath = "aruba/history/accepted-invoice.anonymized.xml";
    await mkdir(path.dirname(path.join(storageRoot, relativePath)), { recursive: true });
    await writeFile(path.join(storageRoot, relativePath), xml, { mode: 0o600 });

    const database = await import("./client.server.ts");
    await database.getPool().query(
      `INSERT INTO fiscal_profiles (version, status, profile_json)
       VALUES (1, 'MOCK', $1)`,
      [JSON.stringify(profile)],
    );
    const customer = await database.getPool().query<{ id: string }>(
      `INSERT INTO customers
        (kind, match_key, display_name, billing_address_json, source_confidence, review_required)
       VALUES ('PRIVATE_IT', 'history-projection', 'Mario Rossi', '{}', 'TAX_ID', false)
       RETURNING id`,
    );
    const billingCase = await database.getPool().query<{ id: string }>(
      `INSERT INTO billing_cases
        (customer_id, local_order_date, currency, status, customer_snapshot_json,
         fiscal_profile_version)
       VALUES ($1, $2, 'EUR', 'CLOSED', $3, 1) RETURNING id`,
      [customer.rows[0]!.id, imported.documentDate, JSON.stringify(imported.input.recipient)],
    );
    const storage = await database.getPool().query<{ id: string }>(
      `INSERT INTO storage_objects
        (kind, relative_path, sha256, size_bytes, content_type)
       VALUES ('ARUBA_XML', $1, $2, $3, 'application/xml') RETURNING id`,
      [relativePath, sha256, Buffer.byteLength(xml)],
    );
    const immutableSnapshot = {
      generatorVersion: 2,
      ...imported.input,
      sourceTotal: imported.totalAmount,
      total: imported.totalAmount,
      difference: 0,
      differenceReason: null,
    };
    const document = await database.getPool().query<{ id: string }>(
      `INSERT INTO documents
        (billing_case_id, kind, status, document_type, series, fiscal_year, fiscal_number,
         document_date, fiscal_profile_version, currency, total_amount, source_total_amount,
         difference_amount, projection_sha256, approved_at, xml_sha256,
         immutable_snapshot_json, fiscal_profile_snapshot_json, storage_object_id,
         payment_status, payment_method, recipient_snapshot_json, origin)
       VALUES ($1, 'INVOICE', 'APPROVED', 'TD01', $2, $3, $4, $5, 1, 'EUR',
         $6, $6, 0, $7, $8, $7, $9, $10, $11, $12, $13, $14, 'ARUBA_HISTORY')
       RETURNING id`,
      [
        billingCase.rows[0]!.id,
        profile.series,
        imported.year,
        imported.number,
        imported.documentDate,
        imported.totalAmount,
        sha256,
        approvedAt,
        JSON.stringify(immutableSnapshot),
        JSON.stringify(imported.profile),
        storage.rows[0]!.id,
        imported.input.paymentStatus,
        imported.input.paymentMethod,
        JSON.stringify(imported.input.recipient),
      ],
    );
    assert.equal(
      (
        await database.getPool().query<{ count: string }>(
          "SELECT count(*) FROM document_lines WHERE document_id = $1",
          [document.rows[0]!.id],
        )
      ).rows[0]!.count,
      "0",
    );

    const { getHistoricalInvoiceProjection } = await import(
      "./historical-invoice-projection.server.ts"
    );
    const projection = await getHistoricalInvoiceProjection(billingCase.rows[0]!.id);
    assert.ok(projection);
    assert.equal(projection.approved, true);
    assert.equal(projection.xml, xml);
    assert.equal(projection.projectionSha256, sha256);
    assert.deepEqual(projection.lines, imported.input.lines);
    assert.equal(projection.total, imported.totalAmount);
  } finally {
    await import("./client.server.ts").then(({ closePool }) => closePool());
    await rm(storageRoot, { recursive: true, force: true });
    await fixture.drop();
  }
});
