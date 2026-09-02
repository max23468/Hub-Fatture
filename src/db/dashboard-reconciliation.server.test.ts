import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ARUBA_MATCHER_REPLAY_DOCUMENT_TYPES } from "../aruba-inbound.ts";
import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

const romeTodaySql = `(CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Rome')::date`;

test("i contatori e la riconciliazione Dashboard usano gli stessi gate operativi", async () => {
  const database = await temporaryDatabase("dashboard_reconciliation");
  process.env.APP_ENV = "test";
  process.env.APP_BASE_URL = "http://localhost:8080";
  process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
  process.env.DATABASE_URL = database.connectionString;

  const client = await import("./client.server.ts");
  try {
    await runMigrations({ connectionString: database.connectionString });
    await client
      .getPool()
      .query(
        "INSERT INTO users (username, password_hash, can_approve) VALUES ('Massimo', 'synthetic', true)",
      );
    const profile = JSON.parse(
      await readFile("tests/fixtures/fatturapa/profile.mock.json", "utf8"),
    );
    await client
      .getPool()
      .query("INSERT INTO fiscal_profiles (version, status, profile_json) VALUES (1, 'MOCK', $1)", [
        profile,
      ]);
    const customer = await client.getPool().query<{ id: string }>(
      `INSERT INTO customers
         (kind, match_key, display_name, billing_address_json, source_confidence, review_required)
       VALUES ('PRIVATE_IT', 'dashboard-reconciliation', 'Cliente sintetico', '{}',
               'TAX_ID', false)
       RETURNING id`,
    );
    const cases = await client.getPool().query<{ id: string }>(
      `INSERT INTO billing_cases
         (customer_id, local_order_date, currency, status, customer_snapshot_json,
          fiscal_profile_version)
       VALUES
         ($1, ${romeTodaySql}, 'EUR', 'READY',
          '{"reviewRequired":false,"canonicalProfile":{}}', 1),
         ($1, ${romeTodaySql} - 1, 'EUR', 'READY',
          '{"reviewRequired":false,"canonicalProfile":{}}', 1),
         ($1, ${romeTodaySql} - 2, 'EUR', 'READY',
          '{"reviewRequired":false,"canonicalProfile":{}}', 1),
         ($1, ${romeTodaySql} - 3, 'EUR', 'NEEDS_REVIEW',
          '{"reviewRequired":false,"canonicalProfile":{}}', 1)
       RETURNING id`,
      [customer.rows[0]!.id],
    );
    await client.getPool().query(
      `INSERT INTO documents
         (billing_case_id, kind, status, document_type, series, document_date,
          fiscal_profile_version, currency, total_amount, source_total_amount,
          difference_amount, projection_sha256, payment_status)
       VALUES
         ($1, 'INVOICE', 'DRAFT', 'TD01', 'FPR', ${romeTodaySql},
          1, 'EUR', 1000, 1000, 0, repeat('a', 64), 'PAID'),
         ($2, 'INVOICE', 'DRAFT', 'TD01', 'FPR', ${romeTodaySql} - 1,
          1, 'EUR', 1000, 1000, 0, repeat('b', 64), 'PAID')`,
      [cases.rows[0]!.id, cases.rows[1]!.id],
    );
    await client.getPool().query(
      `INSERT INTO orders
         (provider, external_account_id, external_order_id, display_number,
          created_at_source, updated_at_source, local_order_date, currency, gross_amount,
          payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
          raw_snapshot_json, normalized_snapshot_json)
       VALUES
         ('SHOPIFY', 'dashboard-test', 'pending-review', '#PENDING', now(), now(),
          ${romeTodaySql} - 3, 'EUR', 1000, 'PENDING', 'FULFILLED', 'NEEDS_REVIEW', $1, $2, '{}',
          '{"orderReviewRequired":true,"deferredReviewRequired":false,"totalsReconciled":true,
            "customerSnapshot":{"canonicalProfile":{}}}')`,
      [customer.rows[0]!.id, cases.rows[3]!.id],
    );

    const orders = {
      ...(await import("./billing-cases.server.ts")),
      ...(await import("./order-queries.server.ts")),
    };
    const documents = await import("./document-mass-approval.server.ts");
    const initialSummary = await orders.dashboardSummary();
    assert.equal(initialSummary.ready_cases, "1");
    assert.equal(initialSummary.review_cases, "0");
    assert.equal(initialSummary.pending_cases, "1");
    assert.deepEqual(
      (
        await orders.listBillingCases({
          operationalPool: "PENDING_PAYMENT",
        })
      ).rows.map(({ id, operational_pool }) => ({ id, operational_pool })),
      [{ id: cases.rows[3]!.id, operational_pool: "PENDING_PAYMENT" }],
    );
    assert.deepEqual(
      (
        await orders.listBillingCases({
          operationalPool: "APPROVABLE",
        })
      ).rows.map(({ id, operational_pool }) => ({ id, operational_pool })),
      [{ id: cases.rows[0]!.id, operational_pool: "APPROVABLE" }],
    );
    assert.deepEqual(
      (
        await orders.listBillingCases({
          operationalPool: "REQUIRES_ACTION",
        })
      ).rows.map(({ id, operational_pool }) => ({ id, operational_pool })),
      [
        { id: cases.rows[1]!.id, operational_pool: "REQUIRES_ACTION" },
        { id: cases.rows[2]!.id, operational_pool: "REQUIRES_ACTION" },
      ],
    );
    assert.deepEqual(
      (await documents.listMassApprovalCandidates()).map(({ billing_case_id }) => billing_case_id),
      [cases.rows[0]!.id],
    );
    await client.getPool().query(
      `INSERT INTO aruba_batches
         (id, environment, mode, transport, account_reference, manifest_sha256,
          document_count, status, requires_reconciliation, created_by)
       VALUES
         ('00000000-0000-4000-8000-000000000101', 'MOCK', 'DOCUMENT_ONLY', 'API',
          'synthetic-aruba-account', repeat('1', 64), 1, 'DRY_RUN_VALIDATED', false,
          (SELECT id FROM users ORDER BY id LIMIT 1)),
         ('00000000-0000-4000-8000-000000000102', 'MOCK', 'DOCUMENT_ONLY', 'API',
          'synthetic-aruba-account', repeat('2', 64), 1, 'RECONCILIATION_REQUIRED', true,
          (SELECT id FROM users ORDER BY id LIMIT 1))`,
    );
    assert.equal((await orders.dashboardSummary()).aruba_batches_requiring_attention, "1");

    const order = await client.getPool().query<{ id: string }>(
      `INSERT INTO orders
         (provider, external_account_id, external_order_id, display_number,
          created_at_source, updated_at_source, local_order_date, currency, gross_amount,
          payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
          raw_snapshot_json, normalized_snapshot_json)
       VALUES
         ('SHOPIFY', 'dashboard-test', 'weak-aruba-candidate', '#WEAK', now(), now(),
          ${romeTodaySql} - 2, 'EUR', 1000, 'PAID', 'FULFILLED', 'GROUPED', $1, $2, '{}',
          '{"orderReviewRequired":false,"deferredReviewRequired":false,"totalsReconciled":true,
            "customerSnapshot":{"canonicalProfile":{}}}')
       RETURNING id`,
      [customer.rows[0]!.id, cases.rows[2]!.id],
    );
    const remote = await client.getPool().query<{ id: string }>(
      `INSERT INTO aruba_remote_documents
         (environment, account_reference, remote_id, document_type, fiscal_year,
          document_date, total_amount, remote_status, remote_status_observed_at,
          metadata_digest, automatic_source, provider_group_id)
       VALUES ('MOCK', 'synthetic-aruba-account', 'weak-official-match', 'TD01', 2026,
               ${romeTodaySql} - 2, 1000, 'DELIVERED', now(), repeat('c', 64),
               'API', 'weak-official-match')
       RETURNING id`,
    );
    await client.getPool().query(
      `INSERT INTO aruba_document_matches
         (remote_document_id, status, method, matcher_version, candidates_json)
       VALUES ($1, 'AMBIGUOUS', 'NONE', 1,
         jsonb_build_array(jsonb_build_object(
           'candidateId', $2::text, 'probe', true, 'potential', true,
           'compatible', false, 'signals', '{}'::jsonb)))`,
      [remote.rows[0]!.id, order.rows[0]!.id],
    );

    const inventory = await import("./aruba-inventory-health.server.ts");
    const inventoryPolicy = await import("../aruba-inventory.ts");
    const scopedConflictHealth = await inventory.getArubaInventoryHealth();
    assert.equal(scopedConflictHealth.ambiguous, 1);
    assert.equal(
      inventoryPolicy.arubaInventoryBlocksAllApprovals({
        blockingReason: "CONFLICT",
        uncertainRemoteStates: scopedConflictHealth.uncertainRemoteStates,
      }),
      false,
    );
    assert.equal(
      inventoryPolicy.arubaInventoryBlocksAllApprovals({
        blockingReason: "CONFLICT",
        uncertainRemoteStates: 1,
      }),
      true,
    );

    const status = await import("./billing-case-status.server.ts");
    const transaction = await client.getPool().connect();
    try {
      await transaction.query("BEGIN");
      assert.equal(
        await status.recomputeBillingCaseStatus(transaction, cases.rows[2]!.id),
        "NEEDS_REVIEW",
      );
      await transaction.query("COMMIT");
    } finally {
      transaction.release();
    }
    assert.deepEqual((await orders.getBillingCase(cases.rows[2]!.id))!.anomalies, [
      "ARUBA_POTENTIAL_MATCH",
    ]);
    assert.equal((await orders.dashboardSummary()).review_cases, "1");
    assert.equal(await orders.getOpenBillingCasePool(cases.rows[0]!.id, false), "APPROVABLE");
    assert.equal(await orders.getOpenBillingCasePool(cases.rows[2]!.id, false), "REQUIRES_ACTION");
    assert.equal(await orders.getOpenBillingCasePool(cases.rows[0]!.id, true), "REQUIRES_ACTION");
    assert.equal(await orders.getOpenBillingCasePool(cases.rows[3]!.id, true), "PENDING_PAYMENT");

    await client
      .getPool()
      .query("UPDATE aruba_remote_documents SET xml_sha256 = repeat('d', 64) WHERE id = $1", [
        remote.rows[0]!.id,
      ]);
    await client.getPool().query(
      `UPDATE aruba_document_matches
       SET candidates_json = jsonb_set(candidates_json, '{0,reviewable}', 'true'::jsonb)
       WHERE remote_document_id = $1`,
      [remote.rows[0]!.id],
    );
    const reconciliation = await client.getPool().connect();
    try {
      await reconciliation.query("BEGIN");
      assert.equal(await status.recomputeOpenBillingCaseStatuses(reconciliation), 0);
      await reconciliation.query("COMMIT");
    } finally {
      reconciliation.release();
    }
    assert.deepEqual((await orders.getBillingCase(cases.rows[2]!.id))!.anomalies, [
      "ARUBA_POTENTIAL_MATCH",
    ]);
    assert.equal((await inventory.getArubaInventoryHealth()).ambiguous, 1);
    const inventoryQueries = await import("./aruba-inventory-queries.server.ts");
    const reviewableRemote = (
      await inventoryQueries.listRemoteDocuments({ attentionOnly: true })
    ).find((document) => document.remote_id === "weak-official-match");
    assert.deepEqual(reviewableRemote?.candidates, [
      {
        id: order.rows[0]!.id,
        label: "Shopify #WEAK",
        guided: true,
        amountMismatch: false,
        externalEvidence: false,
        localAmount: 1000,
        differenceAmount: 0,
      },
    ]);
    assert.deepEqual(
      (
        await inventoryQueries.listRemoteDocuments({
          attentionOnly: true,
          billingCaseId: cases.rows[2]!.id,
        })
      ).map((document) => document.remote_id),
      ["weak-official-match"],
    );
    assert.deepEqual(
      await inventoryQueries.listRemoteDocuments({
        attentionOnly: true,
        billingCaseId: cases.rows[0]!.id,
      }),
      [],
    );

    await client.getPool().query(
      `UPDATE aruba_document_matches
       SET candidates_json = jsonb_set(candidates_json, '{0,reviewable}', 'false'::jsonb)
       WHERE remote_document_id = $1`,
      [remote.rows[0]!.id],
    );
    const resolved = await client.getPool().connect();
    try {
      await resolved.query("BEGIN");
      assert.equal(await status.recomputeOpenBillingCaseStatuses(resolved), 1);
      await resolved.query("COMMIT");
    } finally {
      resolved.release();
    }
    assert.equal((await orders.getBillingCase(cases.rows[2]!.id))!.status, "READY");
    assert.deepEqual((await orders.getBillingCase(cases.rows[2]!.id))!.anomalies, []);
    assert.equal((await inventory.getArubaInventoryHealth()).ambiguous, 0);

    await client
      .getPool()
      .query(
        "UPDATE aruba_remote_documents SET xml_sha256 = NULL, total_amount = 900 WHERE id = $1",
        [remote.rows[0]!.id],
      );
    await client.getPool().query(
      `UPDATE aruba_document_matches
       SET status = 'UNMATCHED',
           candidates_json = jsonb_build_array(jsonb_build_object(
             'candidateId', $2::text, 'probe', false, 'potential', false,
             'compatible', false, 'reviewable', false,
             'signals', jsonb_build_object(
               'provider', true, 'nearDate', true, 'recipient', true, 'total', false)))
       WHERE remote_document_id = $1`,
      [remote.rows[0]!.id, order.rows[0]!.id],
    );
    const identityEvidence = await client.getPool().connect();
    try {
      await identityEvidence.query("BEGIN");
      assert.equal(await status.recomputeOpenBillingCaseStatuses(identityEvidence), 1);
      await identityEvidence.query("COMMIT");
    } finally {
      identityEvidence.release();
    }
    assert.equal((await orders.getBillingCase(cases.rows[2]!.id))!.status, "NEEDS_REVIEW");
    assert.equal((await inventory.getArubaInventoryHealth()).potentialMatches, 1);
    const identityRemote = (
      await inventoryQueries.listRemoteDocuments({
        attentionOnly: true,
        billingCaseId: cases.rows[2]!.id,
      })
    ).find((document) => document.remote_id === "weak-official-match");
    assert.deepEqual(identityRemote?.candidates, [
      {
        id: order.rows[0]!.id,
        label: "Shopify #WEAK",
        guided: true,
        amountMismatch: false,
        externalEvidence: false,
        localAmount: 1000,
        differenceAmount: -100,
      },
    ]);

    await client
      .getPool()
      .query("UPDATE aruba_remote_documents SET xml_sha256 = repeat('d', 64) WHERE id = $1", [
        remote.rows[0]!.id,
      ]);
    const officialStorage = await client.getPool().query<{ id: string }>(
      `INSERT INTO storage_objects (kind, relative_path, sha256, size_bytes, content_type)
       VALUES ('ARUBA_XML', 'synthetic/amount-mismatch.xml', repeat('d', 64), 10,
               'application/xml')
       RETURNING id`,
    );
    await client.getPool().query(
      `INSERT INTO aruba_files (remote_document_id, storage_object_id, kind)
       VALUES ($1, $2, 'ARUBA_XML')`,
      [remote.rows[0]!.id, officialStorage.rows[0]!.id],
    );
    const officialEvidence = await client.getPool().connect();
    try {
      await officialEvidence.query("BEGIN");
      assert.equal(await status.recomputeOpenBillingCaseStatuses(officialEvidence), 0);
      await officialEvidence.query("COMMIT");
    } finally {
      officialEvidence.release();
    }
    assert.equal((await orders.getBillingCase(cases.rows[2]!.id))!.status, "NEEDS_REVIEW");
    assert.equal((await inventory.getArubaInventoryHealth()).potentialMatches, 0);
    assert.equal(await orders.getOpenBillingCasePool(cases.rows[0]!.id, false), "APPROVABLE");
    assert.equal(await orders.getOpenBillingCasePool(cases.rows[2]!.id, false), "REQUIRES_ACTION");
    const mismatchRemote = (
      await inventoryQueries.listRemoteDocuments({
        attentionOnly: true,
        billingCaseId: cases.rows[2]!.id,
      })
    ).find((document) => document.remote_id === "weak-official-match");
    assert.equal(mismatchRemote?.amount_mismatch, true);
    assert.deepEqual(mismatchRemote?.candidates, [
      {
        id: order.rows[0]!.id,
        label: "Shopify #WEAK",
        guided: false,
        amountMismatch: true,
        externalEvidence: false,
        localAmount: 1000,
        differenceAmount: -100,
      },
    ]);
    const operationalControls = await import("./operational-controls.server.ts");
    await operationalControls.refreshOperationalControls();
    const mismatchControl = (
      await operationalControls.readOperationalControls({ origin: "DOCUMENTS" })
    ).rows.find((control) => control.source_id === remote.rows[0]!.id);
    assert.equal(mismatchControl?.kind, "ARUBA_AMOUNT_MISMATCH");
    assert.equal(mismatchControl?.primary_action, "Verifica documento Aruba");
    assert.ok(
      mismatchControl?.metadata_json.facts?.some(
        (fact) => fact.label === "Totale" && fact.value === "9,00 €",
      ),
    );
    assert.ok(
      mismatchControl?.metadata_json.facts?.some(
        (fact) => fact.label === "Shopify #WEAK" && fact.value.includes("-1,00 €"),
      ),
    );

    await client.getPool().query(
      `UPDATE aruba_document_matches
       SET candidates_json = jsonb_set(
         candidates_json, '{0,issuedInvoiceDocumentId}', to_jsonb('42'::text))
       WHERE remote_document_id = $1`,
      [remote.rows[0]!.id],
    );
    assert.equal(
      (
        await inventoryQueries.listRemoteDocuments({
          attentionOnly: true,
          billingCaseId: cases.rows[2]!.id,
        })
      ).some((document) => document.remote_id === "weak-official-match"),
      false,
    );
    const alreadyIssued = await client.getPool().connect();
    try {
      await alreadyIssued.query("BEGIN");
      assert.equal(await status.recomputeOpenBillingCaseStatuses(alreadyIssued), 1);
      await alreadyIssued.query("COMMIT");
    } finally {
      alreadyIssued.release();
    }
    assert.equal(await orders.getOpenBillingCasePool(cases.rows[2]!.id, false), "APPROVABLE");
    await operationalControls.refreshOperationalControls();
    assert.equal(
      (await operationalControls.readOperationalControls({ origin: "DOCUMENTS" })).rows.some(
        (control) => control.source_id === remote.rows[0]!.id,
      ),
      false,
    );

    await client.getPool().query(
      `UPDATE aruba_document_matches
       SET candidates_json = candidates_json #- '{0,issuedInvoiceDocumentId}'
       WHERE remote_document_id = $1`,
      [remote.rows[0]!.id],
    );
    const restoredMismatch = await client.getPool().connect();
    try {
      await restoredMismatch.query("BEGIN");
      assert.equal(await status.recomputeOpenBillingCaseStatuses(restoredMismatch), 1);
      await restoredMismatch.query("COMMIT");
    } finally {
      restoredMismatch.release();
    }
    assert.equal(await orders.getOpenBillingCasePool(cases.rows[2]!.id, false), "REQUIRES_ACTION");

    await client.getPool().query(
      `UPDATE aruba_document_matches
       SET candidates_json = jsonb_set(
         candidates_json, '{0,signals,recipient}', 'false'::jsonb)
       WHERE remote_document_id = $1`,
      [remote.rows[0]!.id],
    );
    const disprovedCandidate = await client.getPool().connect();
    try {
      await disprovedCandidate.query("BEGIN");
      assert.equal(await status.recomputeOpenBillingCaseStatuses(disprovedCandidate), 1);
      await disprovedCandidate.query("COMMIT");
    } finally {
      disprovedCandidate.release();
    }
    assert.equal((await orders.getBillingCase(cases.rows[2]!.id))!.status, "READY");

    await client
      .getPool()
      .query(`UPDATE aruba_remote_documents SET total_amount = 1000 WHERE id = $1`, [
        remote.rows[0]!.id,
      ]);
    await client.getPool().query(
      `UPDATE aruba_document_matches
       SET candidates_json = jsonb_build_array(jsonb_build_object(
         'candidateId', $2::text, 'orderIds', jsonb_build_array($2::text),
         'probe', true, 'potential', false, 'compatible', false, 'reviewable', false,
         'signals', jsonb_build_object(
           'provider', true, 'sameDay', true, 'nearDate', true, 'recipient', false,
           'taxId', false, 'address', false, 'total', true, 'refundTimingClear', true)))
       WHERE remote_document_id = $1`,
      [remote.rows[0]!.id, order.rows[0]!.id],
    );
    const externalEvidenceRemote = (
      await inventoryQueries.listRemoteDocuments({
        attentionOnly: true,
        billingCaseId: cases.rows[2]!.id,
      })
    ).find((document) => document.remote_id === "weak-official-match");
    assert.equal(externalEvidenceRemote?.external_evidence, true);
    assert.equal(externalEvidenceRemote?.requires_control, false);
    assert.deepEqual(externalEvidenceRemote?.candidates, [
      {
        id: order.rows[0]!.id,
        label: "Shopify #WEAK",
        guided: false,
        amountMismatch: false,
        externalEvidence: true,
        localAmount: 1000,
        differenceAmount: 0,
      },
    ]);
    assert.equal(await orders.getOpenBillingCasePool(cases.rows[2]!.id, false), "APPROVABLE");
    await operationalControls.refreshOperationalControls();
    const externalEvidenceControl = (
      await operationalControls.readOperationalControls({ origin: "DOCUMENTS" })
    ).rows.find((control) => control.source_id === remote.rows[0]!.id);
    assert.equal(externalEvidenceControl?.kind, "ARUBA_EXTERNAL_EVIDENCE");
    assert.equal(externalEvidenceControl?.severity, "IMPORTANT");
    assert.equal(externalEvidenceControl?.primary_action, "Registra conferma esterna");

    await client.getPool().query(
      `UPDATE aruba_document_matches
       SET candidates_json = jsonb_set(
         jsonb_set(candidates_json, '{0,probe}', 'false'::jsonb),
         '{0,signals,total}', 'false'::jsonb)
       WHERE remote_document_id = $1`,
      [remote.rows[0]!.id],
    );

    await client
      .getPool()
      .query("DELETE FROM aruba_files WHERE remote_document_id = $1", [remote.rows[0]!.id]);
    await client
      .getPool()
      .query("DELETE FROM storage_objects WHERE id = $1", [officialStorage.rows[0]!.id]);

    await client.getPool().query(
      `UPDATE aruba_document_matches SET matcher_version = 4
       WHERE remote_document_id = $1`,
      [remote.rows[0]!.id],
    );
    await client.getPool().query(
      `INSERT INTO aruba_sync_sessions
         (id, environment, account_reference, status, absolute_expires_at,
          completed_at, source, is_full_scan)
       VALUES ('00000000-0000-4000-8000-000000000201', 'MOCK',
         'synthetic-aruba-account', 'COMPLETED', now() + interval '1 hour',
         now(), 'MANUAL', false)`,
    );
    await client.getPool().query(
      `INSERT INTO aruba_remote_observations
         (remote_document_id, sync_session_id, remote_status, stream,
          scan_ordinal, page_ordinal, payload_digest, payload_json)
       VALUES ($1, '00000000-0000-4000-8000-000000000201', 'DELIVERED',
         'invoices:2026', 1, 1, repeat('e', 64), jsonb_build_object(
           'remoteId', 'weak-official-match', 'documentType', 'TD01',
           'fiscalYear', 2026, 'series', NULL, 'fiscalNumber', NULL,
           'documentDate', to_char(${romeTodaySql} - 2, 'YYYY-MM-DD'),
           'recipientName', 'Cliente sintetico', 'recipientTaxId', NULL,
           'recipientTaxIdentifiers', '[]'::jsonb, 'recipientCountryCode', NULL,
           'recipientAddress', NULL, 'totalAmount', 1000, 'currency', 'EUR',
           'status', 'DELIVERED', 'providerObservedAt', NULL, 'xmlSha256', NULL,
           'orderReferences', '[]'::jsonb
         ))`,
      [remote.rows[0]!.id],
    );
    const upgradeTransaction = await client.getPool().connect();
    try {
      await upgradeTransaction.query("BEGIN");
      const matcherUpgrade = await import("./aruba-matcher-upgrade.server.ts");
      assert.deepEqual([...ARUBA_MATCHER_REPLAY_DOCUMENT_TYPES], ["TD04"]);
      assert.equal(
        await matcherUpgrade.upgradeCachedArubaMatcher(
          upgradeTransaction,
          "MOCK",
          "synthetic-aruba-account",
        ),
        0,
      );
      await upgradeTransaction.query("COMMIT");
    } finally {
      upgradeTransaction.release();
    }
    const upgraded = await client.getPool().query<{
      matcher_version: number;
      reviewable: boolean;
    }>(
      `SELECT matcher_version,
              (candidates_json -> 0 ->> 'reviewable')::boolean AS reviewable
       FROM aruba_document_matches WHERE remote_document_id = $1`,
      [remote.rows[0]!.id],
    );
    assert.deepEqual(upgraded.rows[0], {
      matcher_version: 4,
      reviewable: false,
    });
    assert.equal((await orders.getBillingCase(cases.rows[2]!.id))!.status, "READY");
  } finally {
    await client.closePool();
    await database.drop();
  }
});
