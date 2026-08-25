import assert from "node:assert/strict";
import test from "node:test";

import { remoteInventoryDocumentSchema, remoteMetadataDigest } from "../aruba-inbound.ts";
import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

test("i metadati già estratti dall’helper rivalutano le preparazioni pronte", async () => {
  const fixture = await temporaryDatabase("aruba_metadata_reconciliation");
  try {
    await runMigrations({ connectionString: fixture.connectionString });
    process.env.APP_ENV = "test";
    process.env.APP_BASE_URL = "http://localhost:8080";
    process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
    process.env.DATABASE_URL = fixture.connectionString;
    process.env.ARUBA_ACCOUNT_REFERENCE = "synthetic-aruba-account";

    const database = await import("./client.server.ts");
    const inbound = await import("./aruba-inbound.server.ts");
    const inventoryCycle = await import("./aruba-inventory-cycle.server.ts");
    const billingCases = await import("./billing-cases.server.ts");
    const billingCaseStatus = await import("./billing-case-status.server.ts");
    const user = await database.getPool().query<{ id: string }>(
      `INSERT INTO users (username, password_hash, can_approve)
       VALUES ('Massimo', 'synthetic', true) RETURNING id`,
    );
    const customer = await database.getPool().query<{ id: string }>(
      `INSERT INTO customers
       (kind, match_key, display_name, billing_address_json, source_confidence, review_required)
       VALUES ('PRIVATE_IT', 'cached-aruba-match', 'Nome originario', '{}', 'TAX_ID', false)
       RETURNING id`,
    );
    const billingCase = await database.getPool().query<{ id: string }>(
      `INSERT INTO billing_cases
       (customer_id, local_order_date, currency, status, customer_snapshot_json)
       VALUES ($1, '2026-08-12', 'EUR', 'READY',
         '{"reviewRequired":false,"displayName":"Mario Rossi"}') RETURNING id`,
      [customer.rows[0]!.id],
    );
    const order = await database.getPool().query<{ id: string }>(
      `INSERT INTO orders
        (provider, external_account_id, external_order_id, display_number, created_at_source,
         updated_at_source, local_order_date, currency, gross_amount, payment_status,
         fulfillment_status, trigger_status, customer_id, billing_case_id,
         raw_snapshot_json, normalized_snapshot_json)
       VALUES ('SHOPIFY', 'shop', 'cached-order', '#1001', now(), now(), '2026-08-12',
         'EUR', 5000, 'PAID', 'FULFILLED', 'GROUPED', $1, $2, '{}',
         '{"orderReviewRequired":false}')
       RETURNING id`,
      [customer.rows[0]!.id, billingCase.rows[0]!.id],
    );
    const remote = remoteInventoryDocumentSchema.parse({
      remoteId: "REMOTE-CACHED-METADATA",
      documentType: "TD01",
      fiscalYear: 2026,
      series: "FPR",
      fiscalNumber: "777",
      documentDate: "2026-08-12",
      recipientName: "Mario Rossi",
      recipientTaxId: null,
      recipientTaxIdentifiers: [],
      recipientCountryCode: null,
      recipientAddress: null,
      totalAmount: 5000,
      currency: "EUR",
      status: "DELIVERED",
      providerObservedAt: "2026-08-12T12:00:00+02:00",
      xmlSha256: null,
      orderReferences: [],
    });
    const lateOrderRemote = remoteInventoryDocumentSchema.parse({
      ...remote,
      remoteId: "REMOTE-WAITING-FOR-ORDER",
      fiscalNumber: "778",
      recipientName: "Luigi Bianchi",
      totalAmount: 7000,
    });
    await database.getPool().query(
      `INSERT INTO aruba_sync_sessions
        (id, environment, account_reference, device_id, token_hash, status, started_at,
         absolute_expires_at, completed_at, full_scan_completed_at)
       VALUES ('60000000-0000-4000-8000-000000000001', 'MOCK', 'synthetic-aruba-account',
         'cached-matcher-device', repeat('a', 64), 'COMPLETED', now() - interval '1 hour',
         now(), now(), now())`,
    );
    await database.getPool().query(
      `INSERT INTO aruba_sync_pages
        (sync_session_id, stream, scan_ordinal, page_ordinal, cursor, terminal, full_scan,
         row_count, documents_json, payload_digest)
       VALUES ('60000000-0000-4000-8000-000000000001', 'invoices:2026', 1, 1,
         'invoices:2026:1', true, true, 2, $1, repeat('b', 64))`,
      [JSON.stringify([remote, lateOrderRemote])],
    );
    const remoteRow = await database.getPool().query<{ id: string }>(
      `INSERT INTO aruba_remote_documents
        (environment, account_reference, remote_id, document_type, fiscal_year, series,
         fiscal_number, document_date, total_amount, remote_status,
         remote_status_observed_at, origin, metadata_digest)
       VALUES ('MOCK', 'synthetic-aruba-account', $1, 'TD01', 2026, 'FPR', '777',
         '2026-08-12', 5000, 'DELIVERED', now(), 'ARUBA_EXTERNAL', $2)
       RETURNING id`,
      [remote.remoteId, remoteMetadataDigest(remote)],
    );
    const lateRemoteRow = await database.getPool().query<{ id: string }>(
      `INSERT INTO aruba_remote_documents
        (environment, account_reference, remote_id, document_type, fiscal_year, series,
         fiscal_number, document_date, total_amount, remote_status,
         remote_status_observed_at, origin, metadata_digest)
       VALUES ('MOCK', 'synthetic-aruba-account', $1, 'TD01', 2026, 'FPR', '778',
         '2026-08-12', 7000, 'DELIVERED', now(), 'ARUBA_EXTERNAL', $2)
       RETURNING id`,
      [lateOrderRemote.remoteId, remoteMetadataDigest(lateOrderRemote)],
    );
    await database.getPool().query(
      `INSERT INTO aruba_remote_observations
        (remote_document_id, sync_session_id, remote_status, stream, scan_ordinal,
         page_ordinal, cursor, payload_digest)
       VALUES ($1, '60000000-0000-4000-8000-000000000001', 'DELIVERED',
         'invoices:2026', 1, 1, 'invoices:2026:1', $2)`,
      [remoteRow.rows[0]!.id, remoteMetadataDigest(remote)],
    );
    await database.getPool().query(
      `INSERT INTO aruba_remote_observations
        (remote_document_id, sync_session_id, remote_status, stream, scan_ordinal,
         page_ordinal, cursor, payload_digest)
       VALUES ($1, '60000000-0000-4000-8000-000000000001', 'DELIVERED',
         'invoices:2026', 1, 1, 'invoices:2026:1', $2)`,
      [lateRemoteRow.rows[0]!.id, remoteMetadataDigest(lateOrderRemote)],
    );
    await database.getPool().query(
      `INSERT INTO aruba_document_matches
        (remote_document_id, status, method, matcher_version, candidates_json)
       VALUES ($1, 'UNMATCHED', 'NONE', 1, '[]')`,
      [remoteRow.rows[0]!.id],
    );
    await database.getPool().query(
      `INSERT INTO aruba_document_matches
        (remote_document_id, status, method, matcher_version, candidates_json)
       VALUES ($1, 'UNMATCHED', 'NONE', 1, '[]')`,
      [lateRemoteRow.rows[0]!.id],
    );
    await database.getPool().query(
      `UPDATE aruba_sync_sessions SET full_scan_completed_at = now()
       WHERE id = '60000000-0000-4000-8000-000000000001'`,
    );

    const actor = {
      id: Number(user.rows[0]!.id),
      canApprove: true,
      requestId: "cached-matcher-upgrade-test",
    };
    await inbound.issueArubaReadSession("cached-matcher-device-2", actor);

    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT matches.status, matches.matcher_version,
                  EXISTS (
                    SELECT 1 FROM jsonb_array_elements(matches.candidates_json) candidate
                    WHERE candidate ->> 'candidateId' = $2
                      AND coalesce((candidate ->> 'potential')::boolean, false)
                  ) AS potential
           FROM aruba_document_matches matches
           WHERE matches.remote_document_id = $1`,
          [remoteRow.rows[0]!.id, order.rows[0]!.id],
        )
      ).rows[0],
      { status: "UNMATCHED", matcher_version: 2, potential: true },
    );
    assert.equal(
      (
        await database
          .getPool()
          .query("SELECT status FROM billing_cases WHERE id = $1", [billingCase.rows[0]!.id])
      ).rows[0].status,
      "NEEDS_REVIEW",
    );
    assert.equal((await inbound.getArubaInventoryHealth()).potentialMatches, 1);
    assert.ok(
      (await billingCases.getBillingCase(billingCase.rows[0]!.id))?.anomalies.includes(
        "ARUBA_POTENTIAL_MATCH",
      ),
    );
    assert.deepEqual(
      (await inbound.listRemoteDocuments()).find(
        (document) => document.remote_id === remote.remoteId,
      )?.candidates,
      [],
      "un candidato solo potenziale non viene proposto come collegamento manuale",
    );
    const stableRevision = (
      await database
        .getPool()
        .query("SELECT revision FROM billing_cases WHERE id = $1", [billingCase.rows[0]!.id])
    ).rows[0].revision;
    await database.withTransaction((client) =>
      billingCaseStatus.recomputeBillingCaseStatus(client, billingCase.rows[0]!.id, true),
    );
    assert.deepEqual(
      (
        await database
          .getPool()
          .query("SELECT status, revision FROM billing_cases WHERE id = $1", [
            billingCase.rows[0]!.id,
          ])
      ).rows[0],
      { status: "NEEDS_REVIEW", revision: stableRevision },
      "un ricalcolo ordinario conserva il possibile match Aruba ancora aperto",
    );
    assert.equal(
      (
        await database.getPool().query(
          `SELECT matcher_version FROM aruba_document_matches
           WHERE remote_document_id = $1`,
          [lateRemoteRow.rows[0]!.id],
        )
      ).rows[0].matcher_version,
      1,
      "la cache senza candidati resta rivalutabile quando l’ordine arriva più tardi",
    );

    const secondCustomer = await database.getPool().query<{ id: string }>(
      `INSERT INTO customers
        (kind, match_key, display_name, billing_address_json, source_confidence, review_required)
       VALUES ('PRIVATE_IT', 'cached-aruba-match-2', 'Altro nome originario', '{}',
         'TAX_ID', false) RETURNING id`,
    );
    const secondBillingCase = await database.getPool().query<{ id: string }>(
      `INSERT INTO billing_cases
        (customer_id, local_order_date, currency, status, customer_snapshot_json)
       VALUES ($1, '2026-08-12', 'EUR', 'READY',
         '{"reviewRequired":false,"displayName":"Mario Rossi"}') RETURNING id`,
      [secondCustomer.rows[0]!.id],
    );
    const secondOrder = await database.getPool().query<{ id: string }>(
      `INSERT INTO orders
        (provider, external_account_id, external_order_id, display_number, created_at_source,
         updated_at_source, local_order_date, currency, gross_amount, payment_status,
         fulfillment_status, trigger_status, customer_id, billing_case_id,
         raw_snapshot_json, normalized_snapshot_json)
       VALUES ('SHOPIFY', 'shop', 'cached-order-2', '#1002', now(), now(), '2026-08-12',
         'EUR', 5000, 'PAID', 'FULFILLED', 'GROUPED', $1, $2, '{}',
         '{"orderReviewRequired":false}') RETURNING id`,
      [secondCustomer.rows[0]!.id, secondBillingCase.rows[0]!.id],
    );
    assert.equal(await inbound.revokeArubaReadSessions(actor), 1);
    let issued = await inbound.issueArubaReadSession("cached-matcher-device-3", actor);
    assert.equal(
      (
        await database
          .getPool()
          .query(`SELECT status FROM aruba_document_matches WHERE remote_document_id = $1`, [
            remoteRow.rows[0]!.id,
          ])
      ).rows[0].status,
      "AMBIGUOUS",
      "un nuovo candidato rivaluta anche un match già classificato con la versione corrente",
    );
    assert.equal(
      (
        await database
          .getPool()
          .query("SELECT status FROM billing_cases WHERE id = $1", [secondBillingCase.rows[0]!.id])
      ).rows[0].status,
      "NEEDS_REVIEW",
    );
    await database
      .getPool()
      .query(`UPDATE aruba_remote_documents SET remote_status = 'SUBMITTED' WHERE id = $1`, [
        remoteRow.rows[0]!.id,
      ]);
    await database.getPool().query(
      `UPDATE aruba_document_matches
       SET candidates_json = (
         SELECT jsonb_agg(jsonb_set(candidate, '{compatible}', 'true'))
         FROM jsonb_array_elements(candidates_json) candidate
       )
       WHERE remote_document_id = $1`,
      [remoteRow.rows[0]!.id],
    );
    await inbound.resolveArubaDocumentMatch(
      remoteRow.rows[0]!.id,
      order.rows[0]!.id,
      "Candidato verificato manualmente sui metadati ufficiali",
      actor,
    );
    assert.deepEqual(
      (
        await database
          .getPool()
          .query<{ status: string }>(
            `SELECT status FROM billing_cases WHERE id = ANY($1::bigint[]) ORDER BY id`,
            [[billingCase.rows[0]!.id, secondBillingCase.rows[0]!.id]],
          )
      ).rows.map((row) => row.status),
      ["READY", "READY"],
      "il collegamento manuale ricalcola anche le preparazioni candidate non selezionate",
    );
    await database
      .getPool()
      .query(`UPDATE aruba_remote_documents SET remote_status = 'DELIVERED' WHERE id = $1`, [
        remoteRow.rows[0]!.id,
      ]);
    await database.getPool().query(
      `UPDATE aruba_document_matches
       SET status = 'AMBIGUOUS', method = 'NONE', order_id = NULL, billing_case_id = NULL,
           decided_by = NULL, decision_reason = NULL, decided_at = NULL
       WHERE remote_document_id = $1`,
      [remoteRow.rows[0]!.id],
    );
    await database.getPool().query(
      `UPDATE orders SET local_order_date = '2026-01-01'
       WHERE id = $1`,
      [secondOrder.rows[0]!.id],
    );
    assert.equal(await inbound.revokeArubaReadSessions(actor), 1);
    issued = await inbound.issueArubaReadSession("cached-matcher-device-4", actor);
    assert.equal(
      (
        await database
          .getPool()
          .query(`SELECT status FROM aruba_document_matches WHERE remote_document_id = $1`, [
            remoteRow.rows[0]!.id,
          ])
      ).rows[0].status,
      "UNMATCHED",
      "la scomparsa di un candidato rivaluta il match già classificato",
    );
    assert.equal(
      (
        await database
          .getPool()
          .query("SELECT status FROM billing_cases WHERE id = $1", [secondBillingCase.rows[0]!.id])
      ).rows[0].status,
      "READY",
      "la preparazione rimossa dai candidati perde il blocco Aruba",
    );

    assert.deepEqual(
      await inbound.verifyArubaInventoryAccount(issued.token, { documents: [remote] }),
      { verified: true, initialPairing: false },
    );
    const manifest = await inventoryCycle.arubaInventoryManifest(issued.token);
    for (const [index, stream] of manifest.streams.entries()) {
      await inbound.ingestArubaInventoryPage(issued.token, {
        stream: stream.name,
        scanOrdinal: 1,
        pageOrdinal: 1,
        cursor: `${stream.name}:${index + 1}`,
        terminal: true,
        fullScan: true,
        documents: [],
      });
    }
    await inventoryCycle.completeStableArubaInventory(
      issued.token,
      manifest.streams.map((stream) => stream.name),
      1,
      true,
    );
    assert.deepEqual(
      (
        await database.getPool().query(
          `SELECT status, matcher_version FROM aruba_document_matches
           WHERE remote_document_id = $1`,
          [remoteRow.rows[0]!.id],
        )
      ).rows[0],
      { status: "UNKNOWN_REMOTE_STATE", matcher_version: 2 },
    );
    await database.getPool().query(
      `UPDATE aruba_document_matches
       SET status = 'UNMATCHED', method = 'NONE'
       WHERE remote_document_id = $1`,
      [remoteRow.rows[0]!.id],
    );
    const xmlStorage = await database.getPool().query<{ id: string }>(
      `INSERT INTO storage_objects (kind, relative_path, sha256, size_bytes, content_type)
       VALUES ('ARUBA_XML', 'aruba/cached-metadata.xml', repeat('c', 64), 100,
         'application/xml') RETURNING id`,
    );
    await database.getPool().query(
      `INSERT INTO aruba_files (remote_document_id, storage_object_id, kind)
       VALUES ($1, $2, 'ARUBA_XML')`,
      [remoteRow.rows[0]!.id, xmlStorage.rows[0]!.id],
    );
    await inbound.confirmArubaDocumentOutOfScope(
      remoteRow.rows[0]!.id,
      "Documento verificato come vendita esterna ai canali gestiti dall’applicazione",
      { id: Number(user.rows[0]!.id), canApprove: true, requestId: "out-of-scope-test" },
    );
    assert.equal(
      (
        await database
          .getPool()
          .query("SELECT status FROM billing_cases WHERE id = $1", [billingCase.rows[0]!.id])
      ).rows[0].status,
      "READY",
    );
    assert.equal(
      (await billingCases.getBillingCase(billingCase.rows[0]!.id))?.anomalies.includes(
        "ARUBA_POTENTIAL_MATCH",
      ),
      false,
    );
    assert.equal(
      (
        await database
          .getPool()
          .query("SELECT status FROM billing_cases WHERE id = $1", [secondBillingCase.rows[0]!.id])
      ).rows[0].status,
      "READY",
    );
    await inbound.ingestArubaInventoryPage(issued.token, {
      stream: "invoices:2026",
      scanOrdinal: 2,
      pageOrdinal: 1,
      cursor: "invoices:2026:rejected",
      terminal: true,
      fullScan: false,
      documents: [
        {
          ...remote,
          remoteId: "REMOTE-REJECTED-METADATA",
          fiscalNumber: "779",
          status: "SUBMITTED",
        },
      ],
    });
    assert.equal(
      (
        await database
          .getPool()
          .query("SELECT status FROM billing_cases WHERE id = $1", [billingCase.rows[0]!.id])
      ).rows[0].status,
      "NEEDS_REVIEW",
    );
    await database.getPool().query(
      `UPDATE aruba_document_matches AS matches
       SET status = 'MATCHED', method = 'AUTOMATIC', billing_case_id = $1,
           candidates_json = jsonb_set(candidates_json, '{0,compatible}', 'true')
       FROM aruba_remote_documents AS remote
       WHERE matches.remote_document_id = remote.id
         AND remote.remote_id = 'REMOTE-REJECTED-METADATA'`,
      [billingCase.rows[0]!.id],
    );
    await database.withTransaction((client) =>
      billingCaseStatus.recomputeBillingCaseStatus(client, billingCase.rows[0]!.id),
    );
    assert.equal(
      (
        await database
          .getPool()
          .query("SELECT status FROM billing_cases WHERE id = $1", [billingCase.rows[0]!.id])
      ).rows[0].status,
      "NEEDS_REVIEW",
      "un match non terminale resta bloccante anche se è compatibile",
    );
    await inbound.ingestArubaInventoryPage(issued.token, {
      stream: "invoices:2026",
      scanOrdinal: 3,
      pageOrdinal: 1,
      cursor: "invoices:2026:rejected",
      terminal: true,
      fullScan: false,
      documents: [
        {
          ...remote,
          remoteId: "REMOTE-REJECTED-METADATA",
          fiscalNumber: "779",
          status: "REJECTED",
        },
      ],
    });
    await database.withTransaction((client) =>
      billingCaseStatus.recomputeBillingCaseStatus(client, billingCase.rows[0]!.id),
    );
    assert.equal(
      (
        await database
          .getPool()
          .query("SELECT status FROM billing_cases WHERE id = $1", [billingCase.rows[0]!.id])
      ).rows[0].status,
      "READY",
      "un tentativo Aruba scartato non trattiene la preparazione",
    );
  } finally {
    const database = await import("./client.server.ts");
    await database.closePool();
    await fixture.drop();
  }
});
