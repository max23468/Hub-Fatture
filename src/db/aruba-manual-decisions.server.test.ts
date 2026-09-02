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

test("un importo discordante può essere collegato solo con conferma e resta registrato", async () => {
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
        owner,
      ),
      (error) => error instanceof AppError && error.code === "ARUBA_PROFILE_CONFLICT",
    );
    await decisions.resolveArubaDocumentMatch(
      remote.id,
      order.id,
      "Differenza verificata sul documento ufficiale",
      "confirmed",
      owner,
    );
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT documents.total_amount, documents.source_total_amount,
                  documents.difference_amount, documents.difference_reason,
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
        amount: 12000,
        trigger_status: "INVOICED",
        applied_before_issue: false,
        refund_job: true,
        match_status: "MATCHED",
        match_method: "MANUAL",
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
        matcher_version: 10,
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
         VALUES ($1, 'CREDIT_NOTE', 'DRAFT', 'TD04', 'FPR', '2026-08-11', 1,
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
       SET status = 'PROFILE_CONFLICT', matcher_version = 9
       WHERE remote_document_id = $1`,
      [sharedCreditRemoteId],
    );
    const upgradedDocuments = await withTransaction(async (client) => {
      return upgradeCachedArubaMatcher(client, "MOCK", "synthetic-aruba-account");
    });
    assert.equal(upgradedDocuments, 1);
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT matches.status AS match_status, matches.method, matches.matcher_version,
                  matches.document_id::text, documents.status AS document_status,
                  documents.origin, documents.payment_method,
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
        matcher_version: 10,
        document_id: creditDraft.id,
        document_status: "APPROVED",
        origin: "ARUBA_HISTORY",
        payment_method: "MP08",
        snapshot_payment_method: "MP08",
      },
    );
  } finally {
    await closePool();
    await rm(sharedStorageRoot, { recursive: true, force: true });
    await database.drop();
    sharedDatabase = null;
  }
});
