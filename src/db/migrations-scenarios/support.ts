import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import pg from "pg";

import { documentInputSchema } from "../../documents.ts";
import { sortedMigrationFileNames } from "../../migration-files.ts";
import { runMigrations } from "../migrations.server.ts";

import { temporaryDatabase, withClient } from "../database-fixture.ts";

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
const RETIRE_ARUBA_BROWSER_STATE = "044_retire_aruba_browser_state.sql";
const REMOVE_ARUBA_BROWSER_LEGACY = "045_remove_aruba_browser_legacy.sql";
const EBAY_DELIVERY_DISCOUNT_REPLAY = "046_ebay_delivery_discount_replay.sql";
const SWITZERLAND_CUSTOMER_SUPPORT = "047_switzerland_customer_support.sql";
const OPERATIONAL_CONTROLS = "048_operational_controls.sql";
const EBAY_CONTROL_ALIGNMENT_REPLAY = "049_ebay_control_alignment_replay.sql";
const EBAY_NULL_EMAIL_ALIGNMENT_REPLAY = "050_ebay_null_email_alignment_replay.sql";
const CUSTOMER_IDENTITY_EXCEPTIONS = "051_customer_identity_exceptions.sql";
const RECONCILE_APPROVED_INVOICE_MEMBERSHIPS = "052_reconcile_approved_invoice_memberships.sql";
const AUTOMATIC_CUSTOMER_IDENTITY_EXCEPTIONS = "053_automatic_customer_identity_exceptions.sql";
const SHOPIFY_BANK_TRANSFER_ROUNDING_REPLAY = "054_shopify_bank_transfer_rounding_replay.sql";
const SOURCE_CONFLICT_MARKER_BACKFILL = "055_source_conflict_marker_backfill.sql";
const EBAY_SHIPPING_REFUND_REPLAY = "056_ebay_shipping_refund_replay.sql";
const SHOPIFY_IDENTITY_FULFILLMENT_REPLAY = "057_shopify_identity_and_fulfillment_replay.sql";
const EBAY_REFUND_MAPPER_CONFLICT_REPLAY = "058_ebay_refund_mapper_conflict_replay.sql";
const ARUBA_FOREIGN_CONSUMER_MATCH_REPLAY = "059_aruba_foreign_consumer_match_replay.sql";
const ARUBA_ERROR_RETRY = "060_aruba_error_retry.sql";
const SHOPIFY_PRIVATE_RECIPIENT_REPLAY = "061_shopify_private_recipient_replay.sql";
const ARUBA_IDENTITY_EVIDENCE_REPLAY = "062_reconcile_aruba_identity_evidence.sql";
const ARUBA_HISTORICAL_API_RECOVERY = "063_aruba_historical_api_recovery.sql";
const OPERATIONAL_WORKFLOW_1_1 = "064_operational_workflow_1_1.sql";
const INVOICE_SOURCE_PREPARATIONS = "065_invoice_source_preparations.sql";
const EBAY_CARE_OF_ADDRESS_REPLAY = "066_ebay_care_of_address_replay.sql";
const EBAY_PAYMENT_TIMESTAMP_REPLAY = "067_ebay_payment_timestamp_replay.sql";
const EBAY_PARTIAL_REFUND_PAYMENT_STATUS = "068_ebay_partial_refund_payment_status.sql";
const CURRENT_MIGRATIONS = sortedMigrationFileNames(readdirSync("migrations"));
const outboundIndex = CURRENT_MIGRATIONS.indexOf(ARUBA_API_OUTBOUND);
assert.notEqual(outboundIndex, -1, `${ARUBA_API_OUTBOUND} assente dal catalogo migrazioni`);
const MIGRATIONS_AFTER_ARUBA_API_OUTBOUND = CURRENT_MIGRATIONS.slice(outboundIndex + 1);

function migrationsFrom(firstMigration: string) {
  const index = CURRENT_MIGRATIONS.indexOf(firstMigration);
  assert.notEqual(index, -1, `${firstMigration} assente dal catalogo migrazioni`);
  return CURRENT_MIGRATIONS.slice(index);
}

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

async function removeMigrationsFrom(directory: string, firstMigration: string) {
  for (const migration of sortedMigrationFileNames(await readdir(directory))) {
    if (migration >= firstMigration) await rm(path.join(directory, migration));
  }
}

export {
  assert,
  readdirSync,
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  os,
  path,
  test,
  pg,
  documentInputSchema,
  sortedMigrationFileNames,
  runMigrations,
  temporaryDatabase,
  withClient,
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
  RETIRE_ARUBA_BROWSER_STATE,
  REMOVE_ARUBA_BROWSER_LEGACY,
  EBAY_DELIVERY_DISCOUNT_REPLAY,
  SWITZERLAND_CUSTOMER_SUPPORT,
  OPERATIONAL_CONTROLS,
  EBAY_CONTROL_ALIGNMENT_REPLAY,
  EBAY_NULL_EMAIL_ALIGNMENT_REPLAY,
  CUSTOMER_IDENTITY_EXCEPTIONS,
  RECONCILE_APPROVED_INVOICE_MEMBERSHIPS,
  AUTOMATIC_CUSTOMER_IDENTITY_EXCEPTIONS,
  SHOPIFY_BANK_TRANSFER_ROUNDING_REPLAY,
  SOURCE_CONFLICT_MARKER_BACKFILL,
  EBAY_SHIPPING_REFUND_REPLAY,
  SHOPIFY_IDENTITY_FULFILLMENT_REPLAY,
  EBAY_REFUND_MAPPER_CONFLICT_REPLAY,
  ARUBA_FOREIGN_CONSUMER_MATCH_REPLAY,
  ARUBA_ERROR_RETRY,
  SHOPIFY_PRIVATE_RECIPIENT_REPLAY,
  ARUBA_IDENTITY_EVIDENCE_REPLAY,
  ARUBA_HISTORICAL_API_RECOVERY,
  OPERATIONAL_WORKFLOW_1_1,
  INVOICE_SOURCE_PREPARATIONS,
  EBAY_CARE_OF_ADDRESS_REPLAY,
  EBAY_PAYMENT_TIMESTAMP_REPLAY,
  EBAY_PARTIAL_REFUND_PAYMENT_STATUS,
  CURRENT_MIGRATIONS,
  outboundIndex,
  MIGRATIONS_AFTER_ARUBA_API_OUTBOUND,
  copyMigrationSnapshot,
  migrationsFrom,
  removeMigrationsFrom,
};
