import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import pg from "pg";

import { documentInputSchema } from "../documents.ts";
import { sortedMigrationFileNames } from "../migration-files.ts";
import { runMigrations } from "./migrations.server.ts";

import { temporaryDatabase, withClient } from "./database-fixture.ts";

const BASELINE = "001_baseline.sql";
const CONNECTORS = "002_connectors.sql";
const CONNECTOR_PRIVACY = "003_connector_privacy.sql";
const CONNECTOR_OPERATIONS = "004_connector_operations.sql";
const DOCUMENTS = "005_documents.sql";
const M4_COMPLETION = "006_m4_completion.sql";
const M4_LEGACY_DOCUMENTS = "007_m4_legacy_documents.sql";
const DOCUMENT_DEPLOY_COMPATIBILITY = "008_document_deploy_compatibility.sql";
const APPROVED_PAYMENT_HISTORY = "009_approved_payment_history.sql";
const DRAFT_RECIPIENT_SNAPSHOT = "010_draft_recipient_snapshot.sql";
const ORDER_MEMBERSHIP_DRAFT_INVALIDATION = "011_order_membership_draft_invalidation.sql";
const ARUBA_INTEGRATION = "012_aruba_integration.sql";
const CREDIT_NOTES_EMAIL = "013_credit_notes_email.sql";
const PRE_ISSUE_REFUNDS = "014_pre_issue_refunds.sql";
const CANONICAL_ACCOUNT_NAMES = "015_canonical_account_names.sql";
const HISTORICAL_ORDER_RECONCILIATION = "016_historical_order_reconciliation.sql";
const HISTORICAL_INVOICE_LINKS = "017_historical_invoice_links.sql";
const LEGACY_WEBHOOK_HISTORY = "018_legacy_webhook_history.sql";
const SHOPIFY_PAYMENT_FEES = "019_shopify_payment_fees.sql";
const CREDIT_NOTE_ORDER_AMOUNTS = "020_credit_note_order_amounts.sql";
const FISCAL_IDENTIFIER_BACKFILL = "021_fiscal_identifier_backfill.sql";
const SHOPIFY_RECIPIENT_RECLASSIFICATION = "022_shopify_recipient_reclassification.sql";
const EBAY_PAYMENT_RECONCILIATION = "023_ebay_payment_reconciliation.sql";
const EBAY_REFUND_DEDUPLICATION = "024_ebay_refund_deduplication.sql";
const RETENTION_POLICY = "025_retention_policy.sql";
const REMOVE_ARUBA_UPLOAD_PROTECTION = "026_remove_aruba_upload_protection.sql";
const CUSTOMER_EMAIL_DISABLED = "027_customer_email_disabled.sql";
const CUSTOMER_REVIEW_CLEANUP = "028_customer_review_cleanup.sql";
const ARUBA_CANARY_PERMIT = "029_aruba_canary_permit.sql";
const ARUBA_INBOUND_RECONCILIATION = "030_aruba_inbound_reconciliation.sql";
const SHOPIFY_SHIPPING_IDENTITY_REPLAY = "031_shopify_shipping_identity_replay.sql";
const REMOVE_ARUBA_SEND_PERMITS = "032_remove_aruba_send_permits.sql";
const SUPPORT_SAFARI_ARUBA_READ_SYNC = "033_support_safari_aruba_read_sync.sql";
const ARUBA_STATUS_MAPPER_VERSION = "034_aruba_status_mapper_version.sql";
const ARUBA_API_INBOUND = "035_aruba_api_inbound.sql";
const ARUBA_REJECTED_ATTEMPT_IDENTITY = "036_aruba_rejected_attempt_identity.sql";
const ARUBA_API_TRAFFIC_GUARD = "037_aruba_api_traffic_guard.sql";
const ARUBA_API_AUTHORITY_CUTOVER = "038_aruba_api_authority_cutover.sql";
const ARUBA_P7M_PARITY_NORMALIZATION = "039_aruba_p7m_parity_normalization.sql";
const ARUBA_API_OUTBOUND = "040_aruba_api_outbound.sql";
const CURRENT_MIGRATIONS = sortedMigrationFileNames(readdirSync("migrations"));
const outboundIndex = CURRENT_MIGRATIONS.indexOf(ARUBA_API_OUTBOUND);
assert.notEqual(outboundIndex, -1, `${ARUBA_API_OUTBOUND} assente dal catalogo migrazioni`);
const MIGRATIONS_AFTER_ARUBA_API_OUTBOUND = CURRENT_MIGRATIONS.slice(outboundIndex + 1);

async function copyMigrationSnapshot(directory: string) {
  await cp("migrations", directory, { recursive: true });
  for (const migration of await readdir(directory)) {
    if (/^\d{3}_.+\.sql$/.test(migration) && migration > ARUBA_REJECTED_ATTEMPT_IDENTITY) {
      await rm(path.join(directory, migration));
    }
  }
  await rm(path.join(directory, SUPPORT_SAFARI_ARUBA_READ_SYNC));
  await rm(path.join(directory, ARUBA_STATUS_MAPPER_VERSION));
  await rm(path.join(directory, ARUBA_API_INBOUND));
  await rm(path.join(directory, ARUBA_REJECTED_ATTEMPT_IDENTITY));
}

test("la migrazione rimuove i permessi Aruba e conserva lo stato pronto", async () => {
  const database = await temporaryDatabase("remove_aruba_send_permits_upgrade");
  const beforeRemoval = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-remove-aruba-send-permits-"),
  );
  try {
    await copyMigrationSnapshot(beforeRemoval);
    await rm(path.join(beforeRemoval, REMOVE_ARUBA_SEND_PERMITS));
    await runMigrations({ connectionString: database.connectionString, directory: beforeRemoval });
    await withClient(database.connectionString, async (client) => {
      const user = await client.query<{ id: number }>(
        `INSERT INTO users (username, password_hash, can_approve)
         VALUES ('Massimo', 'synthetic', true) RETURNING id`,
      );
      const batchId = "10000000-0000-4000-8000-000000000001";
      await client.query(
        `INSERT INTO aruba_batches
          (id, environment, mode, account_reference, manifest_sha256, document_count,
           attempt_number, status, created_by)
         VALUES ($1, 'MOCK', 'AUTOMATIC', 'qualified-account', $2, 1, 1,
                 'PERMIT_CONSUMED', $3)`,
        [batchId, "1".repeat(64), user.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO aruba_send_permits
          (id, batch_id, manifest_sha256, document_count, mode, authorized_by, expires_at)
         VALUES ($1, $2, $3, 1, 'AUTOMATIC', $4, now() + interval '10 minutes')`,
        ["20000000-0000-4000-8000-000000000001", batchId, "1".repeat(64), user.rows[0]!.id],
      );
    });
    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      REMOVE_ARUBA_SEND_PERMITS,
      SUPPORT_SAFARI_ARUBA_READ_SYNC,
      ARUBA_STATUS_MAPPER_VERSION,
      ARUBA_API_INBOUND,
      ARUBA_REJECTED_ATTEMPT_IDENTITY,
      ARUBA_API_TRAFFIC_GUARD,
      ARUBA_API_AUTHORITY_CUTOVER,
      ARUBA_P7M_PARITY_NORMALIZATION,
      ARUBA_API_OUTBOUND,
      ...MIGRATIONS_AFTER_ARUBA_API_OUTBOUND,
    ]);
    await withClient(database.connectionString, async (client) => {
      assert.deepEqual(
        (
          await client.query(
            `SELECT status, to_regclass('aruba_send_permits') AS permits_table
           FROM aruba_batches WHERE id = '10000000-0000-4000-8000-000000000001'`,
          )
        ).rows[0],
        { status: "READY_AUTOMATIC", permits_table: null },
      );
    });
  } finally {
    await rm(beforeRemoval, { recursive: true, force: true });
    await database.drop();
  }
});
test("la migrazione clienti elimina soltanto i profili privi di collegamenti", async () => {
  const database = await temporaryDatabase("customer_review_cleanup_upgrade");
  const beforeCleanup = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-customer-review-cleanup-"),
  );
  try {
    await copyMigrationSnapshot(beforeCleanup);
    await rm(path.join(beforeCleanup, CUSTOMER_REVIEW_CLEANUP));
    await rm(path.join(beforeCleanup, ARUBA_CANARY_PERMIT));
    await rm(path.join(beforeCleanup, ARUBA_INBOUND_RECONCILIATION));
    await rm(path.join(beforeCleanup, SHOPIFY_SHIPPING_IDENTITY_REPLAY));
    await rm(path.join(beforeCleanup, REMOVE_ARUBA_SEND_PERMITS));
    await runMigrations({ connectionString: database.connectionString, directory: beforeCleanup });
    await withClient(database.connectionString, async (client) => {
      const inserted = await client.query<{ id: string; match_key: string }>(
        `INSERT INTO customers
          (kind, match_key, display_name, billing_address_json,
           source_confidence, review_required)
         VALUES
          ('PRIVATE_IT', 'cleanup-orphan', 'Orfano', '{}', 'AMBIGUOUS', true),
          ('PRIVATE_IT', 'cleanup-source', 'Con sorgente', '{}', 'AMBIGUOUS', true)
         RETURNING id, match_key`,
      );
      const sourceCustomer = inserted.rows.find((row) => row.match_key === "cleanup-source")!;
      await client.query(
        `INSERT INTO customer_source_records
          (customer_id, provider, external_customer_id, raw_snapshot_json)
         VALUES ($1, 'SHOPIFY', 'cleanup-source', '{}')`,
        [sourceCustomer.id],
      );
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      CUSTOMER_REVIEW_CLEANUP,
      ARUBA_CANARY_PERMIT,
      ARUBA_INBOUND_RECONCILIATION,
      SHOPIFY_SHIPPING_IDENTITY_REPLAY,
      REMOVE_ARUBA_SEND_PERMITS,
      SUPPORT_SAFARI_ARUBA_READ_SYNC,
      ARUBA_STATUS_MAPPER_VERSION,
      ARUBA_API_INBOUND,
      ARUBA_REJECTED_ATTEMPT_IDENTITY,
      ARUBA_API_TRAFFIC_GUARD,
      ARUBA_API_AUTHORITY_CUTOVER,
      ARUBA_P7M_PARITY_NORMALIZATION,
      ARUBA_API_OUTBOUND,
      ...MIGRATIONS_AFTER_ARUBA_API_OUTBOUND,
    ]);
    await withClient(database.connectionString, async (client) => {
      assert.deepEqual(
        (await client.query("SELECT match_key FROM customers ORDER BY match_key")).rows.map(
          (row) => row.match_key,
        ),
        ["cleanup-source"],
      );
    });
  } finally {
    await rm(beforeCleanup, { recursive: true, force: true });
    await database.drop();
  }
});

test("la migrazione privacy aggiorna un database con i connettori già applicati", async () => {
  const database = await temporaryDatabase("connector_upgrade");
  const firstTwo = await mkdtemp(path.join(os.tmpdir(), "hub-fatture-first-two-"));
  try {
    await copyMigrationSnapshot(firstTwo);
    await rm(path.join(firstTwo, CONNECTOR_PRIVACY));
    await rm(path.join(firstTwo, CONNECTOR_OPERATIONS));
    await rm(path.join(firstTwo, DOCUMENTS));
    await rm(path.join(firstTwo, M4_COMPLETION));
    await rm(path.join(firstTwo, M4_LEGACY_DOCUMENTS));
    await rm(path.join(firstTwo, DOCUMENT_DEPLOY_COMPATIBILITY));
    await rm(path.join(firstTwo, APPROVED_PAYMENT_HISTORY));
    await rm(path.join(firstTwo, DRAFT_RECIPIENT_SNAPSHOT));
    await rm(path.join(firstTwo, ORDER_MEMBERSHIP_DRAFT_INVALIDATION));
    await rm(path.join(firstTwo, ARUBA_INTEGRATION));
    await rm(path.join(firstTwo, CREDIT_NOTES_EMAIL));
    await rm(path.join(firstTwo, PRE_ISSUE_REFUNDS));
    await rm(path.join(firstTwo, CANONICAL_ACCOUNT_NAMES));
    await rm(path.join(firstTwo, HISTORICAL_ORDER_RECONCILIATION));
    await rm(path.join(firstTwo, HISTORICAL_INVOICE_LINKS));
    await rm(path.join(firstTwo, LEGACY_WEBHOOK_HISTORY));
    await rm(path.join(firstTwo, SHOPIFY_PAYMENT_FEES));
    await rm(path.join(firstTwo, CREDIT_NOTE_ORDER_AMOUNTS));
    await rm(path.join(firstTwo, FISCAL_IDENTIFIER_BACKFILL));
    await rm(path.join(firstTwo, SHOPIFY_RECIPIENT_RECLASSIFICATION));
    await rm(path.join(firstTwo, EBAY_PAYMENT_RECONCILIATION));
    await rm(path.join(firstTwo, EBAY_REFUND_DEDUPLICATION));
    await rm(path.join(firstTwo, RETENTION_POLICY));
    await rm(path.join(firstTwo, CUSTOMER_EMAIL_DISABLED));
    await rm(path.join(firstTwo, CUSTOMER_REVIEW_CLEANUP));
    await rm(path.join(firstTwo, ARUBA_CANARY_PERMIT));
    await rm(path.join(firstTwo, ARUBA_INBOUND_RECONCILIATION));
    await rm(path.join(firstTwo, SHOPIFY_SHIPPING_IDENTITY_REPLAY));
    await rm(path.join(firstTwo, REMOVE_ARUBA_SEND_PERMITS));
    await rm(path.join(firstTwo, REMOVE_ARUBA_UPLOAD_PROTECTION));
    assert.deepEqual(
      await runMigrations({ connectionString: database.connectionString, directory: firstTwo }),
      [BASELINE, CONNECTORS],
    );
    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      CONNECTOR_PRIVACY,
      CONNECTOR_OPERATIONS,
      DOCUMENTS,
      M4_COMPLETION,
      M4_LEGACY_DOCUMENTS,
      DOCUMENT_DEPLOY_COMPATIBILITY,
      APPROVED_PAYMENT_HISTORY,
      DRAFT_RECIPIENT_SNAPSHOT,
      ORDER_MEMBERSHIP_DRAFT_INVALIDATION,
      ARUBA_INTEGRATION,
      CREDIT_NOTES_EMAIL,
      PRE_ISSUE_REFUNDS,
      CANONICAL_ACCOUNT_NAMES,
      HISTORICAL_ORDER_RECONCILIATION,
      HISTORICAL_INVOICE_LINKS,
      LEGACY_WEBHOOK_HISTORY,
      SHOPIFY_PAYMENT_FEES,
      CREDIT_NOTE_ORDER_AMOUNTS,
      FISCAL_IDENTIFIER_BACKFILL,
      SHOPIFY_RECIPIENT_RECLASSIFICATION,
      EBAY_PAYMENT_RECONCILIATION,
      EBAY_REFUND_DEDUPLICATION,
      RETENTION_POLICY,
      REMOVE_ARUBA_UPLOAD_PROTECTION,
      CUSTOMER_EMAIL_DISABLED,
      CUSTOMER_REVIEW_CLEANUP,
      ARUBA_CANARY_PERMIT,
      ARUBA_INBOUND_RECONCILIATION,
      SHOPIFY_SHIPPING_IDENTITY_REPLAY,
      REMOVE_ARUBA_SEND_PERMITS,
      SUPPORT_SAFARI_ARUBA_READ_SYNC,
      ARUBA_STATUS_MAPPER_VERSION,
      ARUBA_API_INBOUND,
      ARUBA_REJECTED_ATTEMPT_IDENTITY,
      ARUBA_API_TRAFFIC_GUARD,
      ARUBA_API_AUTHORITY_CUTOVER,
      ARUBA_P7M_PARITY_NORMALIZATION,
      ARUBA_API_OUTBOUND,
      ...MIGRATIONS_AFTER_ARUBA_API_OUTBOUND,
    ]);
  } finally {
    await rm(firstTwo, { recursive: true, force: true });
    await database.drop();
  }
});

test("l'upgrade neutralizza le sincronizzazioni precedenti all'import storico", async () => {
  const database = await temporaryDatabase("historical_import_upgrade");
  const beforeHistoricalImport = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-historical-import-"),
  );
  try {
    await copyMigrationSnapshot(beforeHistoricalImport);
    await rm(path.join(beforeHistoricalImport, HISTORICAL_ORDER_RECONCILIATION));
    await rm(path.join(beforeHistoricalImport, HISTORICAL_INVOICE_LINKS));
    await rm(path.join(beforeHistoricalImport, LEGACY_WEBHOOK_HISTORY));
    await rm(path.join(beforeHistoricalImport, SHOPIFY_PAYMENT_FEES));
    await rm(path.join(beforeHistoricalImport, CREDIT_NOTE_ORDER_AMOUNTS));
    await rm(path.join(beforeHistoricalImport, FISCAL_IDENTIFIER_BACKFILL));
    await rm(path.join(beforeHistoricalImport, SHOPIFY_RECIPIENT_RECLASSIFICATION));
    await rm(path.join(beforeHistoricalImport, EBAY_PAYMENT_RECONCILIATION));
    await rm(path.join(beforeHistoricalImport, EBAY_REFUND_DEDUPLICATION));
    await rm(path.join(beforeHistoricalImport, RETENTION_POLICY));
    await rm(path.join(beforeHistoricalImport, CUSTOMER_EMAIL_DISABLED));
    await rm(path.join(beforeHistoricalImport, CUSTOMER_REVIEW_CLEANUP));
    await rm(path.join(beforeHistoricalImport, ARUBA_CANARY_PERMIT));
    await rm(path.join(beforeHistoricalImport, ARUBA_INBOUND_RECONCILIATION));
    await rm(path.join(beforeHistoricalImport, SHOPIFY_SHIPPING_IDENTITY_REPLAY));
    await rm(path.join(beforeHistoricalImport, REMOVE_ARUBA_SEND_PERMITS));
    await rm(path.join(beforeHistoricalImport, REMOVE_ARUBA_UPLOAD_PROTECTION));
    await runMigrations({
      connectionString: database.connectionString,
      directory: beforeHistoricalImport,
    });
    await withClient(database.connectionString, async (client) => {
      await client.query(
        `INSERT INTO jobs
           (type, status, locked_at, lease_expires_at, locked_by, claim_token)
         VALUES
           ('shopify_sync_orders', 'PENDING', NULL, NULL, NULL, NULL),
           ('ebay_sync_orders', 'RUNNING', now(), now() + interval '2 minutes',
            'worker-pre-upgrade', gen_random_uuid())`,
      );
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      HISTORICAL_ORDER_RECONCILIATION,
      HISTORICAL_INVOICE_LINKS,
      LEGACY_WEBHOOK_HISTORY,
      SHOPIFY_PAYMENT_FEES,
      CREDIT_NOTE_ORDER_AMOUNTS,
      FISCAL_IDENTIFIER_BACKFILL,
      SHOPIFY_RECIPIENT_RECLASSIFICATION,
      EBAY_PAYMENT_RECONCILIATION,
      EBAY_REFUND_DEDUPLICATION,
      RETENTION_POLICY,
      REMOVE_ARUBA_UPLOAD_PROTECTION,
      CUSTOMER_EMAIL_DISABLED,
      CUSTOMER_REVIEW_CLEANUP,
      ARUBA_CANARY_PERMIT,
      ARUBA_INBOUND_RECONCILIATION,
      SHOPIFY_SHIPPING_IDENTITY_REPLAY,
      REMOVE_ARUBA_SEND_PERMITS,
      SUPPORT_SAFARI_ARUBA_READ_SYNC,
      ARUBA_STATUS_MAPPER_VERSION,
      ARUBA_API_INBOUND,
      ARUBA_REJECTED_ATTEMPT_IDENTITY,
      ARUBA_API_TRAFFIC_GUARD,
      ARUBA_API_AUTHORITY_CUTOVER,
      ARUBA_P7M_PARITY_NORMALIZATION,
      ARUBA_API_OUTBOUND,
      ...MIGRATIONS_AFTER_ARUBA_API_OUTBOUND,
    ]);
    await withClient(database.connectionString, async (client) => {
      const jobs = await client.query(
        `SELECT type, status, completed_at IS NOT NULL AS completed,
                lease_expires_at, locked_by, claim_token, result_json
         FROM jobs ORDER BY type`,
      );
      assert.deepEqual(jobs.rows, [
        {
          type: "ebay_sync_orders",
          status: "COMPLETED",
          completed: true,
          lease_expires_at: null,
          locked_by: null,
          claim_token: null,
          result_json: { obsoleteBeforeHistoryImport: true },
        },
        {
          type: "shopify_sync_orders",
          status: "COMPLETED",
          completed: true,
          lease_expires_at: null,
          locked_by: null,
          claim_token: null,
          result_json: { obsoleteBeforeHistoryImport: true },
        },
      ]);
    });
  } finally {
    await rm(beforeHistoricalImport, { recursive: true, force: true });
    await database.drop();
  }
});

test("l'upgrade conserva la classificazione storica dei webhook già accodati", async () => {
  const database = await temporaryDatabase("legacy_webhook_history");
  const beforeClassification = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-webhook-history-"),
  );
  try {
    await copyMigrationSnapshot(beforeClassification);
    await rm(path.join(beforeClassification, LEGACY_WEBHOOK_HISTORY));
    await rm(path.join(beforeClassification, SHOPIFY_PAYMENT_FEES));
    await rm(path.join(beforeClassification, CREDIT_NOTE_ORDER_AMOUNTS));
    await rm(path.join(beforeClassification, FISCAL_IDENTIFIER_BACKFILL));
    await rm(path.join(beforeClassification, SHOPIFY_RECIPIENT_RECLASSIFICATION));
    await rm(path.join(beforeClassification, EBAY_PAYMENT_RECONCILIATION));
    await rm(path.join(beforeClassification, EBAY_REFUND_DEDUPLICATION));
    await rm(path.join(beforeClassification, RETENTION_POLICY));
    await rm(path.join(beforeClassification, CUSTOMER_EMAIL_DISABLED));
    await rm(path.join(beforeClassification, CUSTOMER_REVIEW_CLEANUP));
    await rm(path.join(beforeClassification, ARUBA_CANARY_PERMIT));
    await rm(path.join(beforeClassification, ARUBA_INBOUND_RECONCILIATION));
    await rm(path.join(beforeClassification, SHOPIFY_SHIPPING_IDENTITY_REPLAY));
    await rm(path.join(beforeClassification, REMOVE_ARUBA_SEND_PERMITS));
    await rm(path.join(beforeClassification, REMOVE_ARUBA_UPLOAD_PROTECTION));
    await runMigrations({
      connectionString: database.connectionString,
      directory: beforeClassification,
    });
    await withClient(database.connectionString, async (client) => {
      await client.query(
        `INSERT INTO sync_cursors (provider, stream, cursor, overlap_from, updated_at)
         VALUES ('SHOPIFY', 'history_import', 'ready', '2026-08-12T10:00:00Z',
           '2026-08-12T10:00:00Z')`,
      );
      await client.query(
        `INSERT INTO jobs (type, payload_json, status, created_at)
         VALUES
           ('shopify_process_webhook', '{"orderId":"before"}', 'FAILED',
             '2026-08-12T09:00:00Z'),
           ('shopify_process_webhook', '{"orderId":"after"}', 'PENDING',
             '2026-08-12T11:00:00Z')`,
      );
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      LEGACY_WEBHOOK_HISTORY,
      SHOPIFY_PAYMENT_FEES,
      CREDIT_NOTE_ORDER_AMOUNTS,
      FISCAL_IDENTIFIER_BACKFILL,
      SHOPIFY_RECIPIENT_RECLASSIFICATION,
      EBAY_PAYMENT_RECONCILIATION,
      EBAY_REFUND_DEDUPLICATION,
      RETENTION_POLICY,
      REMOVE_ARUBA_UPLOAD_PROTECTION,
      CUSTOMER_EMAIL_DISABLED,
      CUSTOMER_REVIEW_CLEANUP,
      ARUBA_CANARY_PERMIT,
      ARUBA_INBOUND_RECONCILIATION,
      SHOPIFY_SHIPPING_IDENTITY_REPLAY,
      REMOVE_ARUBA_SEND_PERMITS,
      SUPPORT_SAFARI_ARUBA_READ_SYNC,
      ARUBA_STATUS_MAPPER_VERSION,
      ARUBA_API_INBOUND,
      ARUBA_REJECTED_ATTEMPT_IDENTITY,
      ARUBA_API_TRAFFIC_GUARD,
      ARUBA_API_AUTHORITY_CUTOVER,
      ARUBA_P7M_PARITY_NORMALIZATION,
      ARUBA_API_OUTBOUND,
      ...MIGRATIONS_AFTER_ARUBA_API_OUTBOUND,
    ]);
    await withClient(database.connectionString, async (client) => {
      assert.deepEqual(
        (
          await client.query(
            `SELECT payload_json ->> 'orderId' AS order_id,
                    (payload_json ->> 'historical')::boolean AS historical
             FROM jobs WHERE type = 'shopify_process_webhook' ORDER BY id`,
          )
        ).rows,
        [
          { order_id: "before", historical: true },
          { order_id: "after", historical: true },
        ],
      );
    });
  } finally {
    await rm(beforeClassification, { recursive: true, force: true });
    await database.drop();
  }
});

test("l'upgrade riallinea automaticamente gli identificativi fiscali storici", async () => {
  const database = await temporaryDatabase("fiscal_identifier_backfill");
  const beforeBackfill = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-fiscal-identifier-backfill-"),
  );
  try {
    await copyMigrationSnapshot(beforeBackfill);
    await rm(path.join(beforeBackfill, FISCAL_IDENTIFIER_BACKFILL));
    await rm(path.join(beforeBackfill, SHOPIFY_RECIPIENT_RECLASSIFICATION));
    await rm(path.join(beforeBackfill, EBAY_PAYMENT_RECONCILIATION));
    await rm(path.join(beforeBackfill, EBAY_REFUND_DEDUPLICATION));
    await rm(path.join(beforeBackfill, RETENTION_POLICY));
    await rm(path.join(beforeBackfill, CUSTOMER_EMAIL_DISABLED));
    await rm(path.join(beforeBackfill, CUSTOMER_REVIEW_CLEANUP));
    await rm(path.join(beforeBackfill, ARUBA_CANARY_PERMIT));
    await rm(path.join(beforeBackfill, ARUBA_INBOUND_RECONCILIATION));
    await rm(path.join(beforeBackfill, SHOPIFY_SHIPPING_IDENTITY_REPLAY));
    await rm(path.join(beforeBackfill, REMOVE_ARUBA_SEND_PERMITS));
    await rm(path.join(beforeBackfill, REMOVE_ARUBA_UPLOAD_PROTECTION));
    await runMigrations({ connectionString: database.connectionString, directory: beforeBackfill });
    await withClient(database.connectionString, async (client) => {
      await client.query(
        `INSERT INTO connections
           (provider, environment, account_reference, encrypted_credentials, status,
            last_synced_at)
         VALUES
           ('SHOPIFY', 'PRODUCTION', 'shop.example', 'encrypted', 'CONNECTED', now()),
           ('EBAY', 'PRODUCTION', 'seller', 'encrypted', 'CONNECTED', now())`,
      );
      await client.query(
        `INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
         VALUES
           ('SHOPIFY', 'history_import', 'complete', '2026-01-01T00:00:00Z'),
           ('EBAY', 'history_import', 'complete', '2026-01-01T00:00:00Z'),
           ('SHOPIFY', 'orders', 'recent', '2026-08-12T10:00:00Z'),
           ('EBAY', 'orders', 'older-replay', '2025-12-01T00:00:00Z')`,
      );
      const customerId = (
        await client.query(
          `INSERT INTO customers
             (kind, match_key, display_name, billing_address_json, source_confidence,
              review_required)
           VALUES ('UNKNOWN', 'fiscal-backfill', 'Cliente', '{}', 'AMBIGUOUS', true)
           RETURNING id`,
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO orders
           (provider, external_account_id, external_order_id, display_number,
            created_at_source, updated_at_source, local_order_date, currency, gross_amount,
            payment_status, fulfillment_status, trigger_status, customer_id,
            raw_snapshot_json, normalized_snapshot_json)
         VALUES
           ('SHOPIFY', 'shop.example', 'shop-order', '#S', '2026-01-02T10:00:00Z',
            '2026-01-03T10:00:00Z', '2026-01-02', 'EUR', 1000, 'PAID', 'FULFILLED',
            'ELIGIBLE', $1, '{}', '{}'),
           ('EBAY', 'seller', 'ebay-order', '#E', '2026-02-02T11:00:00Z',
            '2026-02-03T11:00:00Z', '2026-02-02', 'EUR', 2000, 'PAID', 'FULFILLED',
            'ELIGIBLE', $1, '{}', '{}')`,
        [customerId],
      );
      await client.query("INSERT INTO jobs (type) VALUES ('shopify_sync_orders')");
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      FISCAL_IDENTIFIER_BACKFILL,
      SHOPIFY_RECIPIENT_RECLASSIFICATION,
      EBAY_PAYMENT_RECONCILIATION,
      EBAY_REFUND_DEDUPLICATION,
      RETENTION_POLICY,
      REMOVE_ARUBA_UPLOAD_PROTECTION,
      CUSTOMER_EMAIL_DISABLED,
      CUSTOMER_REVIEW_CLEANUP,
      ARUBA_CANARY_PERMIT,
      ARUBA_INBOUND_RECONCILIATION,
      SHOPIFY_SHIPPING_IDENTITY_REPLAY,
      REMOVE_ARUBA_SEND_PERMITS,
      SUPPORT_SAFARI_ARUBA_READ_SYNC,
      ARUBA_STATUS_MAPPER_VERSION,
      ARUBA_API_INBOUND,
      ARUBA_REJECTED_ATTEMPT_IDENTITY,
      ARUBA_API_TRAFFIC_GUARD,
      ARUBA_API_AUTHORITY_CUTOVER,
      ARUBA_P7M_PARITY_NORMALIZATION,
      ARUBA_API_OUTBOUND,
      ...MIGRATIONS_AFTER_ARUBA_API_OUTBOUND,
    ]);
    await withClient(database.connectionString, async (client) => {
      assert.deepEqual(
        (
          await client.query(
            `SELECT provider, cursor, overlap_from::text
             FROM sync_cursors WHERE stream = 'orders' ORDER BY provider`,
          )
        ).rows,
        [
          { provider: "EBAY", cursor: null, overlap_from: "2025-12-01 00:00:00+00" },
          { provider: "SHOPIFY", cursor: null, overlap_from: "2026-01-03 09:55:00+00" },
        ],
      );
      assert.deepEqual(
        (
          await client.query(
            `SELECT provider, last_synced_at
             FROM connections ORDER BY provider`,
          )
        ).rows,
        [
          { provider: "EBAY", last_synced_at: null },
          { provider: "SHOPIFY", last_synced_at: null },
        ],
      );
      assert.equal(
        (
          await client.query(
            `SELECT count(*) FROM jobs
             WHERE type = 'shopify_sync_orders' AND status IN ('PENDING', 'RUNNING')`,
          )
        ).rows[0].count,
        "1",
      );
    });
  } finally {
    await rm(beforeBackfill, { recursive: true, force: true });
    await database.drop();
  }
});

test("l'upgrade rilegge soltanto i destinatari Shopify già importati", async () => {
  const database = await temporaryDatabase("shopify_recipient_reclassification");
  const beforeReclassification = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-shopify-recipient-reclassification-"),
  );
  try {
    await copyMigrationSnapshot(beforeReclassification);
    await rm(path.join(beforeReclassification, SHOPIFY_RECIPIENT_RECLASSIFICATION));
    await rm(path.join(beforeReclassification, EBAY_PAYMENT_RECONCILIATION));
    await rm(path.join(beforeReclassification, EBAY_REFUND_DEDUPLICATION));
    await rm(path.join(beforeReclassification, RETENTION_POLICY));
    await rm(path.join(beforeReclassification, CUSTOMER_EMAIL_DISABLED));
    await rm(path.join(beforeReclassification, CUSTOMER_REVIEW_CLEANUP));
    await rm(path.join(beforeReclassification, ARUBA_CANARY_PERMIT));
    await rm(path.join(beforeReclassification, ARUBA_INBOUND_RECONCILIATION));
    await rm(path.join(beforeReclassification, SHOPIFY_SHIPPING_IDENTITY_REPLAY));
    await rm(path.join(beforeReclassification, REMOVE_ARUBA_SEND_PERMITS));
    await rm(path.join(beforeReclassification, REMOVE_ARUBA_UPLOAD_PROTECTION));
    await runMigrations({
      connectionString: database.connectionString,
      directory: beforeReclassification,
    });
    await withClient(database.connectionString, async (client) => {
      await client.query(
        `INSERT INTO connections
           (provider, environment, account_reference, encrypted_credentials, status,
            last_synced_at)
         VALUES
           ('SHOPIFY', 'PRODUCTION', 'shop.example', 'encrypted', 'CONNECTED',
            '2026-08-12T12:00:00Z'),
           ('EBAY', 'PRODUCTION', 'seller', 'encrypted', 'CONNECTED',
            '2026-08-12T12:00:00Z')`,
      );
      await client.query(
        `INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
         VALUES
           ('SHOPIFY', 'history_import', 'complete', '2026-01-01T00:00:00Z'),
           ('EBAY', 'history_import', 'complete', '2026-01-01T00:00:00Z'),
           ('SHOPIFY', 'orders', 'shopify-recent', '2026-08-12T10:00:00Z'),
           ('EBAY', 'orders', 'ebay-recent', '2026-08-12T10:00:00Z')`,
      );
      const customerId = (
        await client.query(
          `INSERT INTO customers
             (kind, match_key, display_name, billing_address_json, source_confidence,
              review_required)
           VALUES ('UNKNOWN', 'recipient-reclassification', 'Cliente', '{}', 'AMBIGUOUS', true)
           RETURNING id`,
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO orders
           (provider, external_account_id, external_order_id, display_number,
            created_at_source, updated_at_source, local_order_date, currency, gross_amount,
            payment_status, fulfillment_status, trigger_status, customer_id,
            raw_snapshot_json, normalized_snapshot_json)
         VALUES
           ('SHOPIFY', 'shop.example', 'shop-order', '#S', '2026-08-01T09:00:00Z',
            '2026-08-02T10:00:00Z', '2026-08-01', 'EUR', 1000, 'PAID', 'FULFILLED',
            'ELIGIBLE', $1, '{}', '{}'),
           ('EBAY', 'seller', 'ebay-order', '#E', '2026-08-03T09:00:00Z',
            '2026-08-04T10:00:00Z', '2026-08-03', 'EUR', 2000, 'PAID', 'FULFILLED',
            'ELIGIBLE', $1, '{}', '{}')`,
        [customerId],
      );
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      SHOPIFY_RECIPIENT_RECLASSIFICATION,
      EBAY_PAYMENT_RECONCILIATION,
      EBAY_REFUND_DEDUPLICATION,
      RETENTION_POLICY,
      REMOVE_ARUBA_UPLOAD_PROTECTION,
      CUSTOMER_EMAIL_DISABLED,
      CUSTOMER_REVIEW_CLEANUP,
      ARUBA_CANARY_PERMIT,
      ARUBA_INBOUND_RECONCILIATION,
      SHOPIFY_SHIPPING_IDENTITY_REPLAY,
      REMOVE_ARUBA_SEND_PERMITS,
      SUPPORT_SAFARI_ARUBA_READ_SYNC,
      ARUBA_STATUS_MAPPER_VERSION,
      ARUBA_API_INBOUND,
      ARUBA_REJECTED_ATTEMPT_IDENTITY,
      ARUBA_API_TRAFFIC_GUARD,
      ARUBA_API_AUTHORITY_CUTOVER,
      ARUBA_P7M_PARITY_NORMALIZATION,
      ARUBA_API_OUTBOUND,
      ...MIGRATIONS_AFTER_ARUBA_API_OUTBOUND,
    ]);
    await withClient(database.connectionString, async (client) => {
      assert.deepEqual(
        (
          await client.query(
            `SELECT provider, cursor, overlap_from::text
             FROM sync_cursors WHERE stream = 'orders' ORDER BY provider`,
          )
        ).rows,
        [
          { provider: "EBAY", cursor: null, overlap_from: "2026-08-04 09:55:00+00" },
          { provider: "SHOPIFY", cursor: null, overlap_from: "2026-08-02 09:55:00+00" },
        ],
      );
      assert.deepEqual(
        (
          await client.query(
            `SELECT provider, last_synced_at::text
             FROM connections ORDER BY provider`,
          )
        ).rows,
        [
          { provider: "EBAY", last_synced_at: null },
          { provider: "SHOPIFY", last_synced_at: null },
        ],
      );
    });
  } finally {
    await rm(beforeReclassification, { recursive: true, force: true });
    await database.drop();
  }
});

test("l'upgrade rilegge il mapper Shopify senza riavvolgere eBay", async () => {
  const database = await temporaryDatabase("shopify_shipping_identity_replay");
  const beforeReplay = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-shopify-shipping-identity-replay-"),
  );
  try {
    await copyMigrationSnapshot(beforeReplay);
    await rm(path.join(beforeReplay, SHOPIFY_SHIPPING_IDENTITY_REPLAY));
    await rm(path.join(beforeReplay, REMOVE_ARUBA_SEND_PERMITS));
    await runMigrations({ connectionString: database.connectionString, directory: beforeReplay });
    await withClient(database.connectionString, async (client) => {
      await client.query(
        `INSERT INTO connections
           (provider, environment, account_reference, encrypted_credentials, status,
            last_synced_at)
         VALUES
           ('SHOPIFY', 'PRODUCTION', 'shop.example', 'encrypted', 'CONNECTED',
            '2026-08-14T12:00:00Z'),
           ('EBAY', 'PRODUCTION', 'seller', 'encrypted', 'CONNECTED',
            '2026-08-14T12:00:00Z')`,
      );
      await client.query(
        `INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
         VALUES
           ('SHOPIFY', 'history_import', 'complete', '2026-01-01T00:00:00Z'),
           ('EBAY', 'history_import', 'complete', '2026-01-01T00:00:00Z'),
           ('SHOPIFY', 'orders', 'shopify-recent', '2026-08-14T10:00:00Z'),
           ('EBAY', 'orders', 'ebay-recent', '2026-08-14T10:00:00Z')`,
      );
      const customerId = (
        await client.query(
          `INSERT INTO customers
             (kind, match_key, display_name, billing_address_json, source_confidence,
              review_required)
           VALUES ('UNKNOWN', 'shipping-replay', 'Cliente', '{}', 'AMBIGUOUS', true)
           RETURNING id`,
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO orders
           (provider, external_account_id, external_order_id, display_number,
            created_at_source, updated_at_source, local_order_date, currency, gross_amount,
            payment_status, fulfillment_status, trigger_status, customer_id,
            raw_snapshot_json, normalized_snapshot_json)
         VALUES
           ('SHOPIFY', 'shop.example', 'shop-order', '#S', '2026-08-13T09:00:00Z',
            '2026-08-13T10:00:00Z', '2026-08-13', 'EUR', 1000, 'PAID', 'FULFILLED',
            'ELIGIBLE', $1, '{}', '{}'),
           ('EBAY', 'seller', 'ebay-order', '#E', '2026-08-12T09:00:00Z',
            '2026-08-12T10:00:00Z', '2026-08-12', 'EUR', 1000, 'PAID', 'FULFILLED',
            'ELIGIBLE', $1, '{}', '{}')`,
        [customerId],
      );
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      SHOPIFY_SHIPPING_IDENTITY_REPLAY,
      REMOVE_ARUBA_SEND_PERMITS,
      SUPPORT_SAFARI_ARUBA_READ_SYNC,
      ARUBA_STATUS_MAPPER_VERSION,
      ARUBA_API_INBOUND,
      ARUBA_REJECTED_ATTEMPT_IDENTITY,
      ARUBA_API_TRAFFIC_GUARD,
      ARUBA_API_AUTHORITY_CUTOVER,
      ARUBA_P7M_PARITY_NORMALIZATION,
      ARUBA_API_OUTBOUND,
      ...MIGRATIONS_AFTER_ARUBA_API_OUTBOUND,
    ]);
    await withClient(database.connectionString, async (client) => {
      assert.deepEqual(
        (
          await client.query(
            `SELECT provider, cursor, overlap_from::text
             FROM sync_cursors WHERE stream = 'orders' ORDER BY provider`,
          )
        ).rows,
        [
          { provider: "EBAY", cursor: "ebay-recent", overlap_from: "2026-08-14 10:00:00+00" },
          { provider: "SHOPIFY", cursor: null, overlap_from: "2026-08-13 09:55:00+00" },
        ],
      );
      assert.deepEqual(
        (
          await client.query(
            `SELECT provider, last_synced_at::text
             FROM connections ORDER BY provider`,
          )
        ).rows,
        [
          { provider: "EBAY", last_synced_at: "2026-08-14 12:00:00+00" },
          { provider: "SHOPIFY", last_synced_at: null },
        ],
      );
    });
  } finally {
    await rm(beforeReplay, { recursive: true, force: true });
    await database.drop();
  }
});

test("l'upgrade rilegge soltanto gli ordini eBay già importati", async () => {
  const database = await temporaryDatabase("ebay_payment_reconciliation");
  const beforeReconciliation = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-ebay-payment-reconciliation-"),
  );
  try {
    await copyMigrationSnapshot(beforeReconciliation);
    await rm(path.join(beforeReconciliation, EBAY_PAYMENT_RECONCILIATION));
    await rm(path.join(beforeReconciliation, EBAY_REFUND_DEDUPLICATION));
    await rm(path.join(beforeReconciliation, RETENTION_POLICY));
    await rm(path.join(beforeReconciliation, CUSTOMER_EMAIL_DISABLED));
    await rm(path.join(beforeReconciliation, CUSTOMER_REVIEW_CLEANUP));
    await rm(path.join(beforeReconciliation, ARUBA_CANARY_PERMIT));
    await rm(path.join(beforeReconciliation, ARUBA_INBOUND_RECONCILIATION));
    await rm(path.join(beforeReconciliation, SHOPIFY_SHIPPING_IDENTITY_REPLAY));
    await rm(path.join(beforeReconciliation, REMOVE_ARUBA_SEND_PERMITS));
    await rm(path.join(beforeReconciliation, REMOVE_ARUBA_UPLOAD_PROTECTION));
    await runMigrations({
      connectionString: database.connectionString,
      directory: beforeReconciliation,
    });
    await withClient(database.connectionString, async (client) => {
      await client.query(
        `INSERT INTO connections
           (provider, environment, account_reference, encrypted_credentials, status,
            last_synced_at)
         VALUES
           ('SHOPIFY', 'PRODUCTION', 'shop.example', 'encrypted', 'CONNECTED',
            '2026-08-12T12:00:00Z'),
           ('EBAY', 'PRODUCTION', 'seller', 'encrypted', 'CONNECTED',
            '2026-08-12T12:00:00Z')`,
      );
      await client.query(
        `INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
         VALUES
           ('SHOPIFY', 'orders', 'shopify-recent', '2026-08-12T10:00:00Z'),
           ('EBAY', 'history_import', 'complete', '2026-01-01T00:00:00Z'),
           ('EBAY', 'orders', 'ebay-recent', '2026-08-12T10:00:00Z')`,
      );
      const customerId = (
        await client.query(
          `INSERT INTO customers
             (kind, match_key, display_name, billing_address_json, source_confidence,
              review_required)
           VALUES ('UNKNOWN', 'ebay-payment-reconciliation', 'Cliente', '{}',
             'AMBIGUOUS', true)
           RETURNING id`,
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO orders
           (provider, external_account_id, external_order_id, display_number,
            created_at_source, updated_at_source, local_order_date, currency, gross_amount,
            payment_status, fulfillment_status, trigger_status, customer_id,
            raw_snapshot_json, normalized_snapshot_json)
         VALUES
           ('EBAY', 'seller', 'ebay-order', '#E', '2026-08-03T09:00:00Z',
            '2026-08-04T10:00:00Z', '2026-08-03', 'EUR', 2000, 'PAID', 'FULFILLED',
            'ELIGIBLE', $1, '{}', '{}')`,
        [customerId],
      );
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      EBAY_PAYMENT_RECONCILIATION,
      EBAY_REFUND_DEDUPLICATION,
      RETENTION_POLICY,
      REMOVE_ARUBA_UPLOAD_PROTECTION,
      CUSTOMER_EMAIL_DISABLED,
      CUSTOMER_REVIEW_CLEANUP,
      ARUBA_CANARY_PERMIT,
      ARUBA_INBOUND_RECONCILIATION,
      SHOPIFY_SHIPPING_IDENTITY_REPLAY,
      REMOVE_ARUBA_SEND_PERMITS,
      SUPPORT_SAFARI_ARUBA_READ_SYNC,
      ARUBA_STATUS_MAPPER_VERSION,
      ARUBA_API_INBOUND,
      ARUBA_REJECTED_ATTEMPT_IDENTITY,
      ARUBA_API_TRAFFIC_GUARD,
      ARUBA_API_AUTHORITY_CUTOVER,
      ARUBA_P7M_PARITY_NORMALIZATION,
      ARUBA_API_OUTBOUND,
      ...MIGRATIONS_AFTER_ARUBA_API_OUTBOUND,
    ]);
    await withClient(database.connectionString, async (client) => {
      assert.deepEqual(
        (
          await client.query(
            `SELECT provider, cursor, overlap_from::text
             FROM sync_cursors WHERE stream = 'orders' ORDER BY provider`,
          )
        ).rows,
        [
          { provider: "EBAY", cursor: null, overlap_from: "2026-08-04 09:55:00+00" },
          {
            provider: "SHOPIFY",
            cursor: "shopify-recent",
            overlap_from: "2026-08-12 10:00:00+00",
          },
        ],
      );
      assert.deepEqual(
        (
          await client.query(
            `SELECT provider, account_reference, last_synced_at::text
             FROM connections ORDER BY provider, account_reference`,
          )
        ).rows,
        [
          { provider: "EBAY", account_reference: "seller", last_synced_at: null },
          {
            provider: "SHOPIFY",
            account_reference: "shop.example",
            last_synced_at: "2026-08-12 12:00:00+00",
          },
        ],
      );
    });
  } finally {
    await rm(beforeReconciliation, { recursive: true, force: true });
    await database.drop();
  }
});

test("l'upgrade non crea un cursore eBay senza ordini eBay", async () => {
  const database = await temporaryDatabase("ebay_payment_reconciliation_empty");
  const beforeReconciliation = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-ebay-payment-reconciliation-empty-"),
  );
  try {
    await copyMigrationSnapshot(beforeReconciliation);
    await rm(path.join(beforeReconciliation, EBAY_PAYMENT_RECONCILIATION));
    await rm(path.join(beforeReconciliation, EBAY_REFUND_DEDUPLICATION));
    await rm(path.join(beforeReconciliation, RETENTION_POLICY));
    await rm(path.join(beforeReconciliation, CUSTOMER_EMAIL_DISABLED));
    await rm(path.join(beforeReconciliation, CUSTOMER_REVIEW_CLEANUP));
    await rm(path.join(beforeReconciliation, ARUBA_CANARY_PERMIT));
    await rm(path.join(beforeReconciliation, ARUBA_INBOUND_RECONCILIATION));
    await rm(path.join(beforeReconciliation, SHOPIFY_SHIPPING_IDENTITY_REPLAY));
    await rm(path.join(beforeReconciliation, REMOVE_ARUBA_SEND_PERMITS));
    await rm(path.join(beforeReconciliation, REMOVE_ARUBA_UPLOAD_PROTECTION));
    await runMigrations({
      connectionString: database.connectionString,
      directory: beforeReconciliation,
    });
    await withClient(database.connectionString, async (client) => {
      await client.query(
        `INSERT INTO connections
           (provider, environment, account_reference, encrypted_credentials, status,
            last_synced_at)
         VALUES ('EBAY', 'PRODUCTION', 'seller-empty', 'encrypted', 'CONNECTED',
           '2026-08-12T12:00:00Z')`,
      );
      await client.query(
        `INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
         VALUES ('EBAY', 'history_import', 'complete', '2026-01-01T00:00:00Z')`,
      );
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      EBAY_PAYMENT_RECONCILIATION,
      EBAY_REFUND_DEDUPLICATION,
      RETENTION_POLICY,
      REMOVE_ARUBA_UPLOAD_PROTECTION,
      CUSTOMER_EMAIL_DISABLED,
      CUSTOMER_REVIEW_CLEANUP,
      ARUBA_CANARY_PERMIT,
      ARUBA_INBOUND_RECONCILIATION,
      SHOPIFY_SHIPPING_IDENTITY_REPLAY,
      REMOVE_ARUBA_SEND_PERMITS,
      SUPPORT_SAFARI_ARUBA_READ_SYNC,
      ARUBA_STATUS_MAPPER_VERSION,
      ARUBA_API_INBOUND,
      ARUBA_REJECTED_ATTEMPT_IDENTITY,
      ARUBA_API_TRAFFIC_GUARD,
      ARUBA_API_AUTHORITY_CUTOVER,
      ARUBA_P7M_PARITY_NORMALIZATION,
      ARUBA_API_OUTBOUND,
      ...MIGRATIONS_AFTER_ARUBA_API_OUTBOUND,
    ]);
    await withClient(database.connectionString, async (client) => {
      assert.equal(
        (
          await client.query(
            "SELECT count(*) FROM sync_cursors WHERE provider = 'EBAY' AND stream = 'orders'",
          )
        ).rows[0].count,
        "0",
      );
      assert.equal(
        (await client.query("SELECT last_synced_at::text FROM connections WHERE provider = 'EBAY'"))
          .rows[0].last_synced_at,
        "2026-08-12 12:00:00+00",
      );
    });
  } finally {
    await rm(beforeReconciliation, { recursive: true, force: true });
    await database.drop();
  }
});

test("l'upgrade elimina soltanto i duplicati sintetici dei rimborsi eBay", async () => {
  const database = await temporaryDatabase("ebay_refund_deduplication");
  const beforeDeduplication = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-ebay-refund-deduplication-"),
  );
  try {
    await copyMigrationSnapshot(beforeDeduplication);
    await rm(path.join(beforeDeduplication, EBAY_REFUND_DEDUPLICATION));
    await rm(path.join(beforeDeduplication, RETENTION_POLICY));
    await rm(path.join(beforeDeduplication, CUSTOMER_EMAIL_DISABLED));
    await rm(path.join(beforeDeduplication, CUSTOMER_REVIEW_CLEANUP));
    await rm(path.join(beforeDeduplication, ARUBA_CANARY_PERMIT));
    await rm(path.join(beforeDeduplication, ARUBA_INBOUND_RECONCILIATION));
    await rm(path.join(beforeDeduplication, SHOPIFY_SHIPPING_IDENTITY_REPLAY));
    await rm(path.join(beforeDeduplication, REMOVE_ARUBA_SEND_PERMITS));
    await rm(path.join(beforeDeduplication, REMOVE_ARUBA_UPLOAD_PROTECTION));
    await runMigrations({
      connectionString: database.connectionString,
      directory: beforeDeduplication,
    });
    await withClient(database.connectionString, async (client) => {
      const order = await client.query<{ id: string }>(
        `WITH customer AS (
           INSERT INTO customers
             (kind, match_key, display_name, billing_address_json,
              source_confidence, review_required)
           VALUES ('PRIVATE_IT', 'ebay-refund-deduplication', 'Cliente', '{}', 'TAX_ID', false)
           RETURNING id
         )
         INSERT INTO orders
           (provider, external_account_id, external_order_id, display_number,
            created_at_source, updated_at_source, local_order_date, currency, gross_amount,
            payment_status, fulfillment_status, trigger_status, customer_id,
            raw_snapshot_json, normalized_snapshot_json)
         SELECT 'EBAY', 'deduplication', 'ebay-order', 'EBAY-ORDER', now(), now(),
                '2026-08-12', 'EUR', 1000, 'REFUNDED', 'FULFILLED', 'CANCELLED_NO_DOCUMENT',
                id, '{}', '{}'
         FROM customer RETURNING id`,
      );
      await client.query(
        `INSERT INTO refunds
          (provider, external_account_id, external_order_id, external_refund_id,
           order_id, status, amount, completed_at, raw_json)
         VALUES
          ('EBAY', 'deduplication', 'ebay-order', '5446235426', $1,
           'AMBIGUOUS', NULL, '2026-08-12T10:00:00Z', '{}'),
          ('EBAY', 'deduplication', 'ebay-order', 'ebay-order-refund-2', $1,
           'AMBIGUOUS', NULL, '2026-08-12T10:00:00Z', '{}')`,
        [order.rows[0]!.id],
      );
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      EBAY_REFUND_DEDUPLICATION,
      RETENTION_POLICY,
      REMOVE_ARUBA_UPLOAD_PROTECTION,
      CUSTOMER_EMAIL_DISABLED,
      CUSTOMER_REVIEW_CLEANUP,
      ARUBA_CANARY_PERMIT,
      ARUBA_INBOUND_RECONCILIATION,
      SHOPIFY_SHIPPING_IDENTITY_REPLAY,
      REMOVE_ARUBA_SEND_PERMITS,
      SUPPORT_SAFARI_ARUBA_READ_SYNC,
      ARUBA_STATUS_MAPPER_VERSION,
      ARUBA_API_INBOUND,
      ARUBA_REJECTED_ATTEMPT_IDENTITY,
      ARUBA_API_TRAFFIC_GUARD,
      ARUBA_API_AUTHORITY_CUTOVER,
      ARUBA_P7M_PARITY_NORMALIZATION,
      ARUBA_API_OUTBOUND,
      ...MIGRATIONS_AFTER_ARUBA_API_OUTBOUND,
    ]);
    await withClient(database.connectionString, async (client) => {
      assert.deepEqual(
        (await client.query("SELECT external_refund_id FROM refunds ORDER BY external_refund_id"))
          .rows,
        [{ external_refund_id: "5446235426" }],
      );
    });
  } finally {
    await rm(beforeDeduplication, { recursive: true, force: true });
    await database.drop();
  }
});

test("l'upgrade elimina la configurazione obsoleta della protezione per upload Aruba", async () => {
  const database = await temporaryDatabase("remove_aruba_upload_protection");
  const beforeRemoval = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-remove-aruba-upload-protection-"),
  );
  try {
    await copyMigrationSnapshot(beforeRemoval);
    await rm(path.join(beforeRemoval, REMOVE_ARUBA_UPLOAD_PROTECTION));
    await rm(path.join(beforeRemoval, CUSTOMER_EMAIL_DISABLED));
    await rm(path.join(beforeRemoval, CUSTOMER_REVIEW_CLEANUP));
    await rm(path.join(beforeRemoval, ARUBA_CANARY_PERMIT));
    await rm(path.join(beforeRemoval, ARUBA_INBOUND_RECONCILIATION));
    await rm(path.join(beforeRemoval, SHOPIFY_SHIPPING_IDENTITY_REPLAY));
    await rm(path.join(beforeRemoval, REMOVE_ARUBA_SEND_PERMITS));
    await runMigrations({
      connectionString: database.connectionString,
      directory: beforeRemoval,
    });
    await withClient(database.connectionString, async (client) => {
      await client.query(
        "UPDATE settings SET value_json = '\"SMS_PER_UPLOAD\"' WHERE key = 'aruba_auth_protection'",
      );
      assert.equal(
        (await client.query("SELECT count(*) FROM settings WHERE key = 'aruba_auth_protection'"))
          .rows[0].count,
        "1",
      );
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      REMOVE_ARUBA_UPLOAD_PROTECTION,
      CUSTOMER_EMAIL_DISABLED,
      CUSTOMER_REVIEW_CLEANUP,
      ARUBA_CANARY_PERMIT,
      ARUBA_INBOUND_RECONCILIATION,
      SHOPIFY_SHIPPING_IDENTITY_REPLAY,
      REMOVE_ARUBA_SEND_PERMITS,
      SUPPORT_SAFARI_ARUBA_READ_SYNC,
      ARUBA_STATUS_MAPPER_VERSION,
      ARUBA_API_INBOUND,
      ARUBA_REJECTED_ATTEMPT_IDENTITY,
      ARUBA_API_TRAFFIC_GUARD,
      ARUBA_API_AUTHORITY_CUTOVER,
      ARUBA_P7M_PARITY_NORMALIZATION,
      ARUBA_API_OUTBOUND,
      ...MIGRATIONS_AFTER_ARUBA_API_OUTBOUND,
    ]);
    await withClient(database.connectionString, async (client) => {
      assert.equal(
        (await client.query("SELECT count(*) FROM settings WHERE key = 'aruba_auth_protection'"))
          .rows[0].count,
        "0",
      );
    });
  } finally {
    await rm(beforeRemoval, { recursive: true, force: true });
    await database.drop();
  }
});

test("installazione vuota, checksum e guardie sull'ordine", { timeout: 30_000 }, async () => {
  const clean = await temporaryDatabase("clean");
  try {
    assert.deepEqual(await runMigrations({ connectionString: clean.connectionString }), [
      BASELINE,
      CONNECTORS,
      CONNECTOR_PRIVACY,
      CONNECTOR_OPERATIONS,
      DOCUMENTS,
      M4_COMPLETION,
      M4_LEGACY_DOCUMENTS,
      DOCUMENT_DEPLOY_COMPATIBILITY,
      APPROVED_PAYMENT_HISTORY,
      DRAFT_RECIPIENT_SNAPSHOT,
      ORDER_MEMBERSHIP_DRAFT_INVALIDATION,
      ARUBA_INTEGRATION,
      CREDIT_NOTES_EMAIL,
      PRE_ISSUE_REFUNDS,
      CANONICAL_ACCOUNT_NAMES,
      HISTORICAL_ORDER_RECONCILIATION,
      HISTORICAL_INVOICE_LINKS,
      LEGACY_WEBHOOK_HISTORY,
      SHOPIFY_PAYMENT_FEES,
      CREDIT_NOTE_ORDER_AMOUNTS,
      FISCAL_IDENTIFIER_BACKFILL,
      SHOPIFY_RECIPIENT_RECLASSIFICATION,
      EBAY_PAYMENT_RECONCILIATION,
      EBAY_REFUND_DEDUPLICATION,
      RETENTION_POLICY,
      REMOVE_ARUBA_UPLOAD_PROTECTION,
      CUSTOMER_EMAIL_DISABLED,
      CUSTOMER_REVIEW_CLEANUP,
      ARUBA_CANARY_PERMIT,
      ARUBA_INBOUND_RECONCILIATION,
      SHOPIFY_SHIPPING_IDENTITY_REPLAY,
      REMOVE_ARUBA_SEND_PERMITS,
      SUPPORT_SAFARI_ARUBA_READ_SYNC,
      ARUBA_STATUS_MAPPER_VERSION,
      ARUBA_API_INBOUND,
      ARUBA_REJECTED_ATTEMPT_IDENTITY,
      ARUBA_API_TRAFFIC_GUARD,
      ARUBA_API_AUTHORITY_CUTOVER,
      ARUBA_P7M_PARITY_NORMALIZATION,
      ARUBA_API_OUTBOUND,
      ...MIGRATIONS_AFTER_ARUBA_API_OUTBOUND,
    ]);
    const cleanClient = new pg.Client({ connectionString: clean.connectionString });
    await cleanClient.connect();
    try {
      assert.equal(
        (await cleanClient.query("SELECT count(*) FROM schema_migrations")).rows[0].count,
        String(CURRENT_MIGRATIONS.length),
      );
      assert.equal(
        (
          await cleanClient.query(
            `SELECT count(*) FROM information_schema.columns
             WHERE table_name = 'sync_cursors' AND column_name = 'aruba_status_mapper_version'`,
          )
        ).rows[0].count,
        "1",
      );
      assert.match(
        (
          await cleanClient.query<{ definition: string }>(
            `SELECT pg_get_constraintdef(oid) AS definition
             FROM pg_constraint
             WHERE conname = 'documents_customer_email_mode_check'`,
          )
        ).rows[0]!.definition,
        /DISABLED/,
      );
      assert.equal(
        (
          await cleanClient.query(
            "SELECT count(*) FROM settings WHERE key = 'aruba_auth_protection'",
          )
        ).rows[0].count,
        "0",
      );
    } finally {
      await cleanClient.end();
    }

    const changed = await mkdtemp(path.join(os.tmpdir(), "hf-migrations-changed-"));
    await cp("migrations", changed, { recursive: true });
    await writeFile(
      path.join(changed, BASELINE),
      `${await readFile(path.join(changed, BASELINE), "utf8")}\n-- modifica vietata\n`,
    );
    await assert.rejects(
      runMigrations({ connectionString: clean.connectionString, directory: changed }),
      /Migrazione applicata modificata/,
    );
    await rm(path.join(changed, BASELINE));
    await assert.rejects(
      runMigrations({ connectionString: clean.connectionString, directory: changed }),
      /Migrazione applicata rimossa/,
    );

    // Una migrazione nuova che si ordina prima dell'ultima applicata salterebbe il proprio
    // turno: deve fallire invece di essere applicata fuori sequenza.
    const inserted = await mkdtemp(path.join(os.tmpdir(), "hf-migrations-inserted-"));
    await cp("migrations", inserted, { recursive: true });
    await writeFile(path.join(inserted, "000_inserted.sql"), "SELECT 1;\n");
    await assert.rejects(
      runMigrations({ connectionString: clean.connectionString, directory: inserted }),
      /Migrazione fuori ordine/,
    );

    await withClient(clean.connectionString, async (client) => {
      assert.equal(
        (await client.query("SELECT to_regclass('audit_events') AS table_name")).rows[0].table_name,
        "audit_events",
      );
      assert.equal(
        (await client.query("SELECT to_regclass('orders') AS table_name")).rows[0].table_name,
        "orders",
      );
      assert.equal(
        (
          await client.query(
            "SELECT to_regclass('audit_events_login_rate_scope_idx') AS index_name",
          )
        ).rows[0].index_name,
        "audit_events_login_rate_scope_idx",
      );
      assert.equal(
        (await client.query("SELECT value_json #>> '{}' AS trigger FROM settings")).rows[0].trigger,
        "PAID",
      );
      const customerId = (
        await client.query(
          `INSERT INTO customers
               (kind, match_key, display_name, billing_address_json, source_confidence, review_required)
             VALUES ('UNKNOWN', 'test-high-id', 'Test', '{}'::jsonb, 'AMBIGUOUS', true)
             RETURNING id`,
        )
      ).rows[0].id;
      // Il numero pubblico non tronca oltre le sei cifre: è la ragione per cui la sua
      // definizione era già stata rifatta due volte prima della baseline.
      await client.query("ALTER TABLE billing_cases ALTER COLUMN id RESTART WITH 1000000");
      assert.equal(
        (
          await client.query(
            `INSERT INTO billing_cases
                 (customer_id, local_order_date, currency, status, customer_snapshot_json)
               VALUES ($1, '2026-08-09', 'EUR', 'NEEDS_REVIEW', '{}'::jsonb)
               RETURNING public_number`,
            [customerId],
          )
        ).rows[0].public_number,
        "1000000",
      );
    });
  } finally {
    await clean.drop();
  }
});

test("la migrazione rende canonici e case-insensitive i due account", async () => {
  const database = await temporaryDatabase("canonical_accounts");
  const beforeCanonicalNames = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-canonical-accounts-"),
  );
  try {
    await copyMigrationSnapshot(beforeCanonicalNames);
    await rm(path.join(beforeCanonicalNames, CANONICAL_ACCOUNT_NAMES));
    await rm(path.join(beforeCanonicalNames, HISTORICAL_ORDER_RECONCILIATION));
    await rm(path.join(beforeCanonicalNames, HISTORICAL_INVOICE_LINKS));
    await rm(path.join(beforeCanonicalNames, LEGACY_WEBHOOK_HISTORY));
    await rm(path.join(beforeCanonicalNames, SHOPIFY_PAYMENT_FEES));
    await rm(path.join(beforeCanonicalNames, CREDIT_NOTE_ORDER_AMOUNTS));
    await rm(path.join(beforeCanonicalNames, FISCAL_IDENTIFIER_BACKFILL));
    await rm(path.join(beforeCanonicalNames, SHOPIFY_RECIPIENT_RECLASSIFICATION));
    await rm(path.join(beforeCanonicalNames, EBAY_PAYMENT_RECONCILIATION));
    await rm(path.join(beforeCanonicalNames, EBAY_REFUND_DEDUPLICATION));
    await rm(path.join(beforeCanonicalNames, RETENTION_POLICY));
    await rm(path.join(beforeCanonicalNames, CUSTOMER_EMAIL_DISABLED));
    await rm(path.join(beforeCanonicalNames, CUSTOMER_REVIEW_CLEANUP));
    await rm(path.join(beforeCanonicalNames, ARUBA_CANARY_PERMIT));
    await rm(path.join(beforeCanonicalNames, ARUBA_INBOUND_RECONCILIATION));
    await rm(path.join(beforeCanonicalNames, SHOPIFY_SHIPPING_IDENTITY_REPLAY));
    await rm(path.join(beforeCanonicalNames, REMOVE_ARUBA_SEND_PERMITS));
    await rm(path.join(beforeCanonicalNames, REMOVE_ARUBA_UPLOAD_PROTECTION));
    await runMigrations({
      connectionString: database.connectionString,
      directory: beforeCanonicalNames,
    });
    await withClient(database.connectionString, async (client) => {
      await client.query(
        `INSERT INTO users (username, password_hash, can_approve)
         VALUES ('matteo', 'owner', true), ('codex', 'agent', false)`,
      );
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      CANONICAL_ACCOUNT_NAMES,
      HISTORICAL_ORDER_RECONCILIATION,
      HISTORICAL_INVOICE_LINKS,
      LEGACY_WEBHOOK_HISTORY,
      SHOPIFY_PAYMENT_FEES,
      CREDIT_NOTE_ORDER_AMOUNTS,
      FISCAL_IDENTIFIER_BACKFILL,
      SHOPIFY_RECIPIENT_RECLASSIFICATION,
      EBAY_PAYMENT_RECONCILIATION,
      EBAY_REFUND_DEDUPLICATION,
      RETENTION_POLICY,
      REMOVE_ARUBA_UPLOAD_PROTECTION,
      CUSTOMER_EMAIL_DISABLED,
      CUSTOMER_REVIEW_CLEANUP,
      ARUBA_CANARY_PERMIT,
      ARUBA_INBOUND_RECONCILIATION,
      SHOPIFY_SHIPPING_IDENTITY_REPLAY,
      REMOVE_ARUBA_SEND_PERMITS,
      SUPPORT_SAFARI_ARUBA_READ_SYNC,
      ARUBA_STATUS_MAPPER_VERSION,
      ARUBA_API_INBOUND,
      ARUBA_REJECTED_ATTEMPT_IDENTITY,
      ARUBA_API_TRAFFIC_GUARD,
      ARUBA_API_AUTHORITY_CUTOVER,
      ARUBA_P7M_PARITY_NORMALIZATION,
      ARUBA_API_OUTBOUND,
      ...MIGRATIONS_AFTER_ARUBA_API_OUTBOUND,
    ]);
    await withClient(database.connectionString, async (client) => {
      assert.deepEqual(
        (await client.query("SELECT username, can_approve FROM users ORDER BY username")).rows,
        [
          { username: "Codex", can_approve: false },
          { username: "Massimo", can_approve: true },
        ],
      );
      await assert.rejects(
        client.query("UPDATE users SET can_approve = true WHERE username = 'Codex'"),
        /users_approval_identity_check/,
      );
      await client.query("BEGIN");
      await client.query("ALTER TABLE users DROP CONSTRAINT users_username_canonical_check");
      await assert.rejects(
        client.query(
          "INSERT INTO users (username, password_hash, can_approve) VALUES ('MASSIMO', 'x', false)",
        ),
        /users_username_case_insensitive_idx/,
      );
      await client.query("ROLLBACK");
    });
  } finally {
    await rm(beforeCanonicalNames, { recursive: true, force: true });
    await database.drop();
  }
});

test("l'aggiornamento conserva i rimborsi già sottratti prima dell'emissione", async () => {
  const database = await temporaryDatabase("pre_issue_refund_upgrade");
  const beforeRefundAccounting = await mkdtemp(
    path.join(os.tmpdir(), "hub-fatture-before-refund-accounting-"),
  );
  try {
    await copyMigrationSnapshot(beforeRefundAccounting);
    await rm(path.join(beforeRefundAccounting, PRE_ISSUE_REFUNDS));
    await rm(path.join(beforeRefundAccounting, CANONICAL_ACCOUNT_NAMES));
    await rm(path.join(beforeRefundAccounting, HISTORICAL_ORDER_RECONCILIATION));
    await rm(path.join(beforeRefundAccounting, HISTORICAL_INVOICE_LINKS));
    await rm(path.join(beforeRefundAccounting, LEGACY_WEBHOOK_HISTORY));
    await rm(path.join(beforeRefundAccounting, SHOPIFY_PAYMENT_FEES));
    await rm(path.join(beforeRefundAccounting, CREDIT_NOTE_ORDER_AMOUNTS));
    await rm(path.join(beforeRefundAccounting, FISCAL_IDENTIFIER_BACKFILL));
    await rm(path.join(beforeRefundAccounting, SHOPIFY_RECIPIENT_RECLASSIFICATION));
    await rm(path.join(beforeRefundAccounting, EBAY_PAYMENT_RECONCILIATION));
    await rm(path.join(beforeRefundAccounting, EBAY_REFUND_DEDUPLICATION));
    await rm(path.join(beforeRefundAccounting, RETENTION_POLICY));
    await rm(path.join(beforeRefundAccounting, CUSTOMER_EMAIL_DISABLED));
    await rm(path.join(beforeRefundAccounting, CUSTOMER_REVIEW_CLEANUP));
    await rm(path.join(beforeRefundAccounting, ARUBA_CANARY_PERMIT));
    await rm(path.join(beforeRefundAccounting, ARUBA_INBOUND_RECONCILIATION));
    await rm(path.join(beforeRefundAccounting, SHOPIFY_SHIPPING_IDENTITY_REPLAY));
    await rm(path.join(beforeRefundAccounting, REMOVE_ARUBA_SEND_PERMITS));
    await rm(path.join(beforeRefundAccounting, REMOVE_ARUBA_UPLOAD_PROTECTION));
    await runMigrations({
      connectionString: database.connectionString,
      directory: beforeRefundAccounting,
    });
    await withClient(database.connectionString, async (client) => {
      const order = await client.query<{ id: string }>(
        `WITH customer AS (
           INSERT INTO customers
             (kind, match_key, display_name, billing_address_json,
              source_confidence, review_required)
           VALUES ('PRIVATE_IT', 'refund-upgrade', 'Cliente', '{}', 'TAX_ID', false)
           RETURNING id
         ), billing_case AS (
           INSERT INTO billing_cases
             (customer_id, local_order_date, currency, status, customer_snapshot_json)
           SELECT id, '2026-08-11', 'EUR', 'READY', '{}' FROM customer
           RETURNING id, customer_id
         )
         INSERT INTO orders
           (provider, external_account_id, external_order_id, display_number,
            created_at_source, updated_at_source, local_order_date, currency, gross_amount,
            payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
            raw_snapshot_json, normalized_snapshot_json)
         SELECT 'SHOPIFY', 'upgrade', 'order', '#UPGRADE', now(), now(), '2026-08-11',
                'EUR', 1000, 'PAID', 'FULFILLED', 'GROUPED', customer_id, id, '{}', '{}'
         FROM billing_case RETURNING id`,
      );
      await client.query(
        `INSERT INTO refunds
          (provider, external_account_id, external_order_id, external_refund_id,
           order_id, status, amount, raw_json)
         VALUES ('SHOPIFY', 'upgrade', 'order', 'refund', $1, 'COMPLETED', 100, '{}')`,
        [order.rows[0]!.id],
      );
    });
    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      PRE_ISSUE_REFUNDS,
      CANONICAL_ACCOUNT_NAMES,
      HISTORICAL_ORDER_RECONCILIATION,
      HISTORICAL_INVOICE_LINKS,
      LEGACY_WEBHOOK_HISTORY,
      SHOPIFY_PAYMENT_FEES,
      CREDIT_NOTE_ORDER_AMOUNTS,
      FISCAL_IDENTIFIER_BACKFILL,
      SHOPIFY_RECIPIENT_RECLASSIFICATION,
      EBAY_PAYMENT_RECONCILIATION,
      EBAY_REFUND_DEDUPLICATION,
      RETENTION_POLICY,
      REMOVE_ARUBA_UPLOAD_PROTECTION,
      CUSTOMER_EMAIL_DISABLED,
      CUSTOMER_REVIEW_CLEANUP,
      ARUBA_CANARY_PERMIT,
      ARUBA_INBOUND_RECONCILIATION,
      SHOPIFY_SHIPPING_IDENTITY_REPLAY,
      REMOVE_ARUBA_SEND_PERMITS,
      SUPPORT_SAFARI_ARUBA_READ_SYNC,
      ARUBA_STATUS_MAPPER_VERSION,
      ARUBA_API_INBOUND,
      ARUBA_REJECTED_ATTEMPT_IDENTITY,
      ARUBA_API_TRAFFIC_GUARD,
      ARUBA_API_AUTHORITY_CUTOVER,
      ARUBA_P7M_PARITY_NORMALIZATION,
      ARUBA_API_OUTBOUND,
      ...MIGRATIONS_AFTER_ARUBA_API_OUTBOUND,
    ]);
    await withClient(database.connectionString, async (client) => {
      assert.equal(
        (await client.query("SELECT applied_before_issue FROM refunds")).rows[0]
          .applied_before_issue,
        true,
      );
    });
  } finally {
    await rm(beforeRefundAccounting, { recursive: true, force: true });
    await database.drop();
  }
});

test("l'aggiornamento deriva il pagamento e completa gli snapshot preesistenti", async () => {
  const database = await temporaryDatabase("m4_legacy_documents");
  const beforeM4 = await mkdtemp(path.join(os.tmpdir(), "hub-fatture-before-m4-"));
  let deployCaseId: string | undefined;
  try {
    await copyMigrationSnapshot(beforeM4);
    await rm(path.join(beforeM4, M4_COMPLETION));
    await rm(path.join(beforeM4, M4_LEGACY_DOCUMENTS));
    await rm(path.join(beforeM4, DOCUMENT_DEPLOY_COMPATIBILITY));
    await rm(path.join(beforeM4, APPROVED_PAYMENT_HISTORY));
    await rm(path.join(beforeM4, DRAFT_RECIPIENT_SNAPSHOT));
    await rm(path.join(beforeM4, ORDER_MEMBERSHIP_DRAFT_INVALIDATION));
    await rm(path.join(beforeM4, ARUBA_INTEGRATION));
    await rm(path.join(beforeM4, CREDIT_NOTES_EMAIL));
    await rm(path.join(beforeM4, PRE_ISSUE_REFUNDS));
    await rm(path.join(beforeM4, CANONICAL_ACCOUNT_NAMES));
    await rm(path.join(beforeM4, HISTORICAL_ORDER_RECONCILIATION));
    await rm(path.join(beforeM4, HISTORICAL_INVOICE_LINKS));
    await rm(path.join(beforeM4, LEGACY_WEBHOOK_HISTORY));
    await rm(path.join(beforeM4, SHOPIFY_PAYMENT_FEES));
    await rm(path.join(beforeM4, CREDIT_NOTE_ORDER_AMOUNTS));
    await rm(path.join(beforeM4, FISCAL_IDENTIFIER_BACKFILL));
    await rm(path.join(beforeM4, SHOPIFY_RECIPIENT_RECLASSIFICATION));
    await rm(path.join(beforeM4, EBAY_PAYMENT_RECONCILIATION));
    await rm(path.join(beforeM4, EBAY_REFUND_DEDUPLICATION));
    await rm(path.join(beforeM4, RETENTION_POLICY));
    await rm(path.join(beforeM4, CUSTOMER_EMAIL_DISABLED));
    await rm(path.join(beforeM4, CUSTOMER_REVIEW_CLEANUP));
    await rm(path.join(beforeM4, ARUBA_CANARY_PERMIT));
    await rm(path.join(beforeM4, ARUBA_INBOUND_RECONCILIATION));
    await rm(path.join(beforeM4, SHOPIFY_SHIPPING_IDENTITY_REPLAY));
    await rm(path.join(beforeM4, REMOVE_ARUBA_SEND_PERMITS));
    await rm(path.join(beforeM4, REMOVE_ARUBA_UPLOAD_PROTECTION));
    await runMigrations({ connectionString: database.connectionString, directory: beforeM4 });

    await withClient(database.connectionString, async (client) => {
      const customer = await client.query<{ id: string }>(
        `INSERT INTO customers
             (kind, match_key, display_name, billing_address_json, source_confidence, review_required)
           VALUES ('PRIVATE_IT', 'm4-legacy', 'Mario Rossi', '{}', 'TAX_ID', false)
           RETURNING id`,
      );
      const customerId = customer.rows[0]!.id;
      const profile = {
        payment: { condition: "TP02", invoiceMethod: "MP01", creditNoteMethod: "MP05" },
      };
      await client.query(
        `INSERT INTO fiscal_profiles (version, status, profile_json)
         VALUES (1, 'MOCK', $1)`,
        [profile],
      );
      const cases = await client.query<{ id: string }>(
        `INSERT INTO billing_cases
             (customer_id, local_order_date, currency, status, customer_snapshot_json,
              fiscal_profile_version)
           VALUES
             ($1, '2026-08-09', 'EUR', 'READY', '{}', 1),
             ($1, '2026-08-10', 'EUR', 'APPROVED', '{}', 1),
             ($1, '2026-08-11', 'EUR', 'READY', '{}', 1)
           RETURNING id`,
        [customerId],
      );
      deployCaseId = cases.rows[2]!.id;
      const orders = await client.query<{ id: string }>(
        `INSERT INTO orders
             (provider, external_account_id, external_order_id, display_number,
              created_at_source, updated_at_source, local_order_date, currency, gross_amount,
              payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
              raw_snapshot_json, normalized_snapshot_json)
           VALUES
             ('SHOPIFY', 'm4', 'pending', '#PENDING', now(), now(), '2026-08-09', 'EUR',
              1000, 'PENDING', 'FULFILLED', 'GROUPED', $1, $2, '{}', '{}'),
             ('SHOPIFY', 'm4', 'paid', '#PAID', now(), now(), '2026-08-10', 'EUR',
              1000, 'PAID', 'FULFILLED', 'INVOICED', $1, $3, '{}', '{}'),
             ('SHOPIFY', 'm4', 'deploy-window', '#DEPLOY', now(), now(), '2026-08-11', 'EUR',
              1000, 'PENDING', 'FULFILLED', 'GROUPED', $1, $4, '{}', '{}')
           RETURNING id`,
        [customerId, cases.rows[0]!.id, cases.rows[1]!.id, cases.rows[2]!.id],
      );
      const draft = await client.query<{ id: string }>(
        `INSERT INTO documents
             (billing_case_id, kind, status, document_type, series, document_date,
              fiscal_profile_version, currency, total_amount, source_total_amount,
              difference_amount, projection_sha256)
           VALUES ($1, 'INVOICE', 'DRAFT', 'TD01', 'FPR', '2026-08-09', 1, 'EUR',
                   1000, 1000, 0, $2)
           RETURNING id`,
        [cases.rows[0]!.id, "a".repeat(64)],
      );
      await client.query(
        `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
         VALUES ($1, 'INVOICE', $2, 1000)`,
        [draft.rows[0]!.id, orders.rows[0]!.id],
      );

      const storage = await client.query<{ id: string }>(
        `INSERT INTO storage_objects
             (kind, relative_path, sha256, size_bytes, content_type)
           VALUES ('INVOICE_XML', 'legacy.xml', $1, 1, 'application/xml')
           RETURNING id`,
        ["b".repeat(64)],
      );
      const approved = await client.query<{ id: string }>(
        `INSERT INTO documents
             (billing_case_id, kind, status, document_type, series, document_date,
              fiscal_profile_version, currency, total_amount, source_total_amount,
              difference_amount, projection_sha256)
           VALUES ($1, 'INVOICE', 'DRAFT', 'TD01', 'FPR', '2026-08-10', 1, 'EUR',
                   1000, 1000, 0, $2)
           RETURNING id`,
        [cases.rows[1]!.id, "c".repeat(64)],
      );
      await client.query(
        `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
         VALUES ($1, 'INVOICE', $2, 1000)`,
        [approved.rows[0]!.id, orders.rows[1]!.id],
      );
      await client.query(
        `UPDATE documents
         SET status = 'APPROVED', fiscal_year = 2026, fiscal_number = 1,
             immutable_snapshot_json = $2, fiscal_profile_snapshot_json = $3,
             approved_at = now(), pending_payment_confirmed_at = now(),
             xml_sha256 = $4, storage_object_id = $5
         WHERE id = $1`,
        [
          approved.rows[0]!.id,
          {
            kind: "INVOICE",
            documentDate: "2026-08-10",
            recipient: {
              kind: "PRIVATE_IT",
              firstName: "Mario",
              lastName: "Rossi",
              taxIdentifiers: [{ type: "CODICE_FISCALE", value: "RSSMRA80A01H501U" }],
              address: {
                line1: "Via Roma 1",
                postalCode: "00100",
                city: "Roma",
                province: "RM",
                countryCode: "IT",
              },
            },
            lines: [{ description: "Moneta", quantity: 1, unitAmount: 1000 }],
          },
          profile,
          "b".repeat(64),
          storage.rows[0]!.id,
        ],
      );
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      M4_COMPLETION,
      M4_LEGACY_DOCUMENTS,
      DOCUMENT_DEPLOY_COMPATIBILITY,
      APPROVED_PAYMENT_HISTORY,
      DRAFT_RECIPIENT_SNAPSHOT,
      ORDER_MEMBERSHIP_DRAFT_INVALIDATION,
      ARUBA_INTEGRATION,
      CREDIT_NOTES_EMAIL,
      PRE_ISSUE_REFUNDS,
      CANONICAL_ACCOUNT_NAMES,
      HISTORICAL_ORDER_RECONCILIATION,
      HISTORICAL_INVOICE_LINKS,
      LEGACY_WEBHOOK_HISTORY,
      SHOPIFY_PAYMENT_FEES,
      CREDIT_NOTE_ORDER_AMOUNTS,
      FISCAL_IDENTIFIER_BACKFILL,
      SHOPIFY_RECIPIENT_RECLASSIFICATION,
      EBAY_PAYMENT_RECONCILIATION,
      EBAY_REFUND_DEDUPLICATION,
      RETENTION_POLICY,
      REMOVE_ARUBA_UPLOAD_PROTECTION,
      CUSTOMER_EMAIL_DISABLED,
      CUSTOMER_REVIEW_CLEANUP,
      ARUBA_CANARY_PERMIT,
      ARUBA_INBOUND_RECONCILIATION,
      SHOPIFY_SHIPPING_IDENTITY_REPLAY,
      REMOVE_ARUBA_SEND_PERMITS,
      SUPPORT_SAFARI_ARUBA_READ_SYNC,
      ARUBA_STATUS_MAPPER_VERSION,
      ARUBA_API_INBOUND,
      ARUBA_REJECTED_ATTEMPT_IDENTITY,
      ARUBA_API_TRAFFIC_GUARD,
      ARUBA_API_AUTHORITY_CUTOVER,
      ARUBA_P7M_PARITY_NORMALIZATION,
      ARUBA_API_OUTBOUND,
      ...MIGRATIONS_AFTER_ARUBA_API_OUTBOUND,
    ]);
    assert.ok(deployCaseId);
    await withClient(database.connectionString, async (client) => {
      await assert.rejects(
        client.query(
          `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
           SELECT documents.id, 'INVOICE', orders.id, 1000
           FROM documents CROSS JOIN orders
           WHERE documents.status = 'APPROVED'
             AND orders.external_order_id = 'deploy-window'`,
        ),
        /Le righe di un documento approvato sono immutabili/,
      );
      const deployDraft = await client.query<{ id: string }>(
        `INSERT INTO documents
             (billing_case_id, kind, status, document_type, series, document_date,
              fiscal_profile_version, currency, total_amount, source_total_amount,
              difference_amount, projection_sha256)
           VALUES ($1, 'INVOICE', 'DRAFT', 'TD01', 'FPR', '2026-08-11', 1, 'EUR',
                   1000, 1000, 0, $2)
           RETURNING id`,
        [deployCaseId, "d".repeat(64)],
      );
      const oldVersionOrder = await client.query<{ id: string }>(
        `INSERT INTO orders
             (provider, external_account_id, external_order_id, display_number,
              created_at_source, updated_at_source, local_order_date, currency, gross_amount,
              payment_status, fulfillment_status, trigger_status, customer_id,
              raw_snapshot_json, normalized_snapshot_json)
           SELECT 'SHOPIFY', 'm4', 'old-version-membership', '#OLD', now(), now(),
                  '2026-08-11', 'EUR', 500, 'PAID', 'FULFILLED', 'ELIGIBLE', customer_id,
                  '{}', '{}'
           FROM billing_cases WHERE id = $1
           RETURNING id`,
        [deployCaseId],
      );
      await client.query("UPDATE orders SET billing_case_id = $2 WHERE id = $1", [
        oldVersionOrder.rows[0]!.id,
        deployCaseId,
      ]);
      assert.equal(
        (
          await client.query("SELECT projection_sha256 FROM documents WHERE id = $1", [
            deployDraft.rows[0]!.id,
          ])
        ).rows[0].projection_sha256,
        "0".repeat(64),
      );
      const result = await client.query<{
        status: string;
        payment_status: string;
        payment_method: string;
        immutable_snapshot_json: unknown;
        recipient_snapshot_json: unknown;
      }>(
        `SELECT status, payment_status, payment_method, immutable_snapshot_json,
                recipient_snapshot_json
         FROM documents ORDER BY id`,
      );
      assert.deepEqual(
        result.rows.map(({ status, payment_status, payment_method }) => ({
          status,
          payment_status,
          payment_method,
        })),
        [
          { status: "DRAFT", payment_status: "PENDING", payment_method: "MP01" },
          { status: "APPROVED", payment_status: "PENDING", payment_method: "MP01" },
          { status: "DRAFT", payment_status: "PENDING", payment_method: "MP01" },
        ],
      );
      documentInputSchema.parse(result.rows[1]!.immutable_snapshot_json);
      assert.ok(result.rows.every((row) => row.recipient_snapshot_json));
    });
  } finally {
    await rm(beforeM4, { recursive: true, force: true });
    await database.drop();
  }
});
