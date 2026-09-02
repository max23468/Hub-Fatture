import { randomUUID } from "node:crypto";

import type pg from "pg";

import { getConfig } from "../config.server.ts";
import { getPool, withTransaction } from "./client.server.ts";
import { writeAudit } from "./audit.server.ts";
import { isBackupReceiptCurrent, readBackupReceipt, type BackupReceipt } from "./system.server.ts";

export const LOGIN_ATTEMPT_WINDOW_MINUTES = 15;
// La cadenza non supera la finestra: un `ip_hash` non deve sopravvivere alla durata dichiarata.
const INTERVAL_MS = LOGIN_ATTEMPT_WINDOW_MINUTES * 60 * 1000;

export const retentionDataClasses = [
  "SOURCE_PAYLOADS",
  "OPERATIONAL_JOBS",
  "OPERATIONAL_AUDIT",
  "CUSTOMER_EMAIL",
] as const;

export type RetentionDataClass = (typeof retentionDataClasses)[number];
export type RetentionResult = Record<RetentionDataClass, number>;

const emptyResult = (): RetentionResult => ({
  SOURCE_PAYLOADS: 0,
  OPERATIONAL_JOBS: 0,
  OPERATIONAL_AUDIT: 0,
  CUSTOMER_EMAIL: 0,
});

export function assertRetentionBackupVerified(
  environment: "development" | "production" | "test",
  receipt: BackupReceipt | null,
  now = new Date(),
): void {
  if (environment === "production" && !isBackupReceiptCurrent(receipt, now)) {
    throw new Error(
      "Retention bloccata: ricevuta del backup verificato assente, non valida o più vecchia di 36 ore",
    );
  }
}

/**
 * Cancella i dati tecnici scaduti richiesti da 17.7: sessioni oltre la scadenza e tentativi
 * di accesso oltre la finestra, con l'`ip_hash` che portano. Deve dipendere dal tempo, non
 * dall'arrivo del prossimo login, altrimenti un'app inattiva li conserva a tempo indefinito.
 */
export async function pruneExpired(): Promise<void> {
  await getPool().query("DELETE FROM sessions WHERE expires_at <= now()");
  await getPool().query(
    `DELETE FROM login_attempts
     WHERE attempted_at <= now() - interval '${LOGIN_ATTEMPT_WINDOW_MINUTES} minutes'`,
  );
}

async function classHeld(client: pg.PoolClient, dataClass: RetentionDataClass): Promise<boolean> {
  const result = await client.query<{ held: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM retention_holds
       WHERE data_class = $1 AND released_at IS NULL
     ) AS held`,
    [dataClass],
  );
  // Un riesame scaduto non libera automaticamente il dato: il rilascio deve essere esplicito.
  return result.rows[0]?.held ?? true;
}

async function recordRetention(
  client: pg.PoolClient,
  dataClass: RetentionDataClass,
  affectedCount: number,
  requestId: string,
): Promise<void> {
  if (affectedCount === 0) return;
  await writeAudit(client, {
    actorType: "SYSTEM",
    action: "RETENTION_APPLIED",
    eventClass: "OPERATIONAL",
    entityType: "JOB",
    metadata: { dataClass, affectedCount },
    requestId,
  });
}

/**
 * Applica soltanto la retention tecnica approvata. Documenti fiscali, file Aruba/SdI,
 * dati normalizzati e audit critici non sono candidati di queste query.
 */
export async function applyRetentionPolicy(): Promise<RetentionResult> {
  const config = getConfig();
  assertRetentionBackupVerified(config.APP_ENV, await readBackupReceipt());

  return withTransaction(async (client) => {
    const result = emptyResult();
    const lock = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(764489133208) AS locked",
    );
    if (!lock.rows[0]?.locked) return result;

    const requestId = `retention-${randomUUID()}`;

    if (!(await classHeld(client, "SOURCE_PAYLOADS"))) {
      const webhooks = await client.query(
        `UPDATE webhook_events
         SET request_payload_json = '{}'::jsonb
         WHERE status = 'PROCESSED'
           AND coalesce(processed_at, received_at) <= now() - interval '30 days'
           AND request_payload_json <> '{}'::jsonb`,
      );
      const refunds = await client.query(
        `UPDATE refunds
         SET raw_json = '{}'::jsonb
         WHERE status = 'COMPLETED'
           AND coalesce(completed_at, updated_at) <= now() - interval '30 days'
           AND raw_json <> '{}'::jsonb`,
      );
      const orders = await client.query(
        `UPDATE orders
         SET raw_snapshot_json = '{}'::jsonb
         WHERE last_synced_at <= now() - interval '30 days'
           AND trigger_status <> 'NEEDS_REVIEW'
           AND (
             NOT coalesce((normalized_snapshot_json ->> 'historical')::boolean, false)
             OR historical_reconciliation_outcome IS NOT NULL
           )
           AND raw_snapshot_json <> '{}'::jsonb`,
      );
      const orderLines = await client.query(
        `UPDATE order_lines
         SET raw_json = '{}'::jsonb
         FROM orders
         WHERE order_lines.order_id = orders.id
           AND orders.last_synced_at <= now() - interval '30 days'
           AND orders.trigger_status <> 'NEEDS_REVIEW'
           AND (
             NOT coalesce((orders.normalized_snapshot_json ->> 'historical')::boolean, false)
             OR orders.historical_reconciliation_outcome IS NOT NULL
           )
           AND order_lines.raw_json <> '{}'::jsonb`,
      );
      const payments = await client.query(
        `UPDATE payments
         SET raw_json = '{}'::jsonb
         FROM orders
         WHERE payments.order_id = orders.id
           AND orders.last_synced_at <= now() - interval '30 days'
           AND orders.trigger_status <> 'NEEDS_REVIEW'
           AND (
             NOT coalesce((orders.normalized_snapshot_json ->> 'historical')::boolean, false)
             OR orders.historical_reconciliation_outcome IS NOT NULL
           )
           AND payments.raw_json <> '{}'::jsonb`,
      );
      const customerSources = await client.query(
        `UPDATE customer_source_records
         SET raw_snapshot_json = '{}'::jsonb
         WHERE imported_at <= now() - interval '30 days'
           AND raw_snapshot_json <> '{}'::jsonb
           AND NOT EXISTS (
             SELECT 1 FROM orders
             WHERE orders.customer_id = customer_source_records.customer_id
               AND orders.provider = customer_source_records.provider
               AND (
                 orders.last_synced_at > now() - interval '30 days'
                 OR orders.trigger_status = 'NEEDS_REVIEW'
                 OR (
                   coalesce((orders.normalized_snapshot_json ->> 'historical')::boolean, false)
                   AND orders.historical_reconciliation_outcome IS NULL
                 )
               )
           )`,
      );
      result.SOURCE_PAYLOADS =
        (webhooks.rowCount ?? 0) +
        (refunds.rowCount ?? 0) +
        (orders.rowCount ?? 0) +
        (orderLines.rowCount ?? 0) +
        (payments.rowCount ?? 0) +
        (customerSources.rowCount ?? 0);
      await recordRetention(client, "SOURCE_PAYLOADS", result.SOURCE_PAYLOADS, requestId);
    }

    if (!(await classHeld(client, "OPERATIONAL_JOBS"))) {
      const jobs = await client.query(
        `DELETE FROM jobs
         WHERE status IN ('COMPLETED', 'FAILED')
           AND coalesce(completed_at, created_at) <= now() - interval '180 days'`,
      );
      result.OPERATIONAL_JOBS = jobs.rowCount ?? 0;
      await recordRetention(client, "OPERATIONAL_JOBS", result.OPERATIONAL_JOBS, requestId);
    }

    if (!(await classHeld(client, "OPERATIONAL_AUDIT"))) {
      const audit = await client.query(
        `DELETE FROM audit_events
         WHERE event_class = 'OPERATIONAL'
           AND created_at <= now() - interval '180 days'`,
      );
      result.OPERATIONAL_AUDIT = audit.rowCount ?? 0;
      await recordRetention(client, "OPERATIONAL_AUDIT", result.OPERATIONAL_AUDIT, requestId);
    }

    if (!(await classHeld(client, "CUSTOMER_EMAIL"))) {
      const deliveries = await client.query<{ document_id: string }>(
        `UPDATE email_deliveries
         SET sender = '[redatto]', recipient = '[redatto]', subject = '[redatto]',
             body = '[redatto]', content_redacted_at = now()
         WHERE status IN ('SENT', 'FAILED')
           AND coalesce(sent_at, updated_at) <= now() - interval '90 days'
           AND content_redacted_at IS NULL
         RETURNING document_id`,
      );
      const documentIds = [...new Set(deliveries.rows.map(({ document_id }) => document_id))];
      if (documentIds.length > 0) {
        await client.query(
          `UPDATE documents
           SET customer_email_sender = '[redatto]', customer_email_recipient = '[redatto]',
               customer_email_subject = '[redatto]', customer_email_body = '[redatto]',
               customer_email_redacted_at = now()
           WHERE id = ANY($1::bigint[])
             AND customer_email_choice = 'SEND'
             AND customer_email_redacted_at IS NULL`,
          [documentIds],
        );
      }
      const expiredMetadata = await client.query(
        `DELETE FROM email_deliveries
         WHERE content_redacted_at IS NOT NULL
           AND coalesce(sent_at, updated_at, created_at) <= now() - interval '24 months'`,
      );
      result.CUSTOMER_EMAIL = (deliveries.rowCount ?? 0) + (expiredMetadata.rowCount ?? 0);
      await recordRetention(client, "CUSTOMER_EMAIL", result.CUSTOMER_EMAIL, requestId);
    }

    return result;
  });
}

// Le pulizie brevi legate all'autenticazione restano nel processo web. La policy completa,
// che richiede ricevuta, retry e osservabilità, viene invece eseguita dal worker.
export function startRetention(): void {
  const run = () => void pruneExpired().catch((error: unknown) => console.error(error));
  run();
  setInterval(run, INTERVAL_MS).unref();
}
