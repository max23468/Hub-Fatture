import assert from "node:assert/strict";
import test from "node:test";

import type { BackupReceipt } from "./system.server.ts";
import { isBackupReceiptCurrent } from "./system.server.ts";
import { assertRetentionBackupVerified } from "./retention.server.ts";

const receiptAt = (completedAt: string): BackupReceipt => ({
  status: "ok",
  completedAt,
  commit: "b".repeat(40),
  imageDigest: `sha256:${"c".repeat(64)}`,
  objectName: "hub-fatture/current/latest.tar.age",
  archiveObjectName: "hub-fatture/archive/synthetic-database.tar.age",
  archiveKind: "DATABASE_JOURNAL",
  archiveSha256: "d".repeat(64),
  archiveSizeBytes: 128,
  reason: "synthetic",
  schema: "999_synthetic.sql",
  sha256: "a".repeat(64),
  sizeBytes: 1024,
  version: "0.0.0-test",
});

test("la retention Production richiede una ricevuta backup corrente", () => {
  const now = new Date("2026-08-13T10:00:00.000Z");
  const current = receiptAt("2026-08-11T22:00:01.000Z");
  const stale = receiptAt("2026-08-11T22:00:00.000Z");
  const future = receiptAt("2026-08-13T10:00:01.000Z");

  assert.equal(isBackupReceiptCurrent(current, now), true);
  assert.equal(isBackupReceiptCurrent(stale, now), false);
  assert.equal(isBackupReceiptCurrent(future, now), false);
  assert.doesNotThrow(() => assertRetentionBackupVerified("production", current, now));
  assert.throws(
    () => assertRetentionBackupVerified("production", null, now),
    /Retention bloccata: ricevuta del backup verificato assente/i,
  );
  assert.throws(
    () => assertRetentionBackupVerified("production", stale, now),
    /Retention bloccata: ricevuta del backup verificato assente/i,
  );
  assert.throws(
    () => assertRetentionBackupVerified("production", future, now),
    /Retention bloccata: ricevuta del backup verificato assente/i,
  );
});

test("gli ambienti sintetici non richiedono un backup Production", () => {
  assert.doesNotThrow(() => assertRetentionBackupVerified("development", null));
  assert.doesNotThrow(() => assertRetentionBackupVerified("test", null));
});
