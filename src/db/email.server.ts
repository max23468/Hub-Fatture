import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import nodemailer from "nodemailer";
import type pg from "pg";
import { z } from "zod";

import { getConfig } from "../config.server.ts";
import { AppError } from "../errors.ts";
import { writeAudit } from "./audit.server.ts";
import { assertJobLease, type ClaimedJob } from "./connectors.server.ts";
import { getPool, withTransaction } from "./client.server.ts";
import { isDatabaseId } from "./database-id.ts";

export const customerEmailModeSchema = z.enum(["AUTOMATIC", "MANUAL", "DISABLED"]);
export const customerEmailChoiceSchema = z.enum(["SEND", "SKIP"]);
const recipientSchema = z.email().max(256);
const subject = "Il tuo documento fiscale";
const body = "In allegato trovi la copia leggibile del documento fiscale.";
const customerEmailSendLock = "customer-email-send";

async function withCustomerEmailSendLock<T>(callback: () => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [customerEmailSendLock]);
    return await callback();
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
      customerEmailSendLock,
    ]);
    client.release();
  }
}

async function customerEmailIsDisabled(client: pg.PoolClient): Promise<boolean> {
  const result = await client.query<{ value_json: unknown }>(
    "SELECT value_json FROM settings WHERE key = 'customer_email_mode'",
  );
  return customerEmailModeSchema.parse(result.rows[0]?.value_json ?? "AUTOMATIC") === "DISABLED";
}

export function customerEmailTriggerStatus(status: string): boolean {
  return status === "DELIVERED" || status === "NOT_DELIVERED";
}

export async function getCustomerEmailSettings() {
  const result = await getPool().query<{ value_json: unknown; version: number }>(
    "SELECT value_json, version FROM settings WHERE key = 'customer_email_mode'",
  );
  const config = getConfig();
  return {
    mode: customerEmailModeSchema.parse(result.rows[0]?.value_json ?? "AUTOMATIC"),
    version: result.rows[0]?.version ?? 1,
    transport: config.SMTP_TRANSPORT,
    sender: config.SMTP_FROM,
    configured:
      config.SMTP_TRANSPORT === "SYNTHETIC" ||
      Boolean(config.SMTP_HOST && config.SMTP_USERNAME && config.SMTP_PASSWORD),
  };
}

export async function setCustomerEmailMode(
  rawMode: unknown,
  rawVersion: unknown,
  actor: { id: number; canApprove: boolean; requestId: string },
) {
  if (!actor.canApprove) throw new AppError("EMAIL_DELIVERY_FORBIDDEN", 403);
  const mode = customerEmailModeSchema.safeParse(rawMode);
  const version = Number(rawVersion);
  if (!mode.success || !Number.isInteger(version) || version < 1) {
    throw new AppError("CONFLICT_REVISION", 409);
  }
  await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      customerEmailSendLock,
    ]);
    const updated = await client.query(
      `UPDATE settings SET value_json = $2, version = version + 1, updated_at = now()
       WHERE key = 'customer_email_mode' AND version = $1`,
      [version, JSON.stringify(mode.data)],
    );
    if (updated.rowCount !== 1) throw new AppError("CONFLICT_REVISION", 409);
    if (mode.data === "DISABLED") {
      await client.query(
        `WITH active_deliveries AS MATERIALIZED (
           SELECT payload_json ->> 'deliveryId' AS id
           FROM jobs
           WHERE type = 'send_customer_email' AND status IN ('PENDING', 'RUNNING')
         ), suppressed AS (
           UPDATE email_deliveries SET status = 'FAILED', send_started_at = NULL,
             last_error_code = 'EMAIL_DELIVERY_DISABLED',
             last_error_sanitized = 'EMAIL_DELIVERY_DISABLED', updated_at = now()
           WHERE send_started_at IS NULL
             AND (status = 'PENDING' OR (
               status = 'FAILED' AND id::text IN (SELECT id FROM active_deliveries)
             ))
           RETURNING id
         ), completed_jobs AS (
           UPDATE jobs SET status = 'COMPLETED', completed_at = now(),
             lease_expires_at = NULL, locked_by = NULL, claim_token = NULL,
             result_json = '{"emailDisabled":true}'::jsonb, last_error_code = NULL
           WHERE type = 'send_customer_email' AND status IN ('PENDING', 'RUNNING')
             AND payload_json ->> 'deliveryId' IN (SELECT id::text FROM suppressed)
           RETURNING id
         ), suppression_audits AS (
           INSERT INTO audit_events
             (actor_type, actor_id, action, event_class, entity_type, entity_id,
              metadata_json, reason, request_id)
           SELECT 'ADMIN', $1, 'CUSTOMER_EMAIL_SUPPRESSED', 'CRITICAL',
             'EMAIL_DELIVERY', id, '{}'::jsonb, 'EMAIL_DELIVERY_DISABLED', $2
           FROM suppressed
           RETURNING entity_id
         )
         SELECT entity_id FROM suppression_audits`,
        [String(actor.id), actor.requestId],
      );
    }
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "CUSTOMER_EMAIL_SETTINGS_CHANGED",
      eventClass: "CRITICAL",
      entityType: "SETTING",
      entityId: "customer_email_mode",
      after: { mode: mode.data },
      requestId: actor.requestId,
    });
  });
}

export async function customerEmailPreview(
  caseId: string,
  settings?: Awaited<ReturnType<typeof getCustomerEmailSettings>>,
) {
  const previewSettings = settings ?? (await getCustomerEmailSettings());
  const result = await getPool().query<{ recipient: string | null }>(
    `SELECT customer_snapshot_json ->> 'email' AS recipient
     FROM billing_cases WHERE id = $1`,
    [caseId],
  );
  const parsedRecipient = recipientSchema.safeParse(result.rows[0]?.recipient);
  return {
    ...previewSettings,
    recipient: parsedRecipient.success ? parsedRecipient.data : null,
    subject,
    body,
    attachment: "PDF ufficiale Aruba, dopo l’esito SdI",
  };
}

export async function snapshotDocumentEmail(
  client: pg.PoolClient,
  documentId: string,
  rawChoice: unknown,
  rawModeVersion: unknown,
) {
  const choice = customerEmailChoiceSchema.safeParse(rawChoice);
  const expectedVersion = Number(rawModeVersion);
  if (!choice.success || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new AppError("DOCUMENT_NOT_APPROVABLE", 409);
  }
  const mode = await client.query<{ value_json: unknown; version: number }>(
    "SELECT value_json, version FROM settings WHERE key = 'customer_email_mode' FOR SHARE",
  );
  if (mode.rows[0]?.version !== expectedVersion) throw new AppError("CONFLICT_REVISION", 409);
  const emailMode = customerEmailModeSchema.parse(mode.rows[0]?.value_json ?? "AUTOMATIC");
  if (emailMode === "DISABLED" && choice.data !== "SKIP") {
    throw new AppError("EMAIL_DELIVERY_DISABLED", 409);
  }
  if (choice.data === "SKIP") {
    await client.query(
      `UPDATE documents SET customer_email_mode = $2, customer_email_choice = 'SKIP',
         customer_email_sender = NULL, customer_email_recipient = NULL,
         customer_email_subject = NULL,
         customer_email_body = NULL WHERE id = $1`,
      [documentId, emailMode],
    );
    return;
  }
  const recipient = await client.query<{ email: string | null }>(
    `SELECT billing_cases.customer_snapshot_json ->> 'email' AS email
     FROM documents JOIN billing_cases ON billing_cases.id = documents.billing_case_id
     WHERE documents.id = $1`,
    [documentId],
  );
  const parsed = recipientSchema.safeParse(recipient.rows[0]?.email);
  if (!parsed.success) throw new AppError("EMAIL_RECIPIENT_MISSING", 409);
  await client.query(
    `UPDATE documents SET customer_email_mode = $2, customer_email_choice = 'SEND',
       customer_email_sender = $3, customer_email_recipient = $4,
       customer_email_subject = $5, customer_email_body = $6 WHERE id = $1`,
    [documentId, emailMode, getConfig().SMTP_FROM, parsed.data, subject, body],
  );
}

async function insertDelivery(client: pg.PoolClient, documentId: string, force = false) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `customer-email:${documentId}`,
  ]);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    customerEmailSendLock,
  ]);
  if (await customerEmailIsDisabled(client)) return null;
  const config = getConfig();
  if (!force) {
    const existing = await client.query(
      "SELECT 1 FROM email_deliveries WHERE document_id = $1 LIMIT 1",
      [documentId],
    );
    if (existing.rows[0]) return null;
  }
  const candidate = await client.query<{
    sender: string;
    recipient: string;
    subject: string;
    body: string;
    attachment_id: string;
  }>(
    `SELECT documents.customer_email_sender AS sender,
            documents.customer_email_recipient AS recipient,
            documents.customer_email_subject AS subject,
            documents.customer_email_body AS body,
            pdf.storage_object_id AS attachment_id
     FROM documents
     JOIN LATERAL (
       SELECT aruba_files.storage_object_id
       FROM aruba_files
       WHERE aruba_files.document_id = documents.id AND aruba_files.kind = 'ARUBA_PDF'
       ORDER BY aruba_files.imported_at DESC, aruba_files.id DESC LIMIT 1
     ) AS pdf ON true
     WHERE documents.id = $1 AND documents.status = 'APPROVED'
       AND documents.customer_email_choice = 'SEND'
       AND EXISTS (
         SELECT 1 FROM aruba_submissions
         WHERE aruba_submissions.document_id = documents.id
           AND aruba_submissions.status IN ('DELIVERED', 'NOT_DELIVERED')
       )`,
    [documentId],
  );
  const row = candidate.rows[0];
  if (!row) return null;
  const delivery = await client.query<{ id: string }>(
    `INSERT INTO email_deliveries
      (message_key, document_id, transport, sender, recipient, subject, body,
       attachment_storage_object_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (document_id) WHERE status = 'PENDING' DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      documentId,
      config.SMTP_TRANSPORT,
      row.sender,
      row.recipient,
      row.subject,
      row.body,
      row.attachment_id,
    ],
  );
  if (!delivery.rows[0]) return null;
  await client.query(
    `INSERT INTO jobs (type, payload_json)
     VALUES ('send_customer_email', jsonb_build_object('deliveryId', $1::text))
     ON CONFLICT DO NOTHING`,
    [delivery.rows[0].id],
  );
  await writeAudit(client, {
    actorType: "SYSTEM",
    action: "CUSTOMER_EMAIL_QUEUED",
    eventClass: "CRITICAL",
    entityType: "EMAIL_DELIVERY",
    entityId: delivery.rows[0].id,
    requestId: `customer-email:${delivery.rows[0].id}`,
  });
  return delivery.rows[0].id;
}

export async function scheduleCustomerEmail(client: pg.PoolClient, documentId: string) {
  return insertDelivery(client, documentId);
}

interface DeliveryRow {
  id: string;
  message_key: string;
  transport: "SYNTHETIC" | "EXISTING_SMTP" | "OCI_EMAIL_DELIVERY";
  sender: string;
  recipient: string;
  subject: string;
  body: string;
  status: "PENDING" | "SENT" | "FAILED";
  attempt_count: number;
  send_started_at: Date | null;
  last_error_code: string | null;
  relative_path: string;
  sha256: string;
  size_bytes: number;
}

async function loadDelivery(client: pg.PoolClient, id: string) {
  const result = await client.query<DeliveryRow>(
    `SELECT email_deliveries.*, storage_objects.relative_path, storage_objects.sha256,
            storage_objects.size_bytes
     FROM email_deliveries
     JOIN storage_objects ON storage_objects.id = email_deliveries.attachment_storage_object_id
     WHERE email_deliveries.id = $1 FOR UPDATE OF email_deliveries`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function smtpSend(delivery: DeliveryRow, attachment: Buffer): Promise<string> {
  const config = getConfig();
  if (
    delivery.transport !== "SYNTHETIC" &&
    (!config.SMTP_HOST || !config.SMTP_USERNAME || !config.SMTP_PASSWORD)
  ) {
    throw new AppError("EMAIL_CONFIGURATION_MISSING", 503);
  }
  const transporter =
    delivery.transport === "SYNTHETIC"
      ? nodemailer.createTransport({ jsonTransport: true })
      : nodemailer.createTransport({
          host: config.SMTP_HOST,
          port: config.SMTP_PORT,
          secure: config.SMTP_SECURE,
          requireTLS: true,
          auth: { user: config.SMTP_USERNAME, pass: config.SMTP_PASSWORD },
          connectionTimeout: 15_000,
          greetingTimeout: 15_000,
          socketTimeout: 30_000,
        });
  const domain = delivery.sender.split("@")[1] ?? "localhost";
  const info = await transporter.sendMail({
    from: delivery.sender,
    envelope: { from: delivery.sender, to: delivery.recipient },
    to: delivery.recipient,
    subject: delivery.subject,
    text: delivery.body,
    messageId: `<${delivery.message_key}@${domain}>`,
    attachments: [{ filename: "documento-fiscale.pdf", content: attachment }],
  });
  return info.messageId;
}

function smtpFailureKind(error: unknown): "TEMPORARY" | "PERMANENT" | "UNCERTAIN" {
  if (error instanceof AppError && error.code === "EMAIL_CONFIGURATION_MISSING") {
    return "PERMANENT";
  }
  if (!error || typeof error !== "object") return "UNCERTAIN";
  const failure = error as { responseCode?: unknown; command?: unknown };
  const responseCode = Number(failure.responseCode);
  if (Number.isInteger(responseCode) && responseCode >= 400 && responseCode <= 499) {
    return "TEMPORARY";
  }
  if (Number.isInteger(responseCode) && responseCode >= 500 && responseCode <= 599) {
    return "PERMANENT";
  }
  const command = String(failure.command ?? "");
  if (command === "CONN") return "TEMPORARY";
  if (["AUTH", "EHLO", "HELO", "STARTTLS"].includes(command)) return "PERMANENT";
  return "UNCERTAIN";
}

export async function sendCustomerEmail(
  job: ClaimedJob,
  send: (delivery: DeliveryRow, attachment: Buffer) => Promise<string> = smtpSend,
) {
  const deliveryId = String(job.payload.deliveryId ?? "");
  if (!isDatabaseId(deliveryId)) throw new AppError("EMAIL_DELIVERY_FAILED", 422);
  const start = await withTransaction(async (client) => {
    await assertJobLease(client, job);
    const current = await loadDelivery(client, deliveryId);
    if (!current || current.status === "SENT") return null;
    if (current.send_started_at) {
      await client.query(
        `UPDATE email_deliveries SET status = 'FAILED',
           last_error_code = 'EMAIL_DELIVERY_UNCERTAIN',
           last_error_sanitized = 'EMAIL_DELIVERY_UNCERTAIN', updated_at = now()
         WHERE id = $1`,
        [deliveryId],
      );
      await writeAudit(client, {
        actorType: "SYSTEM",
        action: "CUSTOMER_EMAIL_FAILED",
        eventClass: "CRITICAL",
        entityType: "EMAIL_DELIVERY",
        entityId: deliveryId,
        reason: "EMAIL_DELIVERY_UNCERTAIN",
        requestId: `customer-email:${deliveryId}`,
      });
      return { uncertain: true as const };
    }
    if (await customerEmailIsDisabled(client)) {
      await client.query(
        `UPDATE email_deliveries SET status = 'FAILED', send_started_at = NULL,
           last_error_code = 'EMAIL_DELIVERY_DISABLED',
           last_error_sanitized = 'EMAIL_DELIVERY_DISABLED', updated_at = now()
         WHERE id = $1`,
        [deliveryId],
      );
      await writeAudit(client, {
        actorType: "SYSTEM",
        action: "CUSTOMER_EMAIL_SUPPRESSED",
        eventClass: "CRITICAL",
        entityType: "EMAIL_DELIVERY",
        entityId: deliveryId,
        reason: "EMAIL_DELIVERY_DISABLED",
        requestId: `customer-email:${deliveryId}`,
      });
      return null;
    }
    return { uncertain: false as const, delivery: current };
  });
  if (!start) return;
  if (start.uncertain) throw new AppError("EMAIL_DELIVERY_UNCERTAIN", 409);
  const delivery = start.delivery;
  const storageRoot = path.resolve(getConfig().DOCUMENT_STORAGE_ROOT);
  const attachmentPath = path.resolve(storageRoot, delivery.relative_path);
  if (!attachmentPath.startsWith(`${storageRoot}${path.sep}`)) {
    await failDelivery(deliveryId, "EMAIL_ATTACHMENT_MISSING");
    throw new AppError("EMAIL_ATTACHMENT_MISSING", 409);
  }
  let attachment: Buffer;
  try {
    attachment = await readFile(attachmentPath);
    if (
      attachment.byteLength !== delivery.size_bytes ||
      createHash("sha256").update(attachment).digest("hex") !== delivery.sha256
    ) {
      throw new Error("invalid attachment");
    }
  } catch {
    await failDelivery(deliveryId, "EMAIL_ATTACHMENT_MISSING");
    throw new AppError("EMAIL_ATTACHMENT_MISSING", 409);
  }
  await withCustomerEmailSendLock(async () => {
    const ready = await withTransaction(async (client) => {
      await assertJobLease(client, job);
      if (await customerEmailIsDisabled(client)) {
        await client.query(
          `UPDATE email_deliveries SET status = 'FAILED', send_started_at = NULL,
             last_error_code = 'EMAIL_DELIVERY_DISABLED',
             last_error_sanitized = 'EMAIL_DELIVERY_DISABLED', updated_at = now()
           WHERE id = $1`,
          [deliveryId],
        );
        await writeAudit(client, {
          actorType: "SYSTEM",
          action: "CUSTOMER_EMAIL_SUPPRESSED",
          eventClass: "CRITICAL",
          entityType: "EMAIL_DELIVERY",
          entityId: deliveryId,
          reason: "EMAIL_DELIVERY_DISABLED",
          requestId: `customer-email:${deliveryId}`,
        });
        return false;
      }
      const started = await client.query(
        `UPDATE email_deliveries SET status = 'PENDING', attempt_count = attempt_count + 1,
           send_started_at = now(), last_error_code = NULL, last_error_sanitized = NULL,
           updated_at = now() WHERE id = $1 AND send_started_at IS NULL`,
        [deliveryId],
      );
      if (started.rowCount !== 1) throw new AppError("EMAIL_DELIVERY_UNCERTAIN", 409);
      return true;
    });
    if (!ready) return;

    let messageId: string;
    try {
      messageId = await send(delivery, attachment);
    } catch (error) {
      if (error instanceof AppError && error.code === "EMAIL_CONFIGURATION_MISSING") {
        await failDelivery(deliveryId, "EMAIL_CONFIGURATION_MISSING");
        throw error;
      }
      const failureKind = smtpFailureKind(error);
      if (failureKind === "TEMPORARY") {
        await failDelivery(deliveryId, "EMAIL_DELIVERY_TEMPORARY");
        throw new AppError("EMAIL_DELIVERY_TEMPORARY", 503);
      }
      if (failureKind === "PERMANENT") {
        await failDelivery(deliveryId, "EMAIL_DELIVERY_FAILED");
        throw new AppError("EMAIL_DELIVERY_FAILED", 503);
      }
      await uncertainDelivery(deliveryId);
      throw new AppError("EMAIL_DELIVERY_UNCERTAIN", 409);
    }
    try {
      await withTransaction(async (client) => {
        const sent = await client.query(
          `UPDATE email_deliveries SET status = 'SENT', message_id = $2, sent_at = now(),
             updated_at = now() WHERE id = $1 AND status = 'PENDING' AND send_started_at IS NOT NULL`,
          [deliveryId, messageId],
        );
        if (sent.rowCount !== 1) throw new AppError("EMAIL_DELIVERY_UNCERTAIN", 409);
        await writeAudit(client, {
          actorType: "SYSTEM",
          action: "CUSTOMER_EMAIL_SENT",
          eventClass: "CRITICAL",
          entityType: "EMAIL_DELIVERY",
          entityId: deliveryId,
          requestId: `customer-email:${deliveryId}`,
        });
      });
    } catch {
      await uncertainDelivery(deliveryId);
      throw new AppError("EMAIL_DELIVERY_UNCERTAIN", 409);
    }
  });
}

async function uncertainDelivery(id: string) {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE email_deliveries SET status = 'FAILED',
         last_error_code = 'EMAIL_DELIVERY_UNCERTAIN',
         last_error_sanitized = 'EMAIL_DELIVERY_UNCERTAIN', updated_at = now()
       WHERE id = $1`,
      [id],
    );
    await writeAudit(client, {
      actorType: "SYSTEM",
      action: "CUSTOMER_EMAIL_FAILED",
      eventClass: "CRITICAL",
      entityType: "EMAIL_DELIVERY",
      entityId: id,
      reason: "EMAIL_DELIVERY_UNCERTAIN",
      requestId: `customer-email:${id}`,
    });
  });
}

async function failDelivery(
  id: string,
  code:
    | "EMAIL_ATTACHMENT_MISSING"
    | "EMAIL_CONFIGURATION_MISSING"
    | "EMAIL_DELIVERY_FAILED"
    | "EMAIL_DELIVERY_TEMPORARY",
) {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE email_deliveries SET status = 'FAILED', last_error_code = $2,
         last_error_sanitized = $2, send_started_at = NULL, updated_at = now() WHERE id = $1`,
      [id, code],
    );
    await writeAudit(client, {
      actorType: "SYSTEM",
      action: "CUSTOMER_EMAIL_FAILED",
      eventClass: "CRITICAL",
      entityType: "EMAIL_DELIVERY",
      entityId: id,
      reason: code,
      requestId: `customer-email:${id}`,
    });
  });
}

export async function retryCustomerEmail(
  documentId: string,
  actor: { id: number; canApprove: boolean; requestId: string },
  confirmedUncertain = false,
) {
  if (!actor.canApprove) throw new AppError("EMAIL_DELIVERY_FORBIDDEN", 403);
  if (!isDatabaseId(documentId)) throw new AppError("EMAIL_DELIVERY_FAILED", 422);
  return withTransaction(async (client) => {
    if (await customerEmailIsDisabled(client)) {
      throw new AppError("EMAIL_DELIVERY_DISABLED", 409);
    }
    const pending = await client.query(
      `SELECT 1
       FROM email_deliveries
       LEFT JOIN jobs
         ON jobs.type = 'send_customer_email'
        AND jobs.payload_json ->> 'deliveryId' = email_deliveries.id::text
        AND jobs.status IN ('PENDING', 'RUNNING')
       WHERE email_deliveries.document_id = $1
         AND (email_deliveries.status = 'PENDING' OR jobs.id IS NOT NULL)
       LIMIT 1`,
      [documentId],
    );
    if (pending.rows[0]) throw new AppError("CONFLICT_REVISION", 409);
    const latest = await client.query<{ last_error_code: string | null }>(
      `SELECT last_error_code FROM email_deliveries
       WHERE document_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [documentId],
    );
    if (latest.rows[0]?.last_error_code === "EMAIL_DELIVERY_UNCERTAIN" && !confirmedUncertain) {
      throw new AppError("EMAIL_DELIVERY_UNCERTAIN", 409);
    }
    const id = await insertDelivery(client, documentId, true);
    if (!id) throw new AppError("EMAIL_ATTACHMENT_MISSING", 409);
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "CUSTOMER_EMAIL_REQUEUED",
      eventClass: "CRITICAL",
      entityType: "EMAIL_DELIVERY",
      entityId: id,
      requestId: actor.requestId,
    });
    return id;
  });
}

export async function listEmailDeliveries(documentIds: string[]) {
  if (!documentIds.length) return [];
  const result = await getPool().query<{
    id: string;
    document_id: string;
    status: string;
    transport: string;
    attempt_count: number;
    sent_at: Date | null;
    last_error_code: string | null;
  }>(
    `SELECT id, document_id, status, transport, attempt_count, sent_at, last_error_code
     FROM email_deliveries
     WHERE document_id = ANY($1::bigint[])
     ORDER BY created_at DESC, id DESC`,
    [documentIds],
  );
  return result.rows.map((row) => ({
    ...row,
    sent_at: row.sent_at?.toISOString() ?? null,
  }));
}
