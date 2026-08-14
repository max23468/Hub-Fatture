import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";
import {
  acceptedInvoiceFromXml,
  fiscalProfileFromAcceptedInvoiceXml,
  generateFatturaXml,
} from "../documents.ts";
import { remoteInventoryDocumentSchema, remoteMetadataDigest } from "../aruba-inbound.ts";

test("l’inventario Aruba è completo, idempotente e non collega usando il solo totale", async () => {
  const fixture = await temporaryDatabase("aruba_inbound");
  const storage = await mkdtemp(path.join(os.tmpdir(), "hub-fatture-aruba-inbound-"));
  try {
    await runMigrations({ connectionString: fixture.connectionString });
    process.env.APP_ENV = "test";
    process.env.APP_BASE_URL = "http://localhost:8080";
    process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
    process.env.DATABASE_URL = fixture.connectionString;
    process.env.DOCUMENT_STORAGE_ROOT = storage;
    const database = await import("./client.server.ts");
    const inbound = await import("./aruba-inbound.server.ts");
    const invoiceXml = await readFile(
      "tests/fixtures/fatturapa/accepted-invoice.anonymized.xml",
      "utf8",
    );
    const profile = fiscalProfileFromAcceptedInvoiceXml(invoiceXml, "2026-08-12T10:00:00Z");
    const accepted = acceptedInvoiceFromXml(invoiceXml, "2026-08-12T10:00:00Z");
    await database.getPool().query(
      `INSERT INTO fiscal_profiles (version, status, profile_json)
       VALUES (1, 'MOCK', $1)`,
      [JSON.stringify(profile)],
    );
    const user = await database
      .getPool()
      .query<{ id: string }>(
        "INSERT INTO users (username, password_hash, can_approve) VALUES ('Massimo', 'synthetic', true) RETURNING id",
      );
    const customer = await database.getPool().query<{ id: string }>(
      `INSERT INTO customers
        (kind, match_key, display_name, billing_address_json, source_confidence, review_required)
       VALUES ('PRIVATE_IT', 'aruba-inbound', 'Mario Rossi', '{}', 'TAX_ID', false)
       RETURNING id`,
    );
    const billingCase = await database.getPool().query<{ id: string }>(
      `INSERT INTO billing_cases
        (customer_id, local_order_date, currency, status, customer_snapshot_json)
       VALUES ($1, '2026-08-12', 'EUR', 'READY', '{}') RETURNING id`,
      [customer.rows[0]!.id],
    );
    const order = await database.getPool().query<{ id: string }>(
      `INSERT INTO orders
        (provider, external_account_id, external_order_id, display_number, created_at_source,
         updated_at_source, local_order_date, currency, gross_amount, payment_status,
         fulfillment_status, trigger_status, customer_id, billing_case_id,
         raw_snapshot_json, normalized_snapshot_json)
       VALUES ('SHOPIFY', 'shop', 'remote-order', '#1001', now(), now(), '2026-08-10',
         'EUR', 13000, 'PAID', 'FULFILLED', 'GROUPED', $1, $2, '{}',
         '{"customerSnapshot":{"billingAddress":{"line1":"Via Cliente 1","postalCode":"00100","city":"Roma","countryCode":"IT"}}}')
       RETURNING id`,
      [customer.rows[0]!.id, billingCase.rows[0]!.id],
    );
    await database.getPool().query(
      `INSERT INTO order_tax_identifiers
        (order_id, type, raw_value, normalized_value, source_field, country_code)
       VALUES ($1, 'CODICE_FISCALE', 'RSSMRA80A01H501U', 'RSSMRA80A01H501U', 'fixture', 'IT')`,
      [order.rows[0]!.id],
    );
    await database.getPool().query(
      `INSERT INTO refunds
        (provider, external_account_id, external_order_id, external_refund_id, order_id,
         status, amount, applied_before_issue, completed_at, raw_json)
       VALUES ('SHOPIFY', 'shop', 'remote-order', 'refund-before-issue', $1,
         'COMPLETED', 655, true, now(), '{}')`,
      [order.rows[0]!.id],
    );
    const residualOrder = await database.getPool().query<{ id: string }>(
      `INSERT INTO orders
        (provider, external_account_id, external_order_id, display_number, created_at_source,
         updated_at_source, local_order_date, currency, gross_amount, payment_status,
         fulfillment_status, trigger_status, customer_id, billing_case_id,
         raw_snapshot_json, normalized_snapshot_json)
       VALUES ('SHOPIFY', 'shop', 'residual-order', '#1002', now(), now(), '2026-08-12',
         'EUR', 5000, 'PAID', 'FULFILLED', 'GROUPED', $1, $2, '{}',
         '{"customerSnapshot":{"billingAddress":{"line1":"Via Cliente 1","postalCode":"00100","city":"Roma","countryCode":"IT"}}}')
       RETURNING id`,
      [customer.rows[0]!.id, billingCase.rows[0]!.id],
    );
    const draft = await database.getPool().query<{ id: string }>(
      `INSERT INTO documents
        (billing_case_id, kind, status, document_type, series, document_date,
         fiscal_profile_version, currency, total_amount, source_total_amount,
         difference_amount, projection_sha256, payment_status, payment_method,
         recipient_snapshot_json)
       VALUES ($1, 'INVOICE', 'DRAFT', 'TD01', 'FPR', '2026-08-12', 1, 'EUR',
         17345, 17345, 0, repeat('0', 64), 'PAID', 'MP08', $2) RETURNING id`,
      [billingCase.rows[0]!.id, JSON.stringify(accepted.input.recipient)],
    );
    await database.getPool().query(
      `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
       VALUES ($1, 'INVOICE', $2, 12345), ($1, 'INVOICE', $3, 5000)`,
      [draft.rows[0]!.id, order.rows[0]!.id, residualOrder.rows[0]!.id],
    );
    await database.getPool().query(
      `INSERT INTO document_lines
        (document_id, order_id, line_number, description, quantity, unit_amount,
         total_amount, tax_nature)
       VALUES ($1, $2, 1, 'Ordine Shopify #1001', 1, 12345, 12345, 'N5'),
              ($1, $3, 2, 'Ordine Shopify #1002', 1, 5000, 5000, 'N5')`,
      [draft.rows[0]!.id, order.rows[0]!.id, residualOrder.rows[0]!.id],
    );
    await database.getPool().query(
      `INSERT INTO billing_cases
        (customer_id, local_order_date, currency, status, customer_snapshot_json)
       SELECT $1, '2026-08-12'::date - value, 'EUR', 'READY', '{}'
       FROM generate_series(1, 5) AS value`,
      [customer.rows[0]!.id],
    );
    await database.getPool().query(
      `INSERT INTO orders
        (provider, external_account_id, external_order_id, display_number, created_at_source,
         updated_at_source, local_order_date, currency, gross_amount, payment_status,
         fulfillment_status, trigger_status, customer_id, raw_snapshot_json,
         normalized_snapshot_json)
       VALUES ('SHOPIFY', 'shop', 'pending', '#PENDING', now(), now(), '2026-08-12',
         'EUR', 1000, 'PENDING', 'UNFULFILLED', 'WAITING_FOR_TRIGGER', $1, '{}', '{}')`,
      [customer.rows[0]!.id],
    );
    const actor = {
      id: Number(user.rows[0]!.id),
      canApprove: true,
      requestId: "aruba-inbound-test",
    };
    assert.equal((await inbound.getArubaInventoryHealth()).status, "NEVER");
    assert.equal(
      (await database.getPool().query("SELECT count(*) FROM billing_cases WHERE status = 'READY'"))
        .rows[0].count,
      "6",
    );
    assert.equal(
      (
        await database
          .getPool()
          .query("SELECT count(*) FROM orders WHERE payment_status = 'PENDING'")
      ).rows[0].count,
      "1",
    );
    const session = await inbound.issueArubaReadSession("synthetic-device-0001", actor);
    const manifest = await inbound.arubaReadManifest(session.token);
    assert.equal(manifest.operation, "READ_SYNC");
    assert.ok(manifest.streams.some((stream) => stream.name === "invoices:2026"));
    const invoicePage = {
      stream: "invoices:2026",
      scanOrdinal: 1,
      pageOrdinal: 1,
      cursor: "invoice-end",
      terminal: true,
      fullScan: true,
      documents: [
        {
          remoteId: "REMOTE-001",
          documentType: "TD01",
          fiscalYear: 2026,
          series: "FPR",
          fiscalNumber: "1",
          documentDate: "2026-08-10",
          recipientName: "Mario Rossi",
          recipientTaxId: "RSSMRA80A01H501U",
          recipientCountryCode: "IT",
          recipientAddress: "Via Cliente 1 00100 Roma IT",
          totalAmount: 12345,
          currency: "EUR",
          status: "DELIVERED",
          providerObservedAt: "2026-08-12T12:00:00+02:00",
          xmlSha256: null,
          orderReferences: ["#1001"],
        },
      ],
    };
    const firstIngest = await inbound.ingestArubaInventoryPage(session.token, invoicePage);
    assert.equal(firstIngest.repeated, false);
    assert.equal(firstIngest.documents, 1);
    assert.ok(firstIngest.requestedFiles?.some((file) => file.kind === "ARUBA_XML"));
    const repeatedInvoicePage = await inbound.ingestArubaInventoryPage(session.token, invoicePage);
    assert.equal(repeatedInvoicePage.repeated, true);
    assert.equal(repeatedInvoicePage.documents, 1);
    assert.ok(repeatedInvoicePage.requestedFiles.some((file) => file.kind === "ARUBA_XML"));
    await assert.rejects(
      inbound.importArubaRemoteOfficialFile(
        session.token,
        "REMOTE-001",
        "SDI_NOTIFICATION",
        Buffer.from(
          "<RicevutaConsegna><NomeFile>altro.xml</NomeFile><IdentificativoSdI>REMOTE-OTHER</IdentificativoSdI></RicevutaConsegna>",
        ),
      ),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "ARUBA_INVENTORY_CONFLICT",
    );
    await database.getPool().query(
      `UPDATE aruba_remote_documents SET remote_id = 'historical-document-synthetic',
         metadata_digest = repeat('a', 64)
       WHERE remote_id = 'REMOTE-001'`,
    );
    await inbound.ingestArubaInventoryPage(session.token, {
      ...invoicePage,
      scanOrdinal: 8,
      cursor: "adopted-history",
    });
    await inbound.ingestArubaInventoryPage(session.token, {
      ...invoicePage,
      scanOrdinal: 9,
      cursor: "adopted-history-repeat",
    });
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT remote.remote_id, matches.status,
                  remote.metadata_digest = $1 AS digest_matches
           FROM aruba_remote_documents remote
           JOIN aruba_document_matches matches ON matches.remote_document_id = remote.id
           WHERE remote.remote_id = 'REMOTE-001'`,
          [remoteMetadataDigest(remoteInventoryDocumentSchema.parse(invoicePage.documents[0]))],
        )
      ).rows[0],
      { remote_id: "REMOTE-001", status: "MATCHED", digest_matches: true },
    );
    const importedInvoice = await inbound.importArubaRemoteOfficialFile(
      session.token,
      "REMOTE-001",
      "ARUBA_XML",
      Buffer.from(invoiceXml),
    );
    assert.ok(importedInvoice.documentId);
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT documents.origin, orders.trigger_status, orders.billing_case_id
           FROM documents JOIN document_orders ON document_orders.document_id = documents.id
           JOIN orders ON orders.id = document_orders.order_id
           WHERE documents.id = $1`,
          [importedInvoice.documentId],
        )
      ).rows[0],
      { origin: "ARUBA_HISTORY", trigger_status: "INVOICED", billing_case_id: null },
    );
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT document_orders.order_id, document_orders.amount, documents.total_amount,
                  documents.draft_version
           FROM documents JOIN document_orders ON document_orders.document_id = documents.id
           WHERE documents.id = $1`,
          [draft.rows[0]!.id],
        )
      ).rows,
      [
        {
          order_id: residualOrder.rows[0]!.id,
          amount: 5000,
          total_amount: 5000,
          draft_version: 2,
        },
      ],
    );
    await inbound.ingestArubaInventoryPage(session.token, {
      ...invoicePage,
      scanOrdinal: 10,
      cursor: "second-invoice-for-order",
      documents: [
        {
          ...invoicePage.documents[0],
          remoteId: "REMOTE-SECOND-INVOICE",
          fiscalNumber: "2",
        },
      ],
    });
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT matches.status, matches.method, matches.document_id
           FROM aruba_remote_documents remote
           JOIN aruba_document_matches matches ON matches.remote_document_id = remote.id
           WHERE remote.remote_id = 'REMOTE-SECOND-INVOICE'`,
        )
      ).rows[0],
      { status: "PROFILE_CONFLICT", method: "NONE", document_id: null },
    );
    await database
      .getPool()
      .query("DELETE FROM aruba_remote_documents WHERE remote_id = 'REMOTE-SECOND-INVOICE'");
    const refund = await database.getPool().query<{ id: string }>(
      `INSERT INTO refunds
        (provider, external_account_id, external_order_id, external_refund_id, order_id,
         status, amount, completed_at, raw_json)
       VALUES ('SHOPIFY', 'shop', 'remote-order', 'refund-001', $1,
         'COMPLETED', 2345, '2026-08-11T09:00:00Z', '{}') RETURNING id`,
      [order.rows[0]!.id],
    );
    const unrelatedRefund = await database.getPool().query<{ id: string }>(
      `INSERT INTO refunds
        (provider, external_account_id, external_order_id, external_refund_id, order_id,
         status, amount, completed_at, raw_json)
       VALUES ('SHOPIFY', 'shop', 'remote-order', 'refund-002', $1,
         'COMPLETED', 1000, '2026-08-11T09:00:00Z', '{}') RETURNING id`,
      [order.rows[0]!.id],
    );
    await database.getPool().query(
      `INSERT INTO refunds
        (provider, external_account_id, external_order_id, external_refund_id, order_id,
         status, amount, completed_at, raw_json)
       VALUES ('SHOPIFY', 'shop', 'remote-order', 'refund-future-unrelated', $1,
         'COMPLETED', 500, '2026-10-01T09:00:00Z', '{}')`,
      [order.rows[0]!.id],
    );
    const assignedCreditDraftId = await database.withTransaction(async (client) => {
      const assignedCreditDraft = await client.query<{ id: string }>(
        `INSERT INTO documents
        (billing_case_id, kind, status, document_type, series, document_date,
         fiscal_profile_version, currency, total_amount, source_total_amount,
         difference_amount, draft_version, projection_sha256, payment_status,
         payment_method, recipient_snapshot_json)
       SELECT billing_case_id, 'CREDIT_NOTE', 'DRAFT', 'TD04', series, '2026-08-11',
         fiscal_profile_version, 'EUR', 2345, 2345, 0, 1, repeat('d', 64), 'PAID',
         'MP05', recipient_snapshot_json
       FROM documents WHERE id = $1 RETURNING id`,
        [importedInvoice.documentId],
      );
      await client.query(
        `INSERT INTO document_links (document_id, related_document_id, relation_type)
       VALUES ($1, $2, 'CREDIT_NOTE_FOR_INVOICE')`,
        [assignedCreditDraft.rows[0]!.id, importedInvoice.documentId],
      );
      await client.query(
        `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
         VALUES ($1, 'CREDIT_NOTE', $2, 2345)`,
        [assignedCreditDraft.rows[0]!.id, order.rows[0]!.id],
      );
      await client.query(`UPDATE refunds SET credit_document_id = $1 WHERE id = $2`, [
        assignedCreditDraft.rows[0]!.id,
        refund.rows[0]!.id,
      ]);
      return assignedCreditDraft.rows[0]!.id;
    });
    assert.deepEqual(
      inbound.uniqueRefundSubset(
        [
          { id: "a", amount: 100 },
          { id: "b", amount: 100 },
          { id: "c", amount: 300 },
          { id: "d", amount: 200 },
        ],
        300,
      ),
      { status: "AMBIGUOUS" },
    );
    assert.deepEqual(
      inbound.uniqueRefundSubset(
        [
          { id: "a", amount: 100 },
          { id: "b", amount: 200 },
        ],
        300,
      ),
      { status: "UNIQUE", ids: ["a", "b"] },
    );
    assert.deepEqual(inbound.uniqueRefundSubset([{ id: "a", amount: 100 }], 300), {
      status: "NONE",
    });
    const ambiguousRefund = await database.getPool().query<{ id: string }>(
      `INSERT INTO refunds
        (provider, external_account_id, external_order_id, external_refund_id, order_id,
         status, amount, completed_at, raw_json)
       VALUES ('SHOPIFY', 'shop', 'remote-order', 'refund-ambiguous-subset', $1,
         'COMPLETED', 1345, '2026-08-11T09:00:00Z', '{}') RETURNING id`,
      [order.rows[0]!.id],
    );
    await inbound.ingestArubaInventoryPage(session.token, {
      stream: "credit-notes:2026",
      scanOrdinal: 10,
      pageOrdinal: 1,
      cursor: "ambiguous-refund-subset",
      terminal: true,
      fullScan: false,
      documents: [
        {
          remoteId: "REMOTE-TD04-AMBIGUOUS-SUBSET",
          documentType: "TD04",
          fiscalYear: 2026,
          series: "FPR",
          fiscalNumber: "98",
          documentDate: "2026-08-11",
          recipientName: "Mario Rossi",
          recipientTaxId: "RSSMRA80A01H501U",
          recipientCountryCode: "IT",
          recipientAddress: "Via Cliente 1 00100 Roma IT",
          totalAmount: 2345,
          currency: "EUR",
          status: "DELIVERED",
          providerObservedAt: "2026-08-12T12:30:00+02:00",
          xmlSha256: null,
          orderReferences: ["#1001"],
        },
      ],
    });
    const ambiguousMatch = (
      await database.getPool().query(
        `SELECT matches.status, matches.signals_json, matches.candidates_json
           FROM aruba_document_matches AS matches
           JOIN aruba_remote_documents AS remote ON remote.id = matches.remote_document_id
           WHERE remote.remote_id = 'REMOTE-TD04-AMBIGUOUS-SUBSET'`,
      )
    ).rows[0];
    assert.equal(ambiguousMatch.status, "AMBIGUOUS", JSON.stringify(ambiguousMatch));
    await database
      .getPool()
      .query("DELETE FROM aruba_remote_documents WHERE remote_id = $1", [
        "REMOTE-TD04-AMBIGUOUS-SUBSET",
      ]);
    await database
      .getPool()
      .query("DELETE FROM refunds WHERE id = $1", [ambiguousRefund.rows[0]!.id]);
    const creditXml = generateFatturaXml(
      profile,
      {
        ...accepted.input,
        kind: "CREDIT_NOTE",
        documentDate: "2026-08-11",
        lines: [
          {
            orderId: order.rows[0]!.id,
            description: "Rimborso beni usati - Ordine Shopify #1001",
            quantity: 1,
            unitAmount: 2345,
          },
        ],
        paymentMethod: "MP05",
        relatedInvoice: { number: "FPR 0001/26", date: "2026-08-10" },
      },
      { year: 2026, number: 2 },
    );
    await inbound.ingestArubaInventoryPage(session.token, {
      stream: "credit-notes:2026",
      scanOrdinal: 1,
      pageOrdinal: 1,
      cursor: "credit-end",
      terminal: true,
      fullScan: true,
      documents: [
        {
          remoteId: "REMOTE-TD04-001",
          documentType: "TD04",
          fiscalYear: 2026,
          series: "FPR",
          fiscalNumber: "2",
          documentDate: "2026-08-11",
          recipientName: "Mario Rossi",
          recipientTaxId: "RSSMRA80A01H501U",
          recipientCountryCode: "IT",
          recipientAddress: "Via Cliente 1 00100 Roma IT",
          totalAmount: 2345,
          currency: "EUR",
          status: "DELIVERED",
          providerObservedAt: "2026-08-12T13:00:00+02:00",
          xmlSha256: null,
          orderReferences: ["#1001"],
        },
      ],
    });
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT matches.status, matches.order_id, matches.related_invoice_document_id
           FROM aruba_document_matches AS matches
           JOIN aruba_remote_documents AS remote ON remote.id = matches.remote_document_id
           WHERE remote.remote_id = 'REMOTE-TD04-001'`,
        )
      ).rows[0],
      {
        status: "MATCHED",
        order_id: order.rows[0]!.id,
        related_invoice_document_id: importedInvoice.documentId,
      },
    );
    assert.deepEqual(
      (await inbound.listRemoteDocuments({ attentionOnly: true }))
        .filter((remote) => remote.remote_id === "REMOTE-TD04-001")
        .map((remote) => ({ match: remote.match_status, hasXml: remote.has_xml })),
      [{ match: "MATCHED", hasXml: false }],
    );
    const [importedCredit, repeatedCredit] = await Promise.all([
      inbound.importArubaRemoteOfficialFile(
        session.token,
        "REMOTE-TD04-001",
        "ARUBA_XML",
        Buffer.from(creditXml),
      ),
      inbound.importArubaRemoteOfficialFile(
        session.token,
        "REMOTE-TD04-001",
        "ARUBA_XML",
        Buffer.from(creditXml),
      ),
    ]);
    assert.ok(importedCredit.documentId);
    assert.equal(importedCredit.documentId, assignedCreditDraftId);
    assert.equal(repeatedCredit.documentId, importedCredit.documentId);
    assert.equal(
      (
        await database
          .getPool()
          .query("SELECT credit_document_id FROM refunds WHERE id = $1", [refund.rows[0]!.id])
      ).rows[0].credit_document_id,
      importedCredit.documentId,
    );
    const submittedBatchId = "50000000-0000-4000-8000-000000000001";
    const submittedCredit = await database.getPool().query<{
      draft_version: number;
      xml_sha256: string;
    }>("SELECT draft_version, xml_sha256 FROM documents WHERE id = $1", [importedCredit.documentId]);
    await database.getPool().query(
      `INSERT INTO aruba_batches
        (id, environment, mode, account_reference, manifest_sha256, document_count,
         attempt_number, status, created_by)
       VALUES ($1, 'MOCK', 'ASSISTED', 'synthetic-aruba-account', repeat('7', 64), 1, 1,
         'SUBMITTED', $2)`,
      [submittedBatchId, actor.id],
    );
    await database.getPool().query(
      `INSERT INTO aruba_batch_documents
        (batch_id, document_id, position, document_revision, xml_sha256, filename)
       VALUES ($1, $2, 1, $3, $4, 'FPR-0002-26.xml')`,
      [
        submittedBatchId,
        importedCredit.documentId,
        submittedCredit.rows[0]!.draft_version,
        submittedCredit.rows[0]!.xml_sha256,
      ],
    );
    await database.getPool().query(
      `INSERT INTO aruba_submissions
        (batch_id, document_id, attempt_number, environment, mode, manifest_sha256,
         xml_sha256, remote_id, status)
       VALUES ($1, $2, 1, 'MOCK', 'ASSISTED', repeat('7', 64), $3,
         'REMOTE-TD04-001', 'DELIVERED')`,
      [submittedBatchId, importedCredit.documentId, submittedCredit.rows[0]!.xml_sha256],
    );
    await database.getPool().query(
      `UPDATE aruba_document_matches SET status = 'UNMATCHED', method = 'NONE',
         document_id = NULL, order_id = NULL, related_invoice_document_id = NULL,
         refund_ids = '{}'
       WHERE remote_document_id = (
         SELECT id FROM aruba_remote_documents WHERE remote_id = 'REMOTE-TD04-001'
       )`,
    );
    await inbound.ingestArubaInventoryPage(session.token, {
      stream: "credit-notes:2026",
      scanOrdinal: 11,
      pageOrdinal: 1,
      cursor: "submitted-credit-readback",
      terminal: true,
      fullScan: false,
      documents: [
        {
          remoteId: "REMOTE-TD04-001",
          documentType: "TD04",
          fiscalYear: 2026,
          series: "FPR",
          fiscalNumber: "2",
          documentDate: "2026-08-11",
          recipientName: "Mario Rossi",
          recipientTaxId: "RSSMRA80A01H501U",
          recipientCountryCode: "IT",
          recipientAddress: "Via Cliente 1 00100 Roma IT",
          totalAmount: 2345,
          currency: "EUR",
          status: "DELIVERED",
          providerObservedAt: "2026-08-12T13:00:00+02:00",
          xmlSha256: null,
          orderReferences: ["#1001"],
        },
      ],
    });
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT matches.status, matches.document_id, matches.refund_ids::text[]
           FROM aruba_document_matches AS matches
           JOIN aruba_remote_documents AS remote ON remote.id = matches.remote_document_id
           WHERE remote.remote_id = 'REMOTE-TD04-001'`,
        )
      ).rows[0],
      {
        status: "MATCHED",
        document_id: importedCredit.documentId,
        refund_ids: [refund.rows[0]!.id],
      },
    );
    assert.equal(
      (
        await database
          .getPool()
          .query("SELECT credit_document_id FROM refunds WHERE id = $1", [
            unrelatedRefund.rows[0]!.id,
          ])
      ).rows[0].credit_document_id,
      null,
    );
    const cumulativeOrders = await database.getPool().query<{ id: string }>(
      `INSERT INTO orders
        (provider, external_account_id, external_order_id, display_number, created_at_source,
         updated_at_source, local_order_date, currency, gross_amount, payment_status,
         fulfillment_status, trigger_status, customer_id, raw_snapshot_json,
         normalized_snapshot_json)
       VALUES
         ('SHOPIFY', 'shop', 'cumulative-a', '#2001', now(), now(), '2025-01-01',
          'EUR', 1500, 'PAID', 'FULFILLED', 'INVOICED', $1, '{}',
          '{"customerSnapshot":{"billingAddress":{"line1":"Via Cliente 1","postalCode":"00100","city":"Roma","countryCode":"IT"}}}'),
         ('EBAY', 'ebay', 'cumulative-b', '#2002', now(), now(), '2025-01-01',
          'EUR', 1500, 'PAID', 'FULFILLED', 'INVOICED', $1, '{}',
          '{"customerSnapshot":{"billingAddress":{"line1":"Via Cliente 1","postalCode":"00100","city":"Roma","countryCode":"IT"}}}')
       RETURNING id`,
      [customer.rows[0]!.id],
    );
    await database.getPool().query(
      `INSERT INTO order_tax_identifiers
        (order_id, type, raw_value, normalized_value, source_field, country_code)
       SELECT unnest($1::bigint[]), 'CODICE_FISCALE', 'RSSMRA80A01H501U',
              'RSSMRA80A01H501U', 'fixture', 'IT'`,
      [cumulativeOrders.rows.map((item) => item.id)],
    );
    const cumulativeCase = await database.getPool().query<{ id: string }>(
      `INSERT INTO billing_cases
        (customer_id, local_order_date, currency, status, customer_snapshot_json,
         fiscal_profile_version)
       VALUES ($1, '2026-08-12', 'EUR', 'CLOSED', '{}', 1) RETURNING id`,
      [customer.rows[0]!.id],
    );
    const cumulativeInvoice = await database.getPool().query<{ id: string }>(
      `INSERT INTO documents
        (billing_case_id, kind, status, document_type, series, document_date,
         fiscal_profile_version, currency, total_amount, source_total_amount,
         difference_amount, draft_version, projection_sha256, payment_status,
         payment_method, recipient_snapshot_json)
       SELECT $2, 'INVOICE', 'DRAFT', 'TD01', series, '2026-08-10',
         fiscal_profile_version, 'EUR', 3000, 3000, 0, 1, repeat('e', 64), 'PAID',
         payment_method, recipient_snapshot_json
       FROM documents WHERE id = $1 RETURNING id`,
      [importedInvoice.documentId, cumulativeCase.rows[0]!.id],
    );
    await database.getPool().query(
      `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
       VALUES ($1, 'INVOICE', $2, 1500), ($1, 'INVOICE', $3, 1500)`,
      [cumulativeInvoice.rows[0]!.id, cumulativeOrders.rows[0]!.id, cumulativeOrders.rows[1]!.id],
    );
    await database.getPool().query(
      `UPDATE documents AS target SET status = 'APPROVED', fiscal_year = 2026,
         fiscal_number = 10, approved_at = now(), xml_sha256 = repeat('e', 64),
         immutable_snapshot_json = source.immutable_snapshot_json,
         fiscal_profile_snapshot_json = source.fiscal_profile_snapshot_json,
         storage_object_id = source.storage_object_id, origin = 'ARUBA_HISTORY'
       FROM documents AS source WHERE target.id = $1 AND source.id = $2`,
      [cumulativeInvoice.rows[0]!.id, importedInvoice.documentId],
    );
    const cumulativeRefunds = await database.getPool().query<{ id: string }>(
      `INSERT INTO refunds
        (provider, external_account_id, external_order_id, external_refund_id, order_id,
         status, amount, completed_at, raw_json)
       VALUES
         ('SHOPIFY', 'shop', 'cumulative-a', 'cumulative-refund-a', $1,
          'COMPLETED', 700, '2026-08-11T09:00:00Z', '{}'),
         ('EBAY', 'ebay', 'cumulative-b', 'cumulative-refund-b', $2,
          'COMPLETED', 800, '2026-08-11T09:00:00Z', '{}')
       RETURNING id`,
      [cumulativeOrders.rows[0]!.id, cumulativeOrders.rows[1]!.id],
    );
    const cumulativeDraftId = await database.withTransaction(async (client) => {
      const cumulativeDraft = await client.query<{ id: string }>(
        `INSERT INTO documents
        (billing_case_id, kind, status, document_type, series, document_date,
         fiscal_profile_version, currency, total_amount, source_total_amount,
         difference_amount, draft_version, projection_sha256, payment_status,
         payment_method, recipient_snapshot_json)
       SELECT billing_case_id, 'CREDIT_NOTE', 'DRAFT', 'TD04', series, '2026-08-11',
         fiscal_profile_version, 'EUR', 1500, 1500, 0, 1, repeat('f', 64), 'PAID',
         'MP05', recipient_snapshot_json
       FROM documents WHERE id = $1 RETURNING id`,
        [cumulativeInvoice.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO document_links (document_id, related_document_id, relation_type)
       VALUES ($1, $2, 'CREDIT_NOTE_FOR_INVOICE')`,
        [cumulativeDraft.rows[0]!.id, cumulativeInvoice.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
       VALUES ($1, 'CREDIT_NOTE', $2, 700), ($1, 'CREDIT_NOTE', $3, 800)`,
        [cumulativeDraft.rows[0]!.id, cumulativeOrders.rows[0]!.id, cumulativeOrders.rows[1]!.id],
      );
      await client.query(
        `UPDATE refunds SET credit_document_id = $1
       WHERE id = ANY($2::bigint[])`,
        [cumulativeDraft.rows[0]!.id, cumulativeRefunds.rows.map((refund) => refund.id)],
      );
      return cumulativeDraft.rows[0]!.id;
    });
    const cumulativeCreditXml = generateFatturaXml(
      profile,
      {
        ...accepted.input,
        kind: "CREDIT_NOTE",
        documentDate: "2026-08-11",
        lines: [
          {
            orderId: cumulativeOrders.rows[0]!.id,
            description: "Rimborso ordine Shopify #2001",
            quantity: 1,
            unitAmount: 700,
          },
          {
            orderId: cumulativeOrders.rows[1]!.id,
            description: "Rimborso ordine eBay #2002",
            quantity: 1,
            unitAmount: 800,
          },
        ],
        paymentMethod: "MP05",
        relatedInvoice: { number: "FPR 0010/26", date: "2026-08-10" },
      },
      { year: 2026, number: 11 },
    );
    await inbound.ingestArubaInventoryPage(session.token, {
      stream: "credit-notes:2026",
      scanOrdinal: 2,
      pageOrdinal: 1,
      cursor: "cumulative-credit-end",
      terminal: true,
      fullScan: true,
      documents: [
        {
          remoteId: "REMOTE-TD04-CUMULATIVE",
          documentType: "TD04",
          fiscalYear: 2026,
          series: "FPR",
          fiscalNumber: "11",
          documentDate: "2026-08-11",
          recipientName: "Mario Rossi",
          recipientTaxId: "RSSMRA80A01H501U",
          recipientCountryCode: "IT",
          recipientAddress: "Via Cliente 1 00100 Roma IT",
          totalAmount: 1500,
          currency: "EUR",
          status: "DELIVERED",
          providerObservedAt: "2026-08-12T13:30:00+02:00",
          xmlSha256: null,
          orderReferences: ["#2001", "#2002"],
        },
      ],
    });
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT matches.status, matches.order_id, matches.related_invoice_document_id,
                  matches.refund_ids::text[]
           FROM aruba_document_matches AS matches
           JOIN aruba_remote_documents AS remote ON remote.id = matches.remote_document_id
           WHERE remote.remote_id = 'REMOTE-TD04-CUMULATIVE'`,
        )
      ).rows[0],
      {
        status: "MATCHED",
        order_id: cumulativeOrders.rows[0]!.id,
        related_invoice_document_id: cumulativeInvoice.rows[0]!.id,
        refund_ids: cumulativeRefunds.rows.map((refund) => refund.id),
      },
    );
    const cumulativeCredit = await inbound.importArubaRemoteOfficialFile(
      session.token,
      "REMOTE-TD04-CUMULATIVE",
      "ARUBA_XML",
      Buffer.from(cumulativeCreditXml),
    );
    assert.equal(cumulativeCredit.documentId, cumulativeDraftId);
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT DISTINCT credit_document_id FROM refunds
           WHERE id = ANY($1::bigint[])`,
          [cumulativeRefunds.rows.map((refund) => refund.id)],
        )
      ).rows,
      [{ credit_document_id: cumulativeDraftId }],
    );
    const rejectedXml = generateFatturaXml(
      profile,
      {
        ...accepted.input,
        documentDate: "2026-08-12",
        lines: [
          {
            orderId: residualOrder.rows[0]!.id,
            description: "Ordine Shopify #1002",
            quantity: 1,
            unitAmount: 5000,
          },
        ],
      },
      { year: 2026, number: 3 },
    );
    await inbound.ingestArubaInventoryPage(session.token, {
      stream: "invoices:2026",
      scanOrdinal: 2,
      pageOrdinal: 1,
      cursor: "rejected-end",
      terminal: true,
      fullScan: true,
      documents: [
        {
          remoteId: "REMOTE-REJECTED-001",
          documentType: "TD01",
          fiscalYear: 2026,
          series: "FPR",
          fiscalNumber: "3",
          documentDate: "2026-08-12",
          recipientName: "Mario Rossi",
          recipientTaxId: "RSSMRA80A01H501U",
          recipientCountryCode: "IT",
          recipientAddress: "Via Cliente 1 00100 Roma IT",
          totalAmount: 5000,
          currency: "EUR",
          status: "REJECTED",
          providerObservedAt: "2026-08-12T14:00:00+02:00",
          xmlSha256: null,
          orderReferences: ["#1002"],
        },
      ],
    });
    const documentCountBeforeRejectedImport = Number(
      (await database.getPool().query("SELECT count(*) FROM documents")).rows[0].count,
    );
    const rejectedImport = await inbound.importArubaRemoteOfficialFile(
      session.token,
      "REMOTE-REJECTED-001",
      "ARUBA_XML",
      Buffer.from(rejectedXml),
    );
    assert.equal(rejectedImport.repeated, false);
    assert.equal(rejectedImport.documentId, null);
    assert.equal(
      Number((await database.getPool().query("SELECT count(*) FROM documents")).rows[0].count),
      documentCountBeforeRejectedImport,
    );
    await inbound.completeArubaInventory(
      session.token,
      ["invoices:2026", "credit-notes:2026"],
      1,
      true,
    );
    const health = await inbound.getArubaInventoryHealth();
    assert.equal(health.status, "HEALTHY");
    assert.equal(health.remoteDocuments, 4);
    const assignedCreditPreflight = await inbound.requestArubaPreflight(
      {
        documentId: assignedCreditDraftId,
        draftVersion: 1,
        projectionSha256: "d".repeat(64),
      },
      actor,
    );
    assert.deepEqual(
      (
        await database
          .getPool()
          .query<{ request_json: { refundIds: string[] } }>(
            "SELECT request_json FROM aruba_preflight_receipts WHERE id = $1",
            [assignedCreditPreflight.id],
          )
      ).rows[0]!.request_json.refundIds,
      [refund.rows[0]!.id],
    );
    await database
      .getPool()
      .query("DELETE FROM aruba_preflight_receipts WHERE id = $1", [assignedCreditPreflight.id]);
    const remotes = await inbound.listRemoteDocuments();
    const remoteCredit = remotes.find((remote) => remote.remote_id === "REMOTE-TD04-001");
    assert.equal(remoteCredit!.match_status, "MATCHED");
    assert.equal(remoteCredit!.order_id, order.rows[0]!.id);
    assert.equal(
      Number(
        (
          await database.getPool().query(
            `SELECT count(*) FROM sync_cursors
             WHERE provider = 'ARUBA' AND full_scan_completed_at IS NOT NULL`,
          )
        ).rows[0].count,
      ),
      2,
    );
    const fullTimestamp = (
      await database
        .getPool()
        .query<{ full_scan_completed_at: Date }>(
          `SELECT full_scan_completed_at FROM aruba_sync_sessions WHERE id = $1`,
          [session.sessionId],
        )
    ).rows[0]!.full_scan_completed_at.toISOString();
    for (const stream of ["invoices:2026", "credit-notes:2026"]) {
      await inbound.ingestArubaInventoryPage(session.token, {
        stream,
        scanOrdinal: 3,
        pageOrdinal: 1,
        cursor: `${stream}:incremental-end`,
        terminal: true,
        fullScan: false,
        documents: [],
      });
    }
    await inbound.completeArubaInventory(
      session.token,
      ["invoices:2026", "credit-notes:2026"],
      3,
      false,
    );
    assert.equal(
      (
        await database
          .getPool()
          .query<{ full_scan_completed_at: Date }>(
            `SELECT full_scan_completed_at FROM aruba_sync_sessions WHERE id = $1`,
            [session.sessionId],
          )
      ).rows[0]!.full_scan_completed_at.toISOString(),
      fullTimestamp,
    );

    const secondSession = await assert.rejects(
      inbound.issueArubaReadSession("synthetic-device-0002", actor),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "ARUBA_READ_SESSION_ACTIVE",
    );
    assert.equal(secondSession, undefined);

    await assert.rejects(
      inbound.createArubaManualReadback({ ...actor, canApprove: false }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "ARUBA_READ_SESSION_FORBIDDEN",
    );

    const rejectedRemote = await database
      .getPool()
      .query<{ id: string }>(
        `SELECT id FROM aruba_remote_documents WHERE remote_id = 'REMOTE-REJECTED-001'`,
      );
    await database.getPool().query(
      `UPDATE aruba_document_matches SET status = 'AMBIGUOUS', method = 'NONE',
         order_id = NULL, candidates_json = $2
       WHERE remote_document_id = $1`,
      [
        rejectedRemote.rows[0]!.id,
        JSON.stringify([{ candidateId: residualOrder.rows[0]!.id, compatible: true }]),
      ],
    );
    await inbound.resolveArubaDocumentMatch(
      rejectedRemote.rows[0]!.id,
      residualOrder.rows[0]!.id,
      "Collegamento verificato con evidenza ufficiale",
      actor,
    );
    const matchAudit = await database.getPool().query<{
      actor_id: string;
      reason: string;
      after_json: { method: string; orderId: string };
    }>(
      `SELECT actor_id, reason, after_json FROM audit_events
       WHERE action = 'ARUBA_DOCUMENT_MATCH_RESOLVED' ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(matchAudit.rows[0]!.actor_id, String(actor.id));
    assert.equal(matchAudit.rows[0]!.after_json.method, "MANUAL");
    assert.equal(matchAudit.rows[0]!.after_json.orderId, residualOrder.rows[0]!.id);
    await assert.rejects(
      inbound.resolveArubaDocumentMatch("1", residualOrder.rows[0]!.id, "Motivo compatibile", {
        ...actor,
        canApprove: false,
      }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "ARUBA_READ_SESSION_FORBIDDEN",
    );

    const emptyManualReadback = await inbound.createArubaManualReadback(actor);
    const emptyCoveragePages = emptyManualReadback.coverage.streams.map(
      (stream: string, index: number) => ({
        stream,
        scanOrdinal: 1,
        pageOrdinal: 1,
        cursor: `manual-${index + 1}`,
        terminal: true,
        fullScan: true,
        documents: [],
      }),
    );
    assert.deepEqual(
      await inbound.addArubaManualReadbackPages(emptyManualReadback.id, emptyCoveragePages, actor),
      { pages: emptyCoveragePages.length, documents: 0 },
    );
    await assert.rejects(
      inbound.finalizeArubaManualReadback(emptyManualReadback.id, actor),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "ARUBA_INVENTORY_INCOMPLETE",
    );
    const manualReadback = await inbound.createArubaManualReadback(actor);
    const observedDocuments = await database
      .getPool()
      .query<{ document: (typeof invoicePage.documents)[number] }>(
        `SELECT DISTINCT ON (document ->> 'remoteId') document
       FROM aruba_sync_pages pages
       CROSS JOIN LATERAL jsonb_array_elements(pages.documents_json) document
       WHERE EXISTS (
         SELECT 1 FROM aruba_remote_documents remote
         WHERE remote.remote_id = document ->> 'remoteId'
       )
       ORDER BY document ->> 'remoteId', pages.committed_at DESC`,
      );
    const completeCoveragePages = manualReadback.coverage.streams.map(
      (stream: string, index: number) => {
        const [kind, year] = stream.split(":");
        return {
          stream,
          scanOrdinal: 1,
          pageOrdinal: 1,
          cursor: `manual-complete-${index + 1}`,
          terminal: true,
          fullScan: true,
          documents: observedDocuments.rows
            .map((row) => row.document)
            .filter(
              (document) =>
                document.fiscalYear === Number(year) &&
                document.documentType === (kind === "invoices" ? "TD01" : "TD04"),
            ),
        };
      },
    );
    await inbound.addArubaManualReadbackPages(manualReadback.id, completeCoveragePages, actor);
    await assert.rejects(
      inbound.finalizeArubaManualReadback(manualReadback.id, actor),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "ARUBA_READ_SESSION_ACTIVE",
    );

    const incompleteReadback = await inbound.createArubaManualReadback(actor);
    await inbound.addArubaManualReadbackPages(
      incompleteReadback.id,
      [emptyCoveragePages[0]],
      actor,
    );
    await assert.rejects(
      inbound.finalizeArubaManualReadback(incompleteReadback.id, actor),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "ARUBA_INVENTORY_INCOMPLETE",
    );
    const invalidReadback = await inbound.createArubaManualReadback(actor);
    await assert.rejects(
      inbound.addArubaManualReadbackPages(
        invalidReadback.id,
        [{ ...emptyCoveragePages[0], terminal: false }],
        actor,
      ),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "ARUBA_INVENTORY_INCOMPLETE",
    );
    await assert.rejects(
      inbound.addArubaManualReadbackPages(
        invalidReadback.id,
        [
          { ...emptyCoveragePages[0], documents: [invoicePage.documents[0]] },
          {
            ...emptyCoveragePages[1],
            documents: [invoicePage.documents[0]],
          },
        ],
        actor,
      ),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "ARUBA_INVENTORY_CONFLICT",
    );

    assert.equal(await inbound.revokeArubaReadSessions(actor), 1);
    await database.getPool().query(
      `INSERT INTO aruba_sync_sessions
        (id, environment, account_reference, device_id, token_hash, status,
         absolute_expires_at, requested_by, error_code)
       VALUES ('30000000-0000-4000-8000-000000000001', 'MOCK', 'synthetic-aruba-account',
         'failed-device-0001', repeat('f', 64), 'FAILED', now() + interval '5 minutes', $1,
         'SYNTHETIC_FAILURE')`,
      [actor.id],
    );
    await database.getPool().query(
      `INSERT INTO aruba_sync_sessions
        (id, environment, account_reference, device_id, token_hash, status,
         absolute_expires_at, lease_expires_at, requested_by)
       VALUES ('30000000-0000-4000-8000-000000000002', 'MOCK', 'synthetic-aruba-account',
         'stale-manual-device', repeat('d', 64), 'ACTIVE', now() + interval '1 hour',
         now() - interval '1 second', $1)`,
      [actor.id],
    );
    await database.getPool().query("UPDATE aruba_remote_documents SET remote_status = 'REJECTED'");
    await database
      .getPool()
      .query(`UPDATE aruba_document_matches SET status = 'AMBIGUOUS', method = 'NONE'`);
    assert.deepEqual(await inbound.finalizeArubaManualReadback(manualReadback.id, actor), {
      completed: true,
      repeated: false,
    });
    assert.equal(
      (
        await database
          .getPool()
          .query(
            "SELECT status FROM aruba_sync_sessions WHERE id = '30000000-0000-4000-8000-000000000002'",
          )
      ).rows[0].status,
      "EXPIRED",
    );
    assert.deepEqual(await inbound.finalizeArubaManualReadback(manualReadback.id, actor), {
      completed: true,
      repeated: true,
    });
    assert.equal(
      (
        await database
          .getPool()
          .query("SELECT status FROM aruba_sync_sessions WHERE token_hash = repeat('f', 64)")
      ).rows[0].status,
      "FAILED",
    );

    const currentDraft = await database.getPool().query<{
      id: string;
      billing_case_id: string;
      draft_version: number;
      projection_sha256: string;
    }>(
      `SELECT id, billing_case_id, draft_version, projection_sha256
       FROM documents WHERE id = $1`,
      [draft.rows[0]!.id],
    );
    const firstSyntheticReceipt = await inbound.ensureArubaPreflight(
      {
        billingCaseId: currentDraft.rows[0]!.billing_case_id,
        documentId: currentDraft.rows[0]!.id,
        draftVersion: currentDraft.rows[0]!.draft_version,
        projectionSha256: currentDraft.rows[0]!.projection_sha256,
      },
      actor,
    );
    await database
      .getPool()
      .query(
        "UPDATE aruba_preflight_receipts SET expires_at = now() - interval '1 second' WHERE id = $1",
        [firstSyntheticReceipt],
      );
    const renewedSyntheticReceipt = await inbound.ensureArubaPreflight(
      {
        billingCaseId: currentDraft.rows[0]!.billing_case_id,
        documentId: currentDraft.rows[0]!.id,
        draftVersion: currentDraft.rows[0]!.draft_version,
        projectionSha256: currentDraft.rows[0]!.projection_sha256,
      },
      actor,
    );
    assert.notEqual(renewedSyntheticReceipt, firstSyntheticReceipt);
    assert.deepEqual(
      (
        await database
          .getPool()
          .query(
            "SELECT status FROM aruba_preflight_receipts WHERE id = ANY($1::uuid[]) ORDER BY requested_at",
            [[firstSyntheticReceipt, renewedSyntheticReceipt]],
          )
      ).rows.map((row) => row.status),
      ["EXPIRED", "PASSED"],
    );
    await database
      .getPool()
      .query("DELETE FROM aruba_preflight_receipts WHERE id = ANY($1::uuid[])", [
        [firstSyntheticReceipt, renewedSyntheticReceipt],
      ]);
    const manualReceiptId = "40000000-0000-4000-8000-000000000001";
    await database.getPool().query(
      `INSERT INTO aruba_preflight_receipts
        (id, environment, account_reference, billing_case_id, document_id, draft_version,
         projection_sha256, manifest_sha256, inventory_watermark, requested_by, request_json)
       VALUES ($1, 'MOCK', 'synthetic-aruba-account', $2, $3, $4, $5, repeat('a', 64), 0, $6,
         jsonb_build_object(
           'documentType', 'TD01',
           'orderIds', ARRAY[$7::text],
           'searches', jsonb_build_array(jsonb_build_object('orderId', $7::text))
         ))`,
      [
        manualReceiptId,
        currentDraft.rows[0]!.billing_case_id,
        currentDraft.rows[0]!.id,
        currentDraft.rows[0]!.draft_version,
        currentDraft.rows[0]!.projection_sha256,
        actor.id,
        residualOrder.rows[0]!.id,
      ],
    );
    const specificReadback = await inbound.completeManualArubaPreflight(
      manualReceiptId,
      [
        {
          stream: "specific:1",
          scanOrdinal: 1,
          pageOrdinal: 1,
          cursor: "specific-end",
          terminal: true,
          fullScan: true,
          documents: [],
        },
      ],
      "Verifica manuale specifica completata senza candidati Aruba",
      actor,
    );
    assert.equal(specificReadback.passed, true);
    assert.deepEqual(
      (
        await database
          .getPool()
          .query(`SELECT status, source FROM aruba_preflight_receipts WHERE id = $1`, [
            manualReceiptId,
          ])
      ).rows[0],
      { status: "PASSED", source: "OWNER_OVERRIDE" },
    );

    const candidateReceiptId = "40000000-0000-4000-8000-000000000002";
    await database.getPool().query(
      `INSERT INTO aruba_preflight_receipts
        (id, environment, account_reference, billing_case_id, document_id, draft_version,
         projection_sha256, manifest_sha256, inventory_watermark, requested_by, request_json)
       VALUES ($1, 'MOCK', 'synthetic-aruba-account', $2, $3, $4::integer + 1, $5,
         repeat('c', 64), 0, $6,
         jsonb_build_object(
           'documentType', 'TD01',
           'orderIds', ARRAY[$7::text],
           'searches', jsonb_build_array(jsonb_build_object('orderId', $7::text))
         ))`,
      [
        candidateReceiptId,
        currentDraft.rows[0]!.billing_case_id,
        currentDraft.rows[0]!.id,
        currentDraft.rows[0]!.draft_version,
        currentDraft.rows[0]!.projection_sha256,
        actor.id,
        residualOrder.rows[0]!.id,
      ],
    );
    await database.getPool().query(
      `INSERT INTO aruba_sync_sessions
        (id, environment, account_reference, device_id, token_hash, status,
         absolute_expires_at, lease_expires_at, requested_by)
       VALUES ('30000000-0000-4000-8000-000000000003', 'MOCK', 'synthetic-aruba-account',
         'stale-specific-device', repeat('c', 64), 'SCANNING', now() + interval '1 hour',
         now() - interval '1 second', $1)`,
      [actor.id],
    );
    const candidateReadback = await inbound.completeManualArubaPreflight(
      candidateReceiptId,
      [
        {
          stream: "specific:1",
          scanOrdinal: 1,
          pageOrdinal: 1,
          cursor: "specific-candidate-end",
          terminal: true,
          fullScan: true,
          documents: [
            {
              ...invoicePage.documents[0],
              remoteId: "REMOTE-SPECIFIC-001",
              fiscalNumber: "99",
              recipientName: "Destinatario diverso",
              recipientTaxId: "RSSMRA80A01H501X",
              recipientAddress: "Via diversa 99 00100 Roma IT",
              orderReferences: [],
              status: "SUBMITTED",
            },
          ],
        },
      ],
      "Verifica manuale specifica con candidato Aruba acquisito",
      actor,
    );
    assert.equal(candidateReadback.passed, false);
    assert.equal(
      (
        await database
          .getPool()
          .query(
            "SELECT status FROM aruba_sync_sessions WHERE id = '30000000-0000-4000-8000-000000000003'",
          )
      ).rows[0].status,
      "EXPIRED",
    );
    assert.equal(
      (
        await database
          .getPool()
          .query("SELECT count(*) FROM aruba_remote_documents WHERE remote_id = $1", [
            "REMOTE-SPECIFIC-001",
          ])
      ).rows[0].count,
      "1",
    );

    const inventoryLock = await database.getPool().connect();
    await database.getPool().query(
      `UPDATE aruba_preflight_receipts SET inventory_watermark =
         (SELECT coalesce(max(inventory_watermark), 0) FROM aruba_sync_sessions)
       WHERE id = $1`,
      [manualReceiptId],
    );
    await inventoryLock.query("BEGIN");
    await inventoryLock.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "aruba-read:MOCK:synthetic-aruba-account",
    ]);
    let consumeSettled = false;
    const serializedConsume = database
      .withTransaction((client) =>
        inbound.consumeArubaPreflight(client, manualReceiptId, {
          billingCaseId: currentDraft.rows[0]!.billing_case_id,
          documentId: currentDraft.rows[0]!.id,
          draftVersion: currentDraft.rows[0]!.draft_version,
          projectionSha256: currentDraft.rows[0]!.projection_sha256,
        }),
      )
      .finally(() => {
        consumeSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(consumeSettled, false);
    await inventoryLock.query("COMMIT");
    inventoryLock.release();
    await serializedConsume;
    await database.getPool().query(
      `UPDATE aruba_preflight_receipts SET status = 'PASSED', consumed_at = NULL
       WHERE id = $1`,
      [manualReceiptId],
    );

    await database.getPool().query(
      `UPDATE aruba_sync_sessions SET inventory_watermark = 999999
       WHERE id = (SELECT id FROM aruba_sync_sessions ORDER BY started_at DESC LIMIT 1)`,
    );
    await assert.rejects(
      database.withTransaction((client) =>
        inbound.consumeArubaPreflight(client, manualReceiptId, {
          billingCaseId: currentDraft.rows[0]!.billing_case_id,
          documentId: currentDraft.rows[0]!.id,
          draftVersion: currentDraft.rows[0]!.draft_version,
          projectionSha256: currentDraft.rows[0]!.projection_sha256,
        }),
      ),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "ARUBA_PREFLIGHT_REQUIRED",
    );
    await database
      .getPool()
      .query("DELETE FROM aruba_preflight_receipts WHERE id = $1", [manualReceiptId]);

    await database.getPool().query(
      `INSERT INTO aruba_sync_sessions
        (id, environment, account_reference, device_id, token_hash, status,
         absolute_expires_at, lease_expires_at, requested_by)
       VALUES ('50000000-0000-4000-8000-000000000001', 'MOCK', 'synthetic-aruba-account',
         'expired-device-0001', repeat('e', 64), 'ACTIVE', now() + interval '1 hour',
         now() - interval '1 second', $1)`,
      [actor.id],
    );
    const interruptedPage = {
      ...invoicePage,
      scanOrdinal: 1,
      pageOrdinal: 1,
      cursor: "resume-page-1",
      terminal: false,
    };
    await database.getPool().query(
      `INSERT INTO aruba_sync_pages
        (sync_session_id, stream, scan_ordinal, page_ordinal, cursor, terminal,
         full_scan, row_count, documents_json, payload_digest)
       VALUES ('50000000-0000-4000-8000-000000000001', 'invoices:2026', 1, 1,
         'resume-page-1', false, true, $1, $2, $3)`,
      [
        interruptedPage.documents.length,
        JSON.stringify(interruptedPage.documents),
        createHash("sha256").update(JSON.stringify(interruptedPage)).digest("hex"),
      ],
    );
    const resumedSession = await inbound.issueArubaReadSession("synthetic-device-0003", actor);
    assert.equal(
      (
        await database
          .getPool()
          .query(
            "SELECT status FROM aruba_sync_sessions WHERE id = '50000000-0000-4000-8000-000000000001'",
          )
      ).rows[0].status,
      "EXPIRED",
    );
    assert.equal(
      (await inbound.arubaReadManifest(resumedSession.token)).streams.find(
        (stream) => stream.name === "invoices:2026",
      )?.resumePageOrdinal,
      1,
    );
    const resumedPage = await inbound.ingestArubaInventoryPage(
      resumedSession.token,
      interruptedPage,
    );
    assert.equal(resumedPage.repeated, true);
    assert.ok(resumedPage.requestedFiles.some((file) => file.kind === "ARUBA_P7M"));
    await inbound.requestImmediateArubaSync(actor);
    const immediate = await inbound.listArubaPreflightWork(resumedSession.token);
    assert.ok(immediate.syncRequestedAt);
    assert.equal(
      (await inbound.listArubaPreflightWork(resumedSession.token)).syncRequestedAt,
      null,
    );
    const abandonedReceiptId = "40000000-0000-4000-8000-000000000003";
    await database.getPool().query(
      `INSERT INTO aruba_preflight_receipts
        (id, environment, account_reference, billing_case_id, document_id, draft_version,
         projection_sha256, manifest_sha256, inventory_watermark, requested_by, request_json,
         status, claimed_at)
       VALUES ($1, 'MOCK', 'synthetic-aruba-account', $2, $3, $4, $5, repeat('d', 64), 0,
         $6, jsonb_build_object('documentType', 'TD01'), 'RUNNING', now() - interval '3 minutes')`,
      [
        abandonedReceiptId,
        currentDraft.rows[0]!.billing_case_id,
        currentDraft.rows[0]!.id,
        currentDraft.rows[0]!.draft_version,
        currentDraft.rows[0]!.projection_sha256,
        actor.id,
      ],
    );
    const reclaimed = await inbound.listArubaPreflightWork(resumedSession.token);
    assert.equal(
      reclaimed.work.some((work) => work.id === abandonedReceiptId),
      true,
    );
    await database
      .getPool()
      .query("DELETE FROM aruba_preflight_receipts WHERE id = $1", [abandonedReceiptId]);

    const rejectedReceiptId = "40000000-0000-4000-8000-000000000004";
    await database.getPool().query(
      `INSERT INTO aruba_preflight_receipts
        (id, environment, account_reference, billing_case_id, document_id, draft_version,
         projection_sha256, manifest_sha256, inventory_watermark, requested_by, request_json,
         status, claimed_at)
       VALUES ($1, 'MOCK', 'synthetic-aruba-account', $2, $3, $4, $5, repeat('e', 64), 0,
         $6, jsonb_build_object('documentType', 'TD01', 'orderIds', ARRAY[$7::text]), 'RUNNING', now())`,
      [
        rejectedReceiptId,
        currentDraft.rows[0]!.billing_case_id,
        currentDraft.rows[0]!.id,
        currentDraft.rows[0]!.draft_version,
        currentDraft.rows[0]!.projection_sha256,
        actor.id,
        residualOrder.rows[0]!.id,
      ],
    );
    for (const [index, stream] of ["invoices:2026", "credit-notes:2026"].entries()) {
      await inbound.ingestArubaInventoryPage(resumedSession.token, {
        stream,
        scanOrdinal: 4,
        pageOrdinal: 1,
        cursor: `rejected-preflight-${index + 1}`,
        terminal: true,
        fullScan: false,
        documents: [],
      });
    }
    await inbound.completeArubaInventory(
      resumedSession.token,
      ["invoices:2026", "credit-notes:2026"],
      4,
      false,
    );
    assert.deepEqual(
      await inbound.completeArubaPreflight(resumedSession.token, {
        receiptId: rejectedReceiptId,
        candidateRemoteIds: ["REMOTE-REJECTED-001"],
        searchesCompleted: true,
      }),
      { passed: true },
    );
    await database
      .getPool()
      .query("DELETE FROM aruba_preflight_receipts WHERE id = $1", [rejectedReceiptId]);

    const creditReceiptId = "40000000-0000-4000-8000-000000000005";
    await database.getPool().query(
      `UPDATE aruba_document_matches SET order_id = $1, refund_ids = ARRAY[999998]::bigint[]
       WHERE remote_document_id = (
         SELECT id FROM aruba_remote_documents WHERE document_type = 'TD04' LIMIT 1
       )`,
      [residualOrder.rows[0]!.id],
    );
    await database.getPool().query(
      `INSERT INTO aruba_preflight_receipts
        (id, environment, account_reference, billing_case_id, document_id, draft_version,
         projection_sha256, manifest_sha256, inventory_watermark, requested_by, request_json,
         status, claimed_at)
       VALUES ($1, 'MOCK', 'synthetic-aruba-account', $2, $3, $4, $5, repeat('f', 64), 0,
         $6, jsonb_build_object('documentType', 'TD04', 'orderIds', ARRAY[$7::text],
           'refundIds', jsonb_build_array('999999')),
         'RUNNING', now())`,
      [
        creditReceiptId,
        currentDraft.rows[0]!.billing_case_id,
        currentDraft.rows[0]!.id,
        currentDraft.rows[0]!.draft_version,
        currentDraft.rows[0]!.projection_sha256,
        actor.id,
        residualOrder.rows[0]!.id,
      ],
    );
    await inbound.ingestArubaInventoryPage(resumedSession.token, {
      ...invoicePage,
      scanOrdinal: 5,
      cursor: "typed-preflight-invoice",
      fullScan: false,
      documents: [
        {
          ...invoicePage.documents[0],
          remoteId: "REMOTE-TYPED-TD01",
          fiscalNumber: "200",
          totalAmount: 5000,
          status: "SUBMITTED",
          orderReferences: ["#1002"],
        },
      ],
    });
    await inbound.ingestArubaInventoryPage(resumedSession.token, {
      stream: "credit-notes:2026",
      scanOrdinal: 5,
      pageOrdinal: 1,
      cursor: "typed-preflight-credit-note",
      terminal: true,
      fullScan: false,
      documents: [],
    });
    await inbound.completeArubaInventory(
      resumedSession.token,
      ["invoices:2026", "credit-notes:2026"],
      5,
      false,
    );
    assert.deepEqual(
      await inbound.completeArubaPreflight(resumedSession.token, {
        receiptId: creditReceiptId,
        candidateRemoteIds: ["REMOTE-TYPED-TD01"],
        searchesCompleted: true,
      }),
      { passed: true },
    );
    await database
      .getPool()
      .query("DELETE FROM aruba_preflight_receipts WHERE id = $1", [creditReceiptId]);

    await database.getPool().query(
      `UPDATE aruba_document_matches SET status = 'UNMATCHED', method = 'NONE',
         order_id = NULL, document_id = NULL,
         candidates_json = jsonb_build_array(jsonb_build_object(
           'candidateId', 'anchor-order', 'orderIds', jsonb_build_array('999999'),
           'compatible', true
         ))
       WHERE remote_document_id = (
         SELECT id FROM aruba_remote_documents WHERE remote_id = 'REMOTE-TYPED-TD01'
       )`,
    );
    const groupedReceiptId = "40000000-0000-4000-8000-000000000006";
    await database.getPool().query(
      `INSERT INTO aruba_preflight_receipts
        (id, environment, account_reference, billing_case_id, document_id, draft_version,
         projection_sha256, manifest_sha256, inventory_watermark, requested_by, request_json,
         status, claimed_at)
       VALUES ($1, 'MOCK', 'synthetic-aruba-account', $2, $3, $4, $5, repeat('a', 64), 0,
         $6, jsonb_build_object('documentType', 'TD01', 'orderIds', jsonb_build_array('999999')),
         'RUNNING', now())`,
      [
        groupedReceiptId,
        currentDraft.rows[0]!.billing_case_id,
        currentDraft.rows[0]!.id,
        currentDraft.rows[0]!.draft_version,
        currentDraft.rows[0]!.projection_sha256,
        actor.id,
      ],
    );
    for (const [index, stream] of ["invoices:2026", "credit-notes:2026"].entries()) {
      await inbound.ingestArubaInventoryPage(resumedSession.token, {
        stream,
        scanOrdinal: 6,
        pageOrdinal: 1,
        cursor: `grouped-preflight-${index + 1}`,
        terminal: true,
        fullScan: false,
        documents: [],
      });
    }
    await inbound.completeArubaInventory(
      resumedSession.token,
      ["invoices:2026", "credit-notes:2026"],
      6,
      false,
    );
    assert.deepEqual(
      await inbound.completeArubaPreflight(resumedSession.token, {
        receiptId: groupedReceiptId,
        candidateRemoteIds: [],
        searchesCompleted: true,
      }),
      { passed: false },
    );
    await database
      .getPool()
      .query("DELETE FROM aruba_remote_documents WHERE remote_id = 'REMOTE-TYPED-TD01'");

    const incompletePreflightId = "40000000-0000-4000-8000-000000000007";
    await database.getPool().query(
      `INSERT INTO aruba_preflight_receipts
        (id, environment, account_reference, billing_case_id, document_id, draft_version,
         projection_sha256, manifest_sha256, inventory_watermark, requested_by, request_json,
         status, claimed_at)
       VALUES ($1, 'MOCK', 'synthetic-aruba-account', $2, $3, $4, $5, repeat('b', 64), 0,
         $6, jsonb_build_object('documentType', 'TD01', 'orderIds', '[]'::jsonb),
         'RUNNING', now())`,
      [
        incompletePreflightId,
        currentDraft.rows[0]!.billing_case_id,
        currentDraft.rows[0]!.id,
        currentDraft.rows[0]!.draft_version,
        currentDraft.rows[0]!.projection_sha256,
        actor.id,
      ],
    );
    for (const [index, stream] of ["invoices:2026", "credit-notes:2026"].entries()) {
      await inbound.ingestArubaInventoryPage(resumedSession.token, {
        stream,
        scanOrdinal: 7,
        pageOrdinal: 1,
        cursor: `incomplete-preflight-${index + 1}`,
        terminal: false,
        fullScan: false,
        documents: [],
      });
    }
    assert.deepEqual(
      await inbound.completeArubaPreflight(resumedSession.token, {
        receiptId: incompletePreflightId,
        candidateRemoteIds: [],
        searchesCompleted: true,
      }),
      { passed: false },
    );
    await database
      .getPool()
      .query("DELETE FROM aruba_preflight_receipts WHERE id = $1", [incompletePreflightId]);
    await database
      .getPool()
      .query("DELETE FROM aruba_sync_pages WHERE sync_session_id = $1 AND scan_ordinal = 7", [
        resumedSession.sessionId,
      ]);

    await inbound.ingestArubaInventoryPage(resumedSession.token, {
      ...invoicePage,
      scanOrdinal: 2,
      documents: [{ ...invoicePage.documents[0], status: "REJECTED" }],
    });
    assert.equal(
      (
        await database.getPool().query(
          `SELECT matches.status FROM aruba_document_matches matches
           JOIN aruba_remote_documents remote ON remote.id = matches.remote_document_id
           WHERE remote.remote_id = 'REMOTE-001'`,
        )
      ).rows[0].status,
      "MATCHED",
    );
    await inbound.ingestArubaInventoryPage(resumedSession.token, {
      ...invoicePage,
      scanOrdinal: 3,
    });
    assert.equal(
      (
        await database.getPool().query(
          `SELECT matches.status FROM aruba_document_matches matches
           JOIN aruba_remote_documents remote ON remote.id = matches.remote_document_id
           WHERE remote.remote_id = 'REMOTE-001'`,
        )
      ).rows[0].status,
      "UNKNOWN_REMOTE_STATE",
    );
    await assert.rejects(
      inbound.completeArubaInventory(
        resumedSession.token,
        ["invoices:2026", "credit-notes:2026"],
        2,
        true,
      ),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "ARUBA_INVENTORY_INCOMPLETE",
    );
  } finally {
    const database = await import("./client.server.ts");
    await database.closePool();
    await rm(storage, { recursive: true, force: true });
    await fixture.drop();
  }
});
