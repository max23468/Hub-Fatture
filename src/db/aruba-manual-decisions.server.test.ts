import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acceptedInvoiceFromXml,
  fiscalProfileFromAcceptedInvoiceXml,
  generateFatturaXml,
} from "../documents.ts";
import { ARUBA_MATCHER_VERSION } from "../aruba-inbound.ts";
import { AppError } from "../errors.ts";
import { upgradeCachedArubaMatcher } from "./aruba-matcher-upgrade.server.ts";
import { closePool, getPool, withTransaction } from "./client.server.ts";
import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

let sharedDatabase: Awaited<ReturnType<typeof temporaryDatabase>> | null = null;
let sharedActorId: number | null = null;
let sharedCreditRemoteId: string | null = null;
const sharedStorageRoot = await mkdtemp(path.join(os.tmpdir(), "hub-fatture-manual-amount-"));

test("un candidato Aruba può essere escluso solo dopo la conferma esplicita", async () => {
  const database = await temporaryDatabase("aruba_manual_decisions");
  sharedDatabase = database;
  process.env.APP_ENV = "test";
  process.env.APP_BASE_URL = "http://localhost:8080";
  process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
  process.env.ARUBA_ACCOUNT_REFERENCE = "synthetic-aruba-account";
  process.env.DATABASE_URL = database.connectionString;
  process.env.DOCUMENT_STORAGE_ROOT = sharedStorageRoot;
  try {
    await runMigrations({ connectionString: database.connectionString });
    const actor = (
      await getPool().query<{ id: number }>(
        `INSERT INTO users (username, password_hash, can_approve)
         VALUES ('Massimo', 'hash-sintetico', true) RETURNING id`,
      )
    ).rows[0]!;
    sharedActorId = actor.id;
    const remote = (
      await getPool().query<{ id: string }>(
        `INSERT INTO aruba_remote_documents
          (environment, account_reference, remote_id, document_type, fiscal_year,
           document_date, total_amount, remote_status, remote_status_observed_at,
           metadata_digest)
         VALUES ('MOCK', 'synthetic-aruba-account', 'manual-decision', 'TD01', 2026,
           '2026-08-28', 1000, 'DELIVERED', now(), repeat('1', 64))
         RETURNING id`,
      )
    ).rows[0]!;
    const storage = (
      await getPool().query<{ id: string }>(
        `INSERT INTO storage_objects (kind, relative_path, sha256, size_bytes, content_type)
         VALUES ('ARUBA_XML', 'synthetic/manual-decision.xml', repeat('2', 64), 10,
                 'application/xml') RETURNING id`,
      )
    ).rows[0]!;
    await getPool().query(
      `INSERT INTO aruba_files (remote_document_id, storage_object_id, kind)
       VALUES ($1, $2, 'ARUBA_XML')`,
      [remote.id, storage.id],
    );
    const customer = (
      await getPool().query<{ id: string }>(
        `INSERT INTO customers
          (kind, match_key, display_name, billing_address_json, source_confidence,
           review_required)
         VALUES ('PRIVATE_IT', 'manual-amount-mismatch', 'Cliente sintetico', '{}',
                 'TAX_ID', false)
         RETURNING id::text`,
      )
    ).rows[0]!;
    const billingCase = (
      await getPool().query<{ id: string }>(
        `INSERT INTO billing_cases
          (customer_id, local_order_date, currency, status, customer_snapshot_json)
         VALUES ($1, '2026-08-28', 'EUR', 'NEEDS_REVIEW',
                 '{"reviewRequired":false,"canonicalProfile":{}}')
         RETURNING id::text`,
        [customer.id],
      )
    ).rows[0]!;
    const order = (
      await getPool().query<{ id: string }>(
        `INSERT INTO orders
          (provider, external_account_id, external_order_id, display_number,
           created_at_source, updated_at_source, local_order_date, currency, gross_amount,
           payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
           raw_snapshot_json, normalized_snapshot_json)
         VALUES ('SHOPIFY', 'manual-decisions', 'amount-mismatch', '#MISMATCH', now(), now(),
                 '2026-08-28', 'EUR', 1100, 'PAID', 'FULFILLED', 'GROUPED', $1, $2, '{}',
                 '{"orderReviewRequired":false,"deferredReviewRequired":false,
                   "customerSnapshot":{"canonicalProfile":{}}}')
         RETURNING id::text`,
        [customer.id, billingCase.id],
      )
    ).rows[0]!;
    await getPool().query(
      `INSERT INTO aruba_document_matches
        (remote_document_id, status, method, matcher_version, candidates_json)
       VALUES ($1, 'UNMATCHED', 'NONE', 1,
         jsonb_build_array(jsonb_build_object(
           'candidateId', $2::text, 'orderIds', jsonb_build_array($2::text),
           'potential', false, 'compatible', false, 'reviewable', false,
           'signals', jsonb_build_object(
             'provider', true, 'nearDate', true, 'recipient', true, 'total', false))))`,
      [remote.id, order.id],
    );
    const creditRemote = (
      await getPool().query<{ id: string }>(
        `INSERT INTO aruba_remote_documents
          (environment, account_reference, remote_id, document_type, fiscal_year, series,
           fiscal_number, document_date, total_amount, remote_status,
           remote_status_observed_at, metadata_digest)
         VALUES ('MOCK', 'synthetic-aruba-account', 'manual-credit-recovery', 'TD04', 2026,
           'FPR', '2', '2026-08-11', 345, 'DELIVERED', now(), repeat('3', 64))
         RETURNING id::text`,
      )
    ).rows[0]!;
    sharedCreditRemoteId = creditRemote.id;
    await getPool().query(
      `INSERT INTO aruba_document_matches
        (remote_document_id, status, method, matcher_version, candidates_json)
       VALUES ($1, 'UNMATCHED', 'NONE', 7, '[]')`,
      [creditRemote.id],
    );
    await getPool().query(
      `INSERT INTO aruba_sync_sessions
        (id, environment, account_reference, status, absolute_expires_at, completed_at,
         source, is_full_scan)
       VALUES ('00000000-0000-4000-8000-000000000222', 'MOCK',
         'synthetic-aruba-account', 'COMPLETED', now() + interval '1 hour', now(),
         'MANUAL', false)`,
    );
    await getPool().query(
      `INSERT INTO aruba_remote_observations
        (remote_document_id, sync_session_id, remote_status, stream, scan_ordinal,
         page_ordinal, payload_digest, payload_json)
       VALUES ($1, '00000000-0000-4000-8000-000000000222', 'DELIVERED',
         'credit-notes:2026', 1, 1, repeat('4', 64), $2)`,
      [
        creditRemote.id,
        JSON.stringify({
          remoteId: "manual-credit-recovery",
          documentType: "TD04",
          fiscalYear: 2026,
          series: "FPR",
          fiscalNumber: "2",
          documentDate: "2026-08-11",
          recipientName: "Mario Rossi",
          recipientTaxId: "RSSMRA80A01H501U",
          recipientTaxIdentifiers: [
            {
              type: "CODICE_FISCALE",
              countryCode: "IT",
              value: "RSSMRA80A01H501U",
            },
          ],
          recipientCountryCode: "IT",
          recipientAddress: "Via Cliente 2 00100 Roma IT",
          totalAmount: 345,
          currency: "EUR",
          status: "DELIVERED",
          providerObservedAt: null,
          xmlSha256: null,
          orderReferences: [],
        }),
      ],
    );
    const decisions = await import("./aruba-manual-decisions.server.ts");
    const owner = { id: actor.id, canApprove: true, requestId: "manual-decision-test" };
    await assert.rejects(
      decisions.confirmArubaDocumentOutOfScope(
        remote.id,
        "Documento sintetico verificato fuori perimetro",
        null,
        owner,
      ),
      (error) => error instanceof AppError && error.code === "ARUBA_PROFILE_CONFLICT",
    );
    assert.equal(
      (await getPool().query("SELECT method FROM aruba_document_matches")).rows[0].method,
      "NONE",
    );

    await decisions.confirmArubaDocumentOutOfScope(
      remote.id,
      "Documento sintetico verificato fuori perimetro",
      "confirmed",
      owner,
    );
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT matches.status, matches.method, remote.origin,
                  audit.before_json ->> 'actionableCandidateCount' AS candidate_count,
                  audit.before_json -> 'rejectedOrderIds' AS rejected_order_ids
           FROM aruba_document_matches matches
           JOIN aruba_remote_documents remote ON remote.id = matches.remote_document_id
           JOIN audit_events audit ON audit.entity_id = remote.id::text
             AND audit.action = 'ARUBA_DOCUMENT_CONFIRMED_OUT_OF_SCOPE'`,
        )
      ).rows[0],
      {
        status: "UNMATCHED",
        method: "MANUAL",
        origin: "ARUBA_EXTERNAL",
        candidate_count: "1",
        rejected_order_ids: [order.id],
      },
    );
    assert.equal(
      (await getPool().query("SELECT status FROM billing_cases WHERE id = $1", [billingCase.id]))
        .rows[0].status,
      "READY",
    );
  } finally {
    await closePool();
  }
});

test("le eccezioni manuali richiedono conferma e restano registrate", async () => {
  assert.ok(sharedDatabase);
  const database = sharedDatabase;
  process.env.APP_ENV = "test";
  process.env.APP_BASE_URL = "http://localhost:8080";
  process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
  process.env.ARUBA_ACCOUNT_REFERENCE = "synthetic-aruba-account";
  process.env.DATABASE_URL = database.connectionString;
  process.env.DOCUMENT_STORAGE_ROOT = sharedStorageRoot;
  try {
    await runMigrations({ connectionString: database.connectionString });
    const xml = await readFile("tests/fixtures/fatturapa/accepted-invoice.anonymized.xml", "utf8");
    const digest = createHash("sha256").update(xml).digest("hex");
    const relativePath = "aruba/manual/accepted-invoice.xml";
    await mkdir(path.dirname(path.join(sharedStorageRoot, relativePath)), { recursive: true });
    await writeFile(path.join(sharedStorageRoot, relativePath), xml, { mode: 0o600 });
    const profile = fiscalProfileFromAcceptedInvoiceXml(xml, "2026-08-10T10:00:00Z");
    await getPool().query(
      `INSERT INTO fiscal_profiles (version, status, profile_json) VALUES (1, 'MOCK', $1)`,
      [JSON.stringify(profile)],
    );
    assert.ok(sharedActorId);
    const customer = (
      await getPool().query<{ id: string }>(
        `INSERT INTO customers
          (kind, match_key, display_name, billing_address_json, source_confidence,
           review_required)
         VALUES ('PRIVATE_IT', 'manual-link-difference', 'Mario Rossi', '{}', 'TAX_ID', false)
         RETURNING id::text`,
      )
    ).rows[0]!;
    const customerSnapshot = {
      displayName: "Mario Rossi",
      taxIdentifiers: [
        {
          type: "CODICE_FISCALE",
          countryCode: "IT",
          value: "RSSMRA80A01H501U",
        },
      ],
      billingAddress: {
        line1: "Via Cliente 2",
        postalCode: "00100",
        city: "Roma",
        countryCode: "IT",
      },
      canonicalProfile: {},
    };
    const billingCase = (
      await getPool().query<{ id: string }>(
        `INSERT INTO billing_cases
          (customer_id, local_order_date, currency, status, customer_snapshot_json,
           fiscal_profile_version)
         VALUES ($1, '2026-08-10', 'EUR', 'NEEDS_REVIEW', $2, 1) RETURNING id::text`,
        [customer.id, JSON.stringify(customerSnapshot)],
      )
    ).rows[0]!;
    const order = (
      await getPool().query<{ id: string }>(
        `INSERT INTO orders
          (provider, external_account_id, external_order_id, display_number,
           created_at_source, updated_at_source, local_order_date, currency, gross_amount,
           payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
           raw_snapshot_json, normalized_snapshot_json)
         VALUES ('SHOPIFY', 'manual-link', 'difference', '#1001', now(), now(),
           '2026-08-10', 'EUR', 12000, 'PAID', 'FULFILLED', 'GROUPED', $1, $2, '{}', $3)
         RETURNING id::text`,
        [
          customer.id,
          billingCase.id,
          JSON.stringify({
            orderReviewRequired: false,
            deferredReviewRequired: false,
            customerSnapshot,
          }),
        ],
      )
    ).rows[0]!;
    await getPool().query(
      `INSERT INTO refunds
        (provider, external_account_id, external_order_id, external_refund_id, order_id,
         status, amount, completed_at, applied_before_issue, raw_json)
       VALUES ('SHOPIFY', 'manual-link', 'difference', 'refund-after-invoice', $1,
         'COMPLETED', 345, '2026-08-11T10:00:00Z', true, '{}')`,
      [order.id],
    );
    await getPool().query(
      `INSERT INTO order_tax_identifiers
        (order_id, type, raw_value, normalized_value, source_field, country_code)
       VALUES ($1, 'CODICE_FISCALE', 'RSSMRA80A01H501U', 'RSSMRA80A01H501U',
         'synthetic', 'IT')`,
      [order.id],
    );
    const remote = (
      await getPool().query<{ id: string }>(
        `INSERT INTO aruba_remote_documents
          (environment, account_reference, remote_id, document_type, fiscal_year, series,
           fiscal_number, document_date, total_amount, remote_status,
           remote_status_observed_at, metadata_digest, xml_sha256)
         VALUES ('MOCK', 'synthetic-aruba-account', 'manual-amount-link', 'TD01', 2026,
           'FPR', '1', '2026-08-10', 12345, 'DELIVERED', now(), repeat('1', 64), $1)
         RETURNING id::text`,
        [digest],
      )
    ).rows[0]!;
    const storage = (
      await getPool().query<{ id: string }>(
        `INSERT INTO storage_objects (kind, relative_path, sha256, size_bytes, content_type)
         VALUES ('ARUBA_XML', $1, $2, $3, 'application/xml') RETURNING id::text`,
        [relativePath, digest, Buffer.byteLength(xml)],
      )
    ).rows[0]!;
    await getPool().query(
      `INSERT INTO aruba_files (remote_document_id, storage_object_id, kind)
       VALUES ($1, $2, 'ARUBA_XML')`,
      [remote.id, storage.id],
    );
    await getPool().query(
      `INSERT INTO aruba_document_matches
        (remote_document_id, status, method, matcher_version, candidates_json)
       VALUES ($1, 'UNMATCHED', 'NONE', 8,
         jsonb_build_array(jsonb_build_object(
           'candidateId', $2::text, 'orderIds', jsonb_build_array($2::text),
           'compatible', false, 'reviewable', false,
           'signals', jsonb_build_object('provider', true, 'nearDate', true,
             'recipient', true, 'total', false))))`,
      [remote.id, order.id],
    );
    const decisions = await import("./aruba-manual-decisions.server.ts");
    const owner = { id: sharedActorId, canApprove: true, requestId: "manual-amount-link-test" };
    await assert.rejects(
      decisions.resolveArubaDocumentMatch(
        remote.id,
        order.id,
        "Differenza verificata sul documento ufficiale",
        null,
        null,
        owner,
      ),
      (error) => error instanceof AppError && error.code === "ARUBA_PROFILE_CONFLICT",
    );
    await decisions.resolveArubaDocumentMatch(
      remote.id,
      order.id,
      "Differenza verificata sul documento ufficiale",
      "confirmed",
      null,
      owner,
    );
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT documents.total_amount, documents.source_total_amount,
                  documents.difference_amount, documents.difference_reason,
                  documents.source_billing_case_id::text,
                  document_orders.amount, orders.trigger_status,
                  refunds.applied_before_issue,
                  EXISTS (SELECT 1 FROM jobs WHERE jobs.type = 'process_refund'
                    AND jobs.payload_json ->> 'refundId' = refunds.id::text) AS refund_job,
                  matches.status AS match_status, matches.method AS match_method
           FROM aruba_document_matches AS matches
           JOIN documents ON documents.id = matches.document_id
           JOIN document_orders ON document_orders.document_id = documents.id
           JOIN orders ON orders.id = document_orders.order_id
           JOIN refunds ON refunds.order_id = orders.id
           WHERE matches.remote_document_id = $1`,
          [remote.id],
        )
      ).rows[0],
      {
        total_amount: 12345,
        source_total_amount: 12000,
        difference_amount: 345,
        difference_reason: "Differenza verificata sul documento ufficiale",
        source_billing_case_id: billingCase.id,
        amount: 12000,
        trigger_status: "INVOICED",
        applied_before_issue: false,
        refund_job: true,
        match_status: "MATCHED",
        match_method: "MANUAL",
      },
    );

    const externalCustomer = (
      await getPool().query<{ id: string }>(
        `INSERT INTO customers
          (kind, match_key, display_name, billing_address_json, source_confidence,
           review_required)
         VALUES ('EU', 'external-evidence', 'Cliente diverso', '{}', 'EXACT_PROFILE', false)
         RETURNING id::text`,
      )
    ).rows[0]!;
    const externalSnapshot = {
      kind: "EU",
      displayName: "Cliente diverso",
      taxIdentifiers: [],
      billingAddress: {
        line1: "Via Differente 9",
        postalCode: "20100",
        city: "Milano",
        countryCode: "IT",
      },
      canonicalProfile: {},
    };
    const externalCase = (
      await getPool().query<{ id: string }>(
        `INSERT INTO billing_cases
          (customer_id, local_order_date, currency, status, customer_snapshot_json,
           fiscal_profile_version)
         VALUES ($1, '2026-08-10', 'EUR', 'READY', $2, 1) RETURNING id::text`,
        [externalCustomer.id, JSON.stringify(externalSnapshot)],
      )
    ).rows[0]!;
    const externalOrder = (
      await getPool().query<{ id: string }>(
        `INSERT INTO orders
          (provider, external_account_id, external_order_id, display_number,
           created_at_source, updated_at_source, local_order_date, currency, gross_amount,
           payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
           raw_snapshot_json, normalized_snapshot_json)
         VALUES ('SHOPIFY', 'manual-link', 'external-evidence', '#1002', now(), now(),
           '2026-08-10', 'EUR', 12345, 'PAID', 'FULFILLED', 'GROUPED', $1, $2, '{}', $3)
         RETURNING id::text`,
        [
          externalCustomer.id,
          externalCase.id,
          JSON.stringify({
            orderReviewRequired: false,
            deferredReviewRequired: false,
            customerSnapshot: externalSnapshot,
          }),
        ],
      )
    ).rows[0]!;
    const externalXml = xml.replace("FPR 0001/26", "FPR 0009/26");
    const externalDigest = createHash("sha256").update(externalXml).digest("hex");
    const externalPath = "aruba/manual/external-evidence.xml";
    await writeFile(path.join(sharedStorageRoot, externalPath), externalXml, { mode: 0o600 });
    const externalRemote = (
      await getPool().query<{ id: string }>(
        `INSERT INTO aruba_remote_documents
          (environment, account_reference, remote_id, document_type, fiscal_year, series,
           fiscal_number, document_date, total_amount, remote_status,
           remote_status_observed_at, metadata_digest, xml_sha256)
         VALUES ('MOCK', 'synthetic-aruba-account', 'external-evidence', 'TD01', 2026,
           'FPR', '9', '2026-08-10', 12345, 'DELIVERED', now(), repeat('9', 64), $1)
         RETURNING id::text`,
        [externalDigest],
      )
    ).rows[0]!;
    const externalStorage = (
      await getPool().query<{ id: string }>(
        `INSERT INTO storage_objects (kind, relative_path, sha256, size_bytes, content_type)
         VALUES ('ARUBA_XML', $1, $2, $3, 'application/xml') RETURNING id::text`,
        [externalPath, externalDigest, Buffer.byteLength(externalXml)],
      )
    ).rows[0]!;
    await getPool().query(
      `INSERT INTO aruba_files (remote_document_id, storage_object_id, kind)
       VALUES ($1, $2, 'ARUBA_XML')`,
      [externalRemote.id, externalStorage.id],
    );
    await getPool().query(
      `INSERT INTO aruba_document_matches
        (remote_document_id, status, method, matcher_version, candidates_json)
       VALUES ($1, 'UNMATCHED', 'NONE', $3,
         jsonb_build_array(jsonb_build_object(
           'candidateId', $2::text, 'orderIds', jsonb_build_array($2::text),
           'probe', true, 'compatible', false, 'reviewable', false,
           'signals', jsonb_build_object('provider', true, 'sameDay', true,
             'nearDate', true, 'recipient', false, 'taxId', false, 'address', false,
             'total', true, 'refundTimingClear', true))))`,
      [externalRemote.id, externalOrder.id, ARUBA_MATCHER_VERSION],
    );
    await assert.rejects(
      decisions.resolveArubaDocumentMatch(
        externalRemote.id,
        externalOrder.id,
        "Conferma cliente riferita a documento e ordine",
        null,
        null,
        owner,
      ),
      (error) => error instanceof AppError && error.code === "ARUBA_PROFILE_CONFLICT",
    );
    await assert.rejects(
      decisions.resolveArubaDocumentMatch(
        externalRemote.id,
        externalOrder.id,
        "Conferma cliente priva degli identificativi",
        null,
        "confirmed",
        owner,
      ),
      (error) => error instanceof AppError && error.code === "ARUBA_PROFILE_CONFLICT",
    );
    await decisions.resolveArubaDocumentMatch(
      externalRemote.id,
      externalOrder.id,
      "Conferma cliente: FPR 0009/26 riferita all’ordine Shopify #1002",
      null,
      "confirmed",
      owner,
    );
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT matches.status, matches.method, orders.trigger_status,
                  audit.after_json ->> 'externalEvidence' AS external_evidence,
                  matches.decision_reason
           FROM aruba_document_matches matches
           JOIN orders ON orders.id = matches.order_id
           JOIN audit_events audit ON audit.entity_id = matches.remote_document_id::text
             AND audit.action = 'ARUBA_DOCUMENT_MATCH_RESOLVED'
           WHERE matches.remote_document_id = $1`,
          [externalRemote.id],
        )
      ).rows[0],
      {
        status: "MATCHED",
        method: "MANUAL",
        trigger_status: "INVOICED",
        external_evidence: "true",
        decision_reason: "Conferma cliente: FPR 0009/26 riferita all’ordine Shopify #1002",
      },
    );
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT matches.status, matches.method, matches.matcher_version,
                  matches.candidates_json -> 0 ->> 'candidateId' AS candidate_id,
                  matches.candidates_json -> 0 -> 'signals' ->> 'total' AS total_signal
           FROM aruba_document_matches AS matches WHERE matches.remote_document_id = $1`,
          [sharedCreditRemoteId],
        )
      ).rows[0],
      {
        status: "UNMATCHED",
        method: "NONE",
        matcher_version: ARUBA_MATCHER_VERSION,
        candidate_id: order.id,
        total_signal: "true",
      },
    );

    const invoiceDocument = (
      await getPool().query<{ id: string; billing_case_id: string }>(
        `SELECT documents.id::text, documents.billing_case_id::text
         FROM aruba_document_matches matches
         JOIN documents ON documents.id = matches.document_id
         WHERE matches.remote_document_id = $1`,
        [remote.id],
      )
    ).rows[0]!;
    const creditDraft = await withTransaction(async (client) => {
      const created = (
        await client.query<{ id: string }>(
          `INSERT INTO documents
          (billing_case_id, kind, status, document_type, series, document_date,
           fiscal_profile_version, currency, total_amount, source_total_amount,
           difference_amount, draft_version, projection_sha256, payment_status,
           payment_method, recipient_snapshot_json)
         VALUES ($1, 'CREDIT_NOTE', 'DRAFT', 'TD04', 'FPR', '2026-09-02', 1,
           'EUR', 345, 345, 0, 1, repeat('5', 64), 'PAID', 'MP05', $2)
         RETURNING id::text`,
          [invoiceDocument.billing_case_id, JSON.stringify(customerSnapshot)],
        )
      ).rows[0]!;
      await client.query(
        `INSERT INTO document_links (document_id, related_document_id, relation_type)
         VALUES ($1, $2, 'CREDIT_NOTE_FOR_INVOICE')`,
        [created.id, invoiceDocument.id],
      );
      await client.query(
        `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
         VALUES ($1, 'CREDIT_NOTE', $2, 345)`,
        [created.id, order.id],
      );
      await client.query(`UPDATE refunds SET credit_document_id = $1 WHERE order_id = $2`, [
        created.id,
        order.id,
      ]);
      return created;
    });
    const importedInvoice = acceptedInvoiceFromXml(xml, profile.numbering.approvedAt);
    const creditXml = generateFatturaXml(
      profile,
      {
        ...importedInvoice.input,
        kind: "CREDIT_NOTE",
        documentDate: "2026-08-11",
        paymentMethod: "MP08",
        lines: [
          {
            orderId: order.id,
            description: "Rimborso beni usati - Ordine Shopify #1001",
            quantity: 1,
            unitAmount: 345,
          },
        ],
        relatedInvoice: { number: "FPR 0001/26", date: "2026-08-10" },
      },
      { year: 2026, number: 2 },
    );
    const creditXmlWithoutInvoiceReference = creditXml.replace(
      /<DatiFattureCollegate>[\s\S]*?<\/DatiFattureCollegate>/,
      "",
    );
    assert.doesNotMatch(creditXmlWithoutInvoiceReference, /DatiFattureCollegate/);
    const creditDigest = createHash("sha256")
      .update(creditXmlWithoutInvoiceReference)
      .digest("hex");
    const creditRelativePath = "aruba/manual/accepted-credit-note-mp08.xml";
    await writeFile(
      path.join(sharedStorageRoot, creditRelativePath),
      creditXmlWithoutInvoiceReference,
      {
        mode: 0o600,
      },
    );
    const creditStorage = (
      await getPool().query<{ id: string }>(
        `INSERT INTO storage_objects (kind, relative_path, sha256, size_bytes, content_type)
         VALUES ('ARUBA_XML', $1, $2, $3, 'application/xml') RETURNING id::text`,
        [creditRelativePath, creditDigest, Buffer.byteLength(creditXmlWithoutInvoiceReference)],
      )
    ).rows[0]!;
    await getPool().query(
      `INSERT INTO aruba_files (remote_document_id, storage_object_id, kind)
       VALUES ($1, $2, 'ARUBA_XML')`,
      [sharedCreditRemoteId, creditStorage.id],
    );
    await getPool().query(
      `UPDATE aruba_document_matches
       SET status = 'PROFILE_CONFLICT', matcher_version = 10
       WHERE remote_document_id = $1`,
      [sharedCreditRemoteId],
    );
    const unrelatedInvoice = (
      await getPool().query<{ id: string }>(
        `INSERT INTO aruba_remote_documents
          (environment, account_reference, remote_id, document_type, fiscal_year, series,
           fiscal_number, document_date, total_amount, remote_status,
           remote_status_observed_at, metadata_digest)
         VALUES ('MOCK', 'synthetic-aruba-account', 'unrelated-invoice-replay', 'TD01',
           2026, 'FPR', '99', '2026-08-11', 345, 'DELIVERED', now(), repeat('6', 64))
         RETURNING id::text`,
      )
    ).rows[0]!;
    await getPool().query(
      `INSERT INTO aruba_document_matches
        (remote_document_id, status, method, matcher_version, candidates_json)
       VALUES ($1, 'UNMATCHED', 'NONE', 10,
         '[{"potential":true,"compatible":false,"reviewable":false}]')`,
      [unrelatedInvoice.id],
    );
    await getPool().query(
      `INSERT INTO aruba_remote_observations
        (remote_document_id, sync_session_id, remote_status, stream, scan_ordinal,
         page_ordinal, payload_digest, payload_json)
       VALUES ($1, '00000000-0000-4000-8000-000000000222', 'DELIVERED',
         'invoices:2026', 1, 1, repeat('7', 64), $2)`,
      [
        unrelatedInvoice.id,
        JSON.stringify({
          remoteId: "unrelated-invoice-replay",
          documentType: "TD01",
          fiscalYear: 2026,
          series: "FPR",
          fiscalNumber: "99",
          documentDate: "2026-08-11",
          recipientName: "Mario Rossi",
          recipientTaxId: "RSSMRA80A01H501U",
          recipientTaxIdentifiers: [],
          recipientCountryCode: "IT",
          recipientAddress: "Via Cliente 2 00100 Roma IT",
          totalAmount: 345,
          currency: "EUR",
          status: "DELIVERED",
          providerObservedAt: null,
          xmlSha256: null,
          orderReferences: [],
        }),
      ],
    );
    const upgradedDocuments = await withTransaction(async (client) => {
      return upgradeCachedArubaMatcher(client, "MOCK", "synthetic-aruba-account");
    });
    assert.equal(upgradedDocuments, 1);
    assert.equal(
      (
        await getPool().query(
          `SELECT matcher_version FROM aruba_document_matches WHERE remote_document_id = $1`,
          [unrelatedInvoice.id],
        )
      ).rows[0].matcher_version,
      10,
    );
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT matches.status AS match_status, matches.method, matches.matcher_version,
                  matches.document_id::text, documents.status AS document_status,
                  documents.origin, documents.payment_method,
                  documents.document_date::text,
                  documents.immutable_snapshot_json ->> 'paymentMethod' AS snapshot_payment_method
           FROM aruba_document_matches matches
           JOIN documents ON documents.id = matches.document_id
           WHERE matches.remote_document_id = $1`,
          [sharedCreditRemoteId],
        )
      ).rows[0],
      {
        match_status: "MATCHED",
        method: "AUTOMATIC",
        matcher_version: ARUBA_MATCHER_VERSION,
        document_id: creditDraft.id,
        document_status: "APPROVED",
        origin: "ARUBA_HISTORY",
        payment_method: "MP08",
        document_date: "2026-08-11",
        snapshot_payment_method: "MP08",
      },
    );
    await getPool().query(
      `UPDATE aruba_document_matches SET matcher_version = 10 WHERE remote_document_id = $1`,
      [sharedCreditRemoteId],
    );
    assert.equal(
      await withTransaction(async (client) => {
        return upgradeCachedArubaMatcher(client, "MOCK", "synthetic-aruba-account");
      }),
      1,
    );
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT status, method, matcher_version, document_id::text
           FROM aruba_document_matches WHERE remote_document_id = $1`,
          [sharedCreditRemoteId],
        )
      ).rows[0],
      {
        status: "MATCHED",
        method: "AUTOMATIC",
        matcher_version: ARUBA_MATCHER_VERSION,
        document_id: creditDraft.id,
      },
    );

    // La collisione viene chiusa localmente senza fondere i due ID del provider.
    const { readArubaIdentityConflict, resolveArubaIdentityConflict } =
      await import("./aruba-identity-resolution.server.ts");
    const { reconcileRemoteDocument } = await import("./aruba-reconciliation.server.ts");
    const { remoteInventoryDocumentSchema, remoteMetadataDigest } =
      await import("../aruba-inbound.ts");
    const observation = remoteInventoryDocumentSchema.parse({
      remoteId: "manual-amount-link",
      documentType: "TD01",
      fiscalYear: 2026,
      series: "FPR",
      fiscalNumber: "1",
      documentDate: "2026-08-10",
      recipientName: "Mario Rossi",
      recipientTaxId: "RSSMRA80A01H501U",
      recipientCountryCode: "IT",
      recipientAddress: "Via Cliente 2 00100 Roma IT",
      totalAmount: 12345,
      currency: "EUR",
      status: "DELIVERED",
      xmlSha256: digest,
      orderReferences: [],
    });
    await getPool().query(
      `INSERT INTO aruba_remote_observations
        (remote_document_id, sync_session_id, remote_status, stream, scan_ordinal, page_ordinal, payload_digest, payload_json)
       VALUES ($1, '00000000-0000-4000-8000-000000000222', 'DELIVERED', 'invoices:2026', 1, 2, repeat('a', 64), $2)`,
      [remote.id, JSON.stringify(observation)],
    );
    await getPool().query("UPDATE aruba_remote_documents SET metadata_digest = $2 WHERE id = $1", [
      remote.id,
      remoteMetadataDigest(observation),
    ]);
    const duplicate = (
      await getPool().query<{ id: string }>(
        `INSERT INTO aruba_remote_documents
        (environment, account_reference, remote_id, document_type, fiscal_year, series, fiscal_number,
         document_date, total_amount, remote_status, remote_status_observed_at, metadata_digest, xml_sha256)
       SELECT environment, account_reference, 'erroneous-duplicate', document_type, fiscal_year, series, fiscal_number,
         document_date, total_amount, 'SUBMITTED', now(), repeat('b', 64), xml_sha256
       FROM aruba_remote_documents WHERE id = $1 RETURNING id::text`,
        [remote.id],
      )
    ).rows[0]!;
    const duplicatePath = "aruba/manual/duplicate.xml";
    await writeFile(path.join(sharedStorageRoot, duplicatePath), xml, { mode: 0o600 });
    const duplicateStorage = (
      await getPool().query<{ id: string }>(
        `INSERT INTO storage_objects (kind, relative_path, sha256, size_bytes, content_type)
       VALUES ('ARUBA_XML', $1, $2, $3, 'application/xml') RETURNING id::text`,
        [duplicatePath, digest, Buffer.byteLength(xml)],
      )
    ).rows[0]!;
    await getPool().query(
      `INSERT INTO aruba_files (remote_document_id, storage_object_id, kind)
      VALUES ($1, $2, 'ARUBA_XML')`,
      [duplicate.id, duplicateStorage.id],
    );
    await getPool().query(
      `INSERT INTO aruba_document_matches
      (remote_document_id, status, method, matcher_version, signals_json)
      VALUES ($1, 'UNKNOWN_REMOTE_STATE', 'NONE', 1, '{"providerIdentityCollision":true}')`,
      [duplicate.id],
    );
    await getPool().query(
      `INSERT INTO aruba_deduplication_conflicts
      (environment, account_reference, existing_remote_document_id, incoming_remote_id, collision_key,
       incoming_payload_digest, sync_session_id)
      VALUES ('MOCK', 'synthetic-aruba-account', $1, 'erroneous-duplicate', 'FISCAL_IDENTITY', repeat('b', 64),
        '00000000-0000-4000-8000-000000000222')`,
      [remote.id],
    );
    const duplicateObservation = {
      ...observation,
      remoteId: "erroneous-duplicate",
      status: "SUBMITTED" as const,
    };
    await getPool().query("UPDATE aruba_remote_documents SET metadata_digest = $2 WHERE id = $1", [
      duplicate.id,
      remoteMetadataDigest(duplicateObservation),
    ]);
    await getPool().query(
      `UPDATE aruba_document_matches SET status = 'UNKNOWN_REMOTE_STATE', method = 'NONE',
      signals_json = '{"providerIdentityCollision":true,"identityCollisionCandidatesVerified":true}'
      WHERE remote_document_id = $1`,
      [remote.id],
    );
    const controls = await import("./operational-controls.server.ts");
    await controls.refreshOperationalControls();
    assert.equal(
      (await controls.readOperationalControls({ kind: "ARUBA_IDENTITY_CONFLICT" })).total,
      1,
    );
    const inventory = await import("./aruba-inventory-queries.server.ts");
    const collisionRows = (await inventory.listRemoteDocuments()).filter((row) =>
      [remote.id, duplicate.id].includes(row.id),
    );
    assert.equal(new Set(collisionRows.map((row) => row.control_remote_id)).size, 1);
    const decision = await readArubaIdentityConflict(remote.id);
    assert.equal(decision.members.length, 2);
    const why = "Confrontati entrambi gli XML: il secondo documento è stato emesso per errore";
    await assert.rejects(
      resolveArubaIdentityConflict(remote.id, remote.id, decision.fingerprint, why, "confirmed", {
        ...owner,
        canApprove: false,
      }),
      (error) => error instanceof AppError && error.code === "ARUBA_READ_SESSION_FORBIDDEN",
    );
    await assert.rejects(
      resolveArubaIdentityConflict(
        remote.id,
        duplicate.id,
        decision.fingerprint,
        why,
        "confirmed",
        owner,
      ),
    );
    await assert.rejects(
      resolveArubaIdentityConflict(remote.id, remote.id, "stale", why, "confirmed", owner),
    );
    await assert.rejects(
      resolveArubaIdentityConflict(remote.id, remote.id, decision.fingerprint, why, null, owner),
    );
    await resolveArubaIdentityConflict(
      remote.id,
      remote.id,
      decision.fingerprint,
      why,
      "confirmed",
      owner,
    );
    assert.equal((await readArubaIdentityConflict(remote.id)).members.length, 0);
    const { ingestParsedArubaPage } = await import("./aruba-inbound.server.ts");
    const session = {
      id: "00000000-0000-4000-8000-000000000222",
      environment: "MOCK" as const,
      account_reference: "synthetic-aruba-account",
    };
    const page = {
      stream: "invoices:2026",
      scanOrdinal: 1,
      pageOrdinal: 91,
      cursor: null,
      terminal: true,
      fullScan: false,
      documents: [duplicateObservation],
    };
    await withTransaction(async (client) => {
      await ingestParsedArubaPage(client, session, page, false);
    });
    assert.equal((await readArubaIdentityConflict(remote.id)).members.length, 0);
    await assert.rejects(
      resolveArubaIdentityConflict(
        remote.id,
        remote.id,
        decision.fingerprint,
        why,
        "confirmed",
        owner,
      ),
    );
    await withTransaction(async (client) => {
      await reconcileRemoteDocument(
        client,
        duplicate.id,
        { ...observation, remoteId: "erroneous-duplicate", status: "SUBMITTED" },
        true,
      );
    });
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT status, method, document_id, signals_json FROM aruba_document_matches
      WHERE remote_document_id = $1`,
          [duplicate.id],
        )
      ).rows[0],
      {
        status: "UNMATCHED",
        method: "MANUAL",
        document_id: null,
        signals_json: { identityCollisionExcluded: true },
      },
    );
    await assert.rejects(
      decisions.resolveArubaDocumentMatch(duplicate.id, order.id, why, "confirmed", null, owner),
    );
    assert.equal(
      (await controls.readOperationalControls({ kind: "ARUBA_IDENTITY_CONFLICT" })).total,
      0,
    );
    assert.equal(
      (await controls.readOperationalControls({ kind: "ARUBA_ERRONEOUS_DOCUMENT" })).total,
      1,
    );
    assert.equal(
      (
        await getPool().query(`SELECT count(*)::int AS count FROM audit_events
      WHERE action = 'ARUBA_IDENTITY_CONFLICT_RESOLVED'`)
      ).rows[0].count,
      1,
    );
    await getPool().query(
      `UPDATE aruba_remote_documents SET remote_status = 'SDI_PROCESSING'
      WHERE id = $1`,
      [duplicate.id],
    );
    await withTransaction(async (client) => {
      await reconcileRemoteDocument(
        client,
        duplicate.id,
        { ...observation, remoteId: "erroneous-duplicate", status: "SDI_PROCESSING" },
        true,
      );
    });
    assert.equal((await readArubaIdentityConflict(remote.id)).members.length, 2);
    assert.equal(
      (
        await getPool().query(
          `SELECT status FROM aruba_document_matches WHERE remote_document_id = $1`,
          [duplicate.id],
        )
      ).rows[0].status,
      "UNKNOWN_REMOTE_STATE",
    );

    const reopened = await readArubaIdentityConflict(remote.id);
    await resolveArubaIdentityConflict(
      remote.id,
      remote.id,
      reopened.fingerprint,
      why,
      "confirmed",
      owner,
    );
    await withTransaction(async (client) => {
      await ingestParsedArubaPage(
        client,
        session,
        {
          ...page,
          pageOrdinal: 92,
          documents: [{ ...duplicateObservation, remoteId: "third-duplicate" }],
        },
        false,
      );
    });
    const three = await readArubaIdentityConflict(remote.id);
    assert.equal(three.members.length, 3);
    await controls.refreshOperationalControls();
    assert.equal(
      (await controls.readOperationalControls({ kind: "ARUBA_IDENTITY_CONFLICT" })).total,
      1,
    );
    await assert.rejects(
      resolveArubaIdentityConflict(
        remote.id,
        remote.id,
        three.fingerprint,
        why,
        "confirmed",
        owner,
      ),
    );
    // La fattura scelta può avere lo stesso numero di un tentativo locale immutabile.
    const chosenXml = xml
      .replace("FPR 0001/26", "FPR 0991/26")
      .replaceAll("2026-08-10", "2026-08-12");
    const wrongXml = chosenXml.replaceAll("MARIO", "LUIGI");
    const chosenHash = createHash("sha256").update(chosenXml).digest("hex");
    const wrongHash = createHash("sha256").update(wrongXml).digest("hex");
    assert.notEqual(chosenHash, wrongHash);
    const newCase = (
      await getPool().query<{ id: string }>(
        `INSERT INTO billing_cases (customer_id, local_order_date, currency, status, customer_snapshot_json, fiscal_profile_version)
       VALUES ($1, '2026-08-12', 'EUR', 'READY', $2, 1) RETURNING id::text`,
        [customer.id, JSON.stringify(customerSnapshot)],
      )
    ).rows[0]!;
    const chosenOrder = (
      await getPool().query<{ id: string }>(
        `INSERT INTO orders
        (provider, external_account_id, external_order_id, display_number, created_at_source, updated_at_source,
         local_order_date, currency, gross_amount, payment_status, fulfillment_status, trigger_status,
         customer_id, billing_case_id, raw_snapshot_json, normalized_snapshot_json)
       VALUES ('SHOPIFY', 'manual-link', 'resolved-archive', '#991', now(), now(), '2026-08-12',
         'EUR', 12345, 'PAID', 'FULFILLED', 'GROUPED', $1, $2, '{}', $3) RETURNING id::text`,
        [
          customer.id,
          newCase.id,
          JSON.stringify({
            orderReviewRequired: false,
            deferredReviewRequired: false,
            customerSnapshot,
          }),
        ],
      )
    ).rows[0]!;
    await getPool().query(
      `INSERT INTO order_tax_identifiers
      (order_id, type, raw_value, normalized_value, source_field, country_code)
      VALUES ($1, 'CODICE_FISCALE', 'RSSMRA80A01H501U', 'RSSMRA80A01H501U', 'synthetic', 'IT')`,
      [chosenOrder.id],
    );
    const pair = [];
    for (const [suffix, content, hash, status] of [
      ["chosen", chosenXml, chosenHash, "NOT_DELIVERED"],
      ["wrong", wrongXml, wrongHash, "SUBMITTED"],
    ] as const) {
      const remoteObservation = {
        ...observation,
        remoteId: `archive-${suffix}`,
        fiscalNumber: "991",
        documentDate: "2026-08-12",
        status,
        xmlSha256: hash,
      };
      const member = (
        await getPool().query<{ id: string }>(
          `INSERT INTO aruba_remote_documents
          (environment, account_reference, remote_id, document_type, fiscal_year, series, fiscal_number,
           document_date, total_amount, remote_status, remote_status_observed_at, metadata_digest, xml_sha256)
         VALUES ('MOCK', 'synthetic-aruba-account', $1, 'TD01', 2026, 'FPR', '991', '2026-08-12',
           12345, $2, now(), $3, $4) RETURNING id::text`,
          [remoteObservation.remoteId, status, remoteMetadataDigest(remoteObservation), hash],
        )
      ).rows[0]!;
      const filePath = `aruba/manual/archive-${suffix}.xml`;
      await writeFile(path.join(sharedStorageRoot, filePath), content);
      const file = (
        await getPool().query<{ id: string }>(
          `INSERT INTO storage_objects (kind, relative_path, sha256, size_bytes, content_type)
         VALUES ('ARUBA_XML', $1, $2, $3, 'application/xml') RETURNING id::text`,
          [filePath, hash, Buffer.byteLength(content)],
        )
      ).rows[0]!;
      await getPool().query(
        `INSERT INTO aruba_files (remote_document_id, storage_object_id, kind)
        VALUES ($1, $2, 'ARUBA_XML')`,
        [member.id, file.id],
      );
      await getPool().query(
        `INSERT INTO aruba_remote_observations
        (remote_document_id, sync_session_id, remote_status, stream, scan_ordinal, page_ordinal, payload_digest, payload_json)
        VALUES ($1, '00000000-0000-4000-8000-000000000222', $2, 'invoices:2026', 1, 99, $3, $4)`,
        [member.id, status, hash, JSON.stringify(remoteObservation)],
      );
      await getPool().query(
        `INSERT INTO aruba_document_matches
        (remote_document_id, status, method, matcher_version, signals_json)
        VALUES ($1, 'UNKNOWN_REMOTE_STATE', 'NONE', $2, '{"providerIdentityCollision":true}')`,
        [member.id, ARUBA_MATCHER_VERSION],
      );
      pair.push({ id: member.id, storageId: file.id });
    }
    const [chosen, wrong] = pair;
    assert.ok(chosen && wrong);
    const wrongCase = (
      await getPool().query<{ id: string }>(
        `INSERT INTO billing_cases (customer_id, local_order_date, currency, status, customer_snapshot_json, fiscal_profile_version)
       VALUES ($1, '2026-08-12', 'EUR', 'CLOSED', $2, 1) RETURNING id::text`,
        [externalCustomer.id, JSON.stringify(externalSnapshot)],
      )
    ).rows[0]!;
    const wrongOrder = (
      await getPool().query<{ id: string }>(
        `INSERT INTO orders
        (provider, external_account_id, external_order_id, display_number, created_at_source, updated_at_source,
         local_order_date, currency, gross_amount, payment_status, fulfillment_status, trigger_status,
         customer_id, billing_case_id, raw_snapshot_json, normalized_snapshot_json)
       VALUES ('SHOPIFY', 'manual-link', 'wrong-archive', '#992', now(), now(), '2026-08-12',
         'EUR', 12345, 'PAID', 'FULFILLED', 'INVOICED', $1, $2, '{}', $3) RETURNING id::text`,
        [
          externalCustomer.id,
          wrongCase.id,
          JSON.stringify({
            orderReviewRequired: false,
            deferredReviewRequired: false,
            customerSnapshot: externalSnapshot,
          }),
        ],
      )
    ).rows[0]!;
    const wrongDocument = (
      await getPool().query<{ id: string }>(
        `INSERT INTO documents
        (billing_case_id, kind, status, document_type, series, fiscal_year, fiscal_number, document_date,
         fiscal_profile_version, currency, total_amount, source_total_amount, difference_amount,
         projection_sha256, approved_at, xml_sha256, immutable_snapshot_json, fiscal_profile_snapshot_json,
         storage_object_id, origin)
       VALUES ($1, 'INVOICE', 'DRAFT', 'TD01', 'FPR', NULL, NULL, '2026-08-12', 1, 'EUR',
         12345, 12345, 0, $2, NULL, NULL, NULL, NULL, NULL, 'HUB') RETURNING id::text`,
        [wrongCase.id, wrongHash],
      )
    ).rows[0]!;
    await getPool().query(
      `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
      VALUES ($1, 'INVOICE', $2, 12345)`,
      [wrongDocument.id, wrongOrder.id],
    );
    await getPool().query(
      `UPDATE documents SET status = 'APPROVED', fiscal_year = 2026,
      fiscal_number = 991, approved_at = now(), xml_sha256 = $2, immutable_snapshot_json = '{}',
      fiscal_profile_snapshot_json = $3, storage_object_id = $4 WHERE id = $1`,
      [wrongDocument.id, wrongHash, JSON.stringify(profile), wrong.storageId],
    );
    const beforeWrong = (
      await getPool().query(`SELECT to_jsonb(documents) AS document FROM documents WHERE id = $1`, [
        wrongDocument.id,
      ])
    ).rows[0];
    await getPool().query(
      `INSERT INTO aruba_deduplication_conflicts
      (environment, account_reference, existing_remote_document_id, incoming_remote_id, collision_key, incoming_payload_digest, sync_session_id)
      VALUES ('MOCK', 'synthetic-aruba-account', $1, 'archive-wrong', 'FISCAL_IDENTITY', $2, '00000000-0000-4000-8000-000000000222')`,
      [chosen.id, wrongHash],
    );
    const attemptArchive = (resolutionId: string | null, hash = chosenHash) =>
      getPool().query(
        `INSERT INTO documents
        (billing_case_id, kind, status, document_type, series, fiscal_year, fiscal_number, document_date,
         fiscal_profile_version, currency, total_amount, source_total_amount, difference_amount,
         projection_sha256, approved_at, xml_sha256, immutable_snapshot_json, fiscal_profile_snapshot_json,
         storage_object_id, origin, identity_resolution_remote_document_id)
       SELECT $1, kind, status, document_type, series, fiscal_year, fiscal_number, document_date,
         fiscal_profile_version, currency, total_amount, source_total_amount, difference_amount,
         $2, approved_at, $2, immutable_snapshot_json, fiscal_profile_snapshot_json,
         storage_object_id, 'ARUBA_HISTORY', $3 FROM documents WHERE id = $4`,
        [newCase.id, hash, resolutionId, wrongDocument.id],
      );
    await assert.rejects(attemptArchive(null), { constraint: "documents_fiscal_number_idx" });
    await assert.rejects(attemptArchive(chosen.id), /decisione verificata/);
    const archiveDecision = await readArubaIdentityConflict(chosen.id);
    await resolveArubaIdentityConflict(
      chosen.id,
      chosen.id,
      archiveDecision.fingerprint,
      why,
      "confirmed",
      owner,
    );
    const archivedPair = (
      await getPool().query(`SELECT id::text, xml_sha256, origin,
      identity_resolution_remote_document_id::text AS resolution FROM documents WHERE fiscal_number = 991 ORDER BY id`)
    ).rows;
    assert.equal(archivedPair.length, 2);
    assert.deepEqual(archivedPair[1], {
      id: archivedPair[1].id,
      xml_sha256: chosenHash,
      origin: "ARUBA_HISTORY",
      resolution: chosen.id,
    });
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT to_jsonb(documents) AS document FROM documents WHERE id = $1`,
          [wrongDocument.id],
        )
      ).rows[0],
      beforeWrong,
    );
    assert.equal(
      (
        await getPool().query(`SELECT document_id::text FROM document_orders WHERE order_id = $1`, [
          wrongOrder.id,
        ])
      ).rows[0].document_id,
      wrongDocument.id,
    );
    assert.equal(
      (
        await getPool().query(`SELECT document_id::text FROM document_orders WHERE order_id = $1`, [
          chosenOrder.id,
        ])
      ).rows[0].document_id,
      archivedPair[1].id,
    );
    const { materializeLatestOfficialXml, reconcileAutomaticAmbiguousInvoices } =
      await import("./aruba-document-materialization.server.ts");
    await withTransaction(async (client) => {
      assert.equal(await materializeLatestOfficialXml(client, chosen.id), archivedPair[1].id);
    });
    assert.equal((await readArubaIdentityConflict(chosen.id)).members.length, 0);
    await assert.rejects(attemptArchive(chosen.id, wrongHash), /decisione verificata/);
    await assert.rejects(attemptArchive(null), { constraint: "documents_fiscal_number_idx" });
    await assert.rejects(
      getPool().query("UPDATE documents SET total_amount = 0 WHERE id = $1", [wrongDocument.id]),
      /immutabile/,
    );
    assert.equal(
      (await getPool().query("SELECT trigger_status FROM orders WHERE id = $1", [wrongOrder.id]))
        .rows[0].trigger_status,
      "INVOICED",
    );

    const automaticCase = (
      await getPool().query<{ id: string }>(
        `INSERT INTO billing_cases
          (customer_id, local_order_date, currency, status, customer_snapshot_json,
           fiscal_profile_version)
         VALUES ($1, '2026-08-10', 'EUR', 'READY', $2, 1) RETURNING id::text`,
        [customer.id, JSON.stringify(customerSnapshot)],
      )
    ).rows[0]!;
    const automaticOrder = (
      await getPool().query<{ id: string }>(
        `INSERT INTO orders
          (provider, external_account_id, external_order_id, display_number,
           created_at_source, updated_at_source, local_order_date, currency, gross_amount,
           payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
           raw_snapshot_json, normalized_snapshot_json)
         VALUES ('SHOPIFY', 'manual-link', 'automatic-cohort', '#1010', now(), now(),
           '2026-08-10', 'EUR', 12345, 'PAID', 'FULFILLED', 'GROUPED', $1, $2, '{}', $3)
         RETURNING id::text`,
        [
          customer.id,
          automaticCase.id,
          JSON.stringify({
            orderReviewRequired: false,
            deferredReviewRequired: false,
            customerSnapshot,
          }),
        ],
      )
    ).rows[0]!;
    const automaticXml = xml.replace("FPR 0001/26", "FPR 0010/26");
    const automaticDigest = createHash("sha256").update(automaticXml).digest("hex");
    const automaticPath = "aruba/manual/automatic-cohort.xml";
    await writeFile(path.join(sharedStorageRoot, automaticPath), automaticXml, { mode: 0o600 });
    const automaticRemote = (
      await getPool().query<{ id: string }>(
        `INSERT INTO aruba_remote_documents
          (environment, account_reference, remote_id, document_type, fiscal_year, series,
           fiscal_number, document_date, total_amount, remote_status,
           remote_status_observed_at, metadata_digest, xml_sha256,
           recipient_name_normalized, recipient_tax_id_normalized)
         VALUES ('MOCK', 'synthetic-aruba-account', 'automatic-cohort', 'TD01', 2026,
           'FPR', '10', '2026-08-10', 12345, 'DELIVERED', now(), repeat('a', 64), $1,
           'MARIO ROSSI', 'RSSMRA80A01H501U')
         RETURNING id::text`,
        [automaticDigest],
      )
    ).rows[0]!;
    const automaticStorage = (
      await getPool().query<{ id: string }>(
        `INSERT INTO storage_objects (kind, relative_path, sha256, size_bytes, content_type)
         VALUES ('ARUBA_XML', $1, $2, $3, 'application/xml') RETURNING id::text`,
        [automaticPath, automaticDigest, Buffer.byteLength(automaticXml)],
      )
    ).rows[0]!;
    await getPool().query(
      `INSERT INTO aruba_files (remote_document_id, storage_object_id, kind)
       VALUES ($1, $2, 'ARUBA_XML')`,
      [automaticRemote.id, automaticStorage.id],
    );
    await getPool().query(
      `INSERT INTO aruba_document_matches
        (remote_document_id, status, method, matcher_version, candidates_json)
       VALUES ($1, 'AMBIGUOUS', 'NONE', $3,
         jsonb_build_array(jsonb_build_object(
           'candidateId', $2::text, 'orderIds', jsonb_build_array($2::text),
           'compatible', true, 'reviewable', false,
           'signals', jsonb_build_object('provider', true, 'sameDay', true,
             'nearDate', true, 'recipient', true, 'taxId', true, 'total', true,
             'explicitReference', false))))`,
      [automaticRemote.id, automaticOrder.id, ARUBA_MATCHER_VERSION],
    );
    const automaticDocuments = await withTransaction((client) =>
      reconcileAutomaticAmbiguousInvoices(client, [automaticRemote.id]),
    );
    assert.equal(automaticDocuments.length, 1);
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT matches.status, matches.method, matches.order_id::text,
                  matches.document_id::text, orders.trigger_status
           FROM aruba_document_matches matches
           JOIN orders ON orders.id = matches.order_id
           WHERE matches.remote_document_id = $1`,
          [automaticRemote.id],
        )
      ).rows[0],
      {
        status: "MATCHED",
        method: "AUTOMATIC",
        order_id: automaticOrder.id,
        document_id: automaticDocuments[0],
        trigger_status: "INVOICED",
      },
    );

    const roundedCase = (
      await getPool().query<{ id: string }>(
        `INSERT INTO billing_cases
          (customer_id, local_order_date, currency, status, customer_snapshot_json,
           fiscal_profile_version)
         VALUES ($1, '2026-08-10', 'EUR', 'NEEDS_REVIEW', $2, 1) RETURNING id::text`,
        [customer.id, JSON.stringify(customerSnapshot)],
      )
    ).rows[0]!;
    const roundedOrder = (
      await getPool().query<{ id: string }>(
        `INSERT INTO orders
          (provider, external_account_id, external_order_id, display_number,
           created_at_source, updated_at_source, local_order_date, currency, gross_amount,
           payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
           raw_snapshot_json, normalized_snapshot_json)
         VALUES ('SHOPIFY', 'manual-link', 'converted-payment', '#1011', now(), now(),
           '2026-08-10', 'EUR', 12346, 'PAID', 'FULFILLED', 'GROUPED', $1, $2, '{}', $3)
         RETURNING id::text`,
        [
          customer.id,
          roundedCase.id,
          JSON.stringify({
            orderReviewRequired: false,
            deferredReviewRequired: false,
            customerSnapshot,
          }),
        ],
      )
    ).rows[0]!;
    await getPool().query(
      `INSERT INTO payments (order_id, external_payment_id, method, status, amount, raw_json)
       VALUES ($1, 'converted-payment', 'shopify_payments', 'PAID', 12345, '{}')`,
      [roundedOrder.id],
    );
    const roundedXml = xml.replace("FPR 0001/26", "FPR 0011/26");
    const roundedDigest = createHash("sha256").update(roundedXml).digest("hex");
    const roundedPath = "aruba/manual/payment-rounding.xml";
    await writeFile(path.join(sharedStorageRoot, roundedPath), roundedXml, { mode: 0o600 });
    const roundedRemote = (
      await getPool().query<{ id: string }>(
        `INSERT INTO aruba_remote_documents
          (environment, account_reference, remote_id, document_type, fiscal_year, series,
           fiscal_number, document_date, total_amount, remote_status,
           remote_status_observed_at, metadata_digest, xml_sha256)
         VALUES ('MOCK', 'synthetic-aruba-account', 'payment-rounding', 'TD01', 2026,
           'FPR', '11', '2026-08-10', 12345, 'DELIVERED', now(), repeat('b', 64), $1)
         RETURNING id::text`,
        [roundedDigest],
      )
    ).rows[0]!;
    const roundedStorage = (
      await getPool().query<{ id: string }>(
        `INSERT INTO storage_objects (kind, relative_path, sha256, size_bytes, content_type)
         VALUES ('ARUBA_XML', $1, $2, $3, 'application/xml') RETURNING id::text`,
        [roundedPath, roundedDigest, Buffer.byteLength(roundedXml)],
      )
    ).rows[0]!;
    await getPool().query(
      `INSERT INTO aruba_files (remote_document_id, storage_object_id, kind)
       VALUES ($1, $2, 'ARUBA_XML')`,
      [roundedRemote.id, roundedStorage.id],
    );
    await getPool().query(
      `INSERT INTO aruba_document_matches
        (remote_document_id, status, method, matcher_version, order_id, billing_case_id)
       VALUES ($1, 'MATCHED', 'AUTOMATIC', $2, $3, $4)`,
      [roundedRemote.id, ARUBA_MATCHER_VERSION, roundedOrder.id, roundedCase.id],
    );
    const roundedDocument = await withTransaction((client) =>
      materializeLatestOfficialXml(client, roundedRemote.id, true),
    );
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT documents.total_amount, documents.source_total_amount,
                  documents.difference_amount, documents.difference_reason,
                  document_orders.amount, orders.trigger_status,
                  billing_cases.status AS source_case_status
           FROM documents
           JOIN document_orders ON document_orders.document_id = documents.id
           JOIN orders ON orders.id = document_orders.order_id
           JOIN billing_cases ON billing_cases.id = $2
           WHERE documents.id = $1`,
          [roundedDocument, roundedCase.id],
        )
      ).rows[0],
      {
        total_amount: 12345,
        source_total_amount: 12346,
        difference_amount: -1,
        difference_reason:
          "Arrotondamento dell’incasso: il documento Aruba riporta −0,01 € rispetto al totale ordine",
        amount: 12346,
        trigger_status: "INVOICED",
        source_case_status: "CLOSED",
      },
    );
  } finally {
    await closePool();
  }
});

test("acconto e saldo Aruba verificati chiudono automaticamente la preparazione", async () => {
  assert.ok(sharedDatabase);
  const database = sharedDatabase;
  const storageRoot = sharedStorageRoot;
  process.env.APP_ENV = "test";
  process.env.APP_BASE_URL = "http://localhost:8080";
  process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
  process.env.ARUBA_ACCOUNT_REFERENCE = "synthetic-aruba-account";
  process.env.DATABASE_URL = database.connectionString;
  process.env.DOCUMENT_STORAGE_ROOT = storageRoot;
  try {
    await runMigrations({ connectionString: database.connectionString });
    const { materializeLatestOfficialXml } =
      await import("./aruba-document-materialization.server.ts");
    const acceptedXml = await readFile(
      "tests/fixtures/fatturapa/accepted-invoice.anonymized.xml",
      "utf8",
    );
    const profile = fiscalProfileFromAcceptedInvoiceXml(acceptedXml, "2026-08-10T10:00:00Z");
    const imported = acceptedInvoiceFromXml(acceptedXml, profile.numbering.approvedAt);
    const customerSnapshot = {
      displayName: "Mario Rossi",
      reviewRequired: false,
      taxIdentifiers: [{ type: "CODICE_FISCALE", countryCode: "IT", value: "RSSMRA80A01H501U" }],
      billingAddress: {
        line1: "Via Cliente 2",
        postalCode: "00100",
        city: "Roma",
        countryCode: "IT",
      },
      canonicalProfile: {},
    };
    const setup = (
      await getPool().query<{ case_id: string; order_id: string }>(
        `WITH customer AS (
           INSERT INTO customers
             (kind, match_key, display_name, billing_address_json, source_confidence,
              review_required)
           VALUES ('PRIVATE_IT', 'split-invoice', 'Mario Rossi', '{}', 'TAX_ID', false)
           RETURNING id
         ), billing AS (
           INSERT INTO billing_cases
             (customer_id, local_order_date, currency, status, customer_snapshot_json,
              fiscal_profile_version)
           SELECT customer.id, '2026-07-31', 'EUR', 'READY', $1::jsonb, 1 FROM customer
           RETURNING id, customer_id
         )
         INSERT INTO orders
           (provider, external_account_id, external_order_id, display_number,
            created_at_source, updated_at_source, local_order_date, currency, gross_amount,
            payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
            raw_snapshot_json, normalized_snapshot_json)
         SELECT 'SHOPIFY', 'split-invoice', 'split-order', '#9100', now(), now(), '2026-07-31',
                'EUR', 80120, 'PAID', 'FULFILLED', 'GROUPED', billing.customer_id, billing.id,
                '{}', $2::jsonb
         FROM billing
         RETURNING billing_case_id::text AS case_id, id::text AS order_id`,
        [
          JSON.stringify(customerSnapshot),
          JSON.stringify({
            orderReviewRequired: false,
            deferredReviewRequired: false,
            customerSnapshot,
          }),
        ],
      )
    ).rows[0]!;
    await getPool().query(
      `INSERT INTO aruba_sync_sessions
        (id, environment, account_reference, status, absolute_expires_at, completed_at,
         source, is_full_scan)
       VALUES ('00000000-0000-4000-8000-000000000333', 'MOCK',
         'synthetic-aruba-account', 'COMPLETED', now() + interval '1 hour', now(),
         'MANUAL', false)`,
    );
    const parts = [
      { number: 31, date: "2026-08-05", amount: 40_000, description: "Monete commemorative" },
      { number: 32, date: "2026-09-03", amount: 40_120, description: "Monete commemorative SALDO" },
    ].map((part) => ({
      ...part,
      xml: generateFatturaXml(
        profile,
        {
          ...imported.input,
          documentDate: part.date,
          paymentMethod: "MP05",
          lines: [
            {
              orderId: setup.order_id,
              description: part.description,
              quantity: 1,
              unitAmount: part.amount,
            },
          ],
        },
        { year: 2026, number: part.number },
      ),
    }));
    const remoteIds: string[] = [];
    for (const part of parts) {
      const remote = (
        await getPool().query<{ id: string }>(
          `INSERT INTO aruba_remote_documents
            (environment, account_reference, remote_id, document_type, fiscal_year, series,
             fiscal_number, document_date, recipient_name_normalized,
             recipient_tax_id_normalized, total_amount, remote_status,
             remote_status_observed_at, metadata_digest)
           VALUES ('MOCK', 'synthetic-aruba-account', $1, 'TD01', 2026, 'FPR', $2, $3,
             'MARIOROSSI', 'RSSMRA80A01H501U', $4, 'DELIVERED', now(), repeat('c', 64))
           RETURNING id::text`,
          [`split-${part.number}`, String(part.number), part.date, part.amount],
        )
      ).rows[0]!;
      remoteIds.push(remote.id);
      await getPool().query(
        `INSERT INTO aruba_document_matches
          (remote_document_id, status, method, matcher_version, candidates_json)
         VALUES ($1, 'UNMATCHED', 'NONE', $2, '[]')`,
        [remote.id, ARUBA_MATCHER_VERSION],
      );
      await getPool().query(
        `INSERT INTO aruba_remote_observations
          (remote_document_id, sync_session_id, remote_status, stream, scan_ordinal,
           page_ordinal, payload_digest, payload_json)
         VALUES ($1, '00000000-0000-4000-8000-000000000333', 'DELIVERED',
           'invoices:2026', 1, $2, repeat('d', 64), $3)`,
        [
          remote.id,
          part.number,
          JSON.stringify({
            remoteId: `split-${part.number}`,
            documentType: "TD01",
            fiscalYear: 2026,
            series: "FPR",
            fiscalNumber: String(part.number),
            documentDate: part.date,
            recipientName: "MARIO ROSSI",
            recipientTaxId: "RSSMRA80A01H501U",
            recipientTaxIdentifiers: [],
            recipientCountryCode: "IT",
            recipientAddress: "Via Cliente 2 00100 Roma IT",
            totalAmount: part.amount,
            currency: "EUR",
            status: "DELIVERED",
            providerObservedAt: null,
            xmlSha256: null,
            orderReferences: [],
          }),
        ],
      );
    }
    const storeOfficialXml = async (index: number) => {
      const part = parts[index]!;
      const digest = createHash("sha256").update(part.xml).digest("hex");
      const relativePath = `aruba/split/${part.number}.xml`;
      await mkdir(path.dirname(path.join(storageRoot, relativePath)), { recursive: true });
      await writeFile(path.join(storageRoot, relativePath), part.xml, { mode: 0o600 });
      const storage = (
        await getPool().query<{ id: string }>(
          `INSERT INTO storage_objects (kind, relative_path, sha256, size_bytes, content_type)
           VALUES ('ARUBA_XML', $1, $2, $3, 'application/xml') RETURNING id::text`,
          [relativePath, digest, Buffer.byteLength(part.xml)],
        )
      ).rows[0]!;
      await getPool().query(
        `INSERT INTO aruba_files (remote_document_id, storage_object_id, kind)
         VALUES ($1, $2, 'ARUBA_XML')`,
        [remoteIds[index], storage.id],
      );
      await getPool().query(`UPDATE aruba_remote_documents SET xml_sha256 = $2 WHERE id = $1`, [
        remoteIds[index],
        digest,
      ]);
    };
    const { reconcileArubaSplitInvoices } = await import("./aruba-split-invoices.server.ts");
    const reconcile = () =>
      withTransaction((client) =>
        reconcileArubaSplitInvoices(client, "MOCK", "synthetic-aruba-account"),
      );

    await storeOfficialXml(1);
    assert.deepEqual(await reconcile(), { materialized: 0, pending: 1 });
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT billing_cases.status, candidates.remote_document_ids::text[] AS remote_ids
           FROM billing_cases
           JOIN aruba_split_invoice_candidates AS candidates
             ON candidates.billing_case_id = billing_cases.id
           WHERE billing_cases.id = $1`,
          [setup.case_id],
        )
      ).rows[0],
      { status: "NEEDS_REVIEW", remote_ids: remoteIds },
    );

    await storeOfficialXml(0);
    assert.deepEqual(await reconcile(), { materialized: 1, pending: 0 });
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT documents.fiscal_number, documents.total_amount,
                  documents.source_total_amount, documents.difference_amount,
                  documents.source_billing_case_id::text AS source_case_id,
                  document_orders.amount, document_orders.split_invoice,
                  matches.status, matches.method,
                  matches.signals_json -> 'splitInvoice' ->> 'orderId' AS split_order_id
           FROM aruba_document_matches AS matches
           JOIN documents ON documents.id = matches.document_id
           JOIN document_orders ON document_orders.document_id = documents.id
           WHERE matches.remote_document_id = ANY($1::bigint[])
           ORDER BY documents.fiscal_number`,
          [remoteIds],
        )
      ).rows,
      parts.map((part) => ({
        fiscal_number: part.number,
        total_amount: part.amount,
        source_total_amount: part.amount,
        difference_amount: 0,
        source_case_id: setup.case_id,
        amount: part.amount,
        split_invoice: true,
        status: "MATCHED",
        method: "AUTOMATIC",
        split_order_id: setup.order_id,
      })),
    );
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT orders.trigger_status, billing_cases.status AS case_status,
                  (SELECT count(*)::integer FROM aruba_split_invoice_candidates) AS pending,
                  EXISTS (SELECT 1 FROM audit_events
                    WHERE action = 'ARUBA_SPLIT_INVOICE_MATCHED'
                      AND entity_id = billing_cases.id::text) AS audited
           FROM orders JOIN billing_cases ON billing_cases.id = $2
           WHERE orders.id = $1`,
          [setup.order_id, setup.case_id],
        )
      ).rows[0],
      { trigger_status: "INVOICED", case_status: "CLOSED", pending: 0, audited: true },
    );
    assert.deepEqual(await reconcile(), { materialized: 0, pending: 0 });
    const firstDocument = (
      await getPool().query<{ document_id: string }>(
        `SELECT document_id::text FROM aruba_document_matches WHERE remote_document_id = $1`,
        [remoteIds[0]],
      )
    ).rows[0]!.document_id;
    assert.equal(
      await withTransaction((client) => materializeLatestOfficialXml(client, remoteIds[0]!, true)),
      firstDocument,
    );
    const unmarkedDraft = (
      await getPool().query<{ id: string }>(
        `INSERT INTO documents
          (billing_case_id, kind, status, document_type, series, document_date,
           fiscal_profile_version, currency, total_amount, source_total_amount,
           difference_amount, draft_version, projection_sha256, payment_status,
           payment_method, recipient_snapshot_json)
         VALUES ($1, 'INVOICE', 'DRAFT', 'TD01', 'FPR', '2026-09-12', 1, 'EUR', 80120, 80120,
           0, 1, repeat('5', 64), 'PAID', 'MP05', $2)
         RETURNING id::text`,
        [setup.case_id, JSON.stringify(customerSnapshot)],
      )
    ).rows[0]!;
    await assert.rejects(
      getPool().query(
        `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
         VALUES ($1, 'INVOICE', $2, 80120)`,
        [unmarkedDraft.id, setup.order_id],
      ),
      /Ordine già collegato a una fattura efficace o modificabile/,
    );
  } finally {
    await closePool();
    await rm(storageRoot, { recursive: true, force: true });
    await database.drop();
  }
});
