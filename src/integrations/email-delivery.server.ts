import nodemailer from "nodemailer";

import type { Config } from "../config.server.ts";
import { AppError } from "../errors.ts";

export interface CanonicalEmailMessage {
  sender: string;
  recipient: string;
  subject: string;
  body: string;
  messageId: string;
  attachment: Buffer;
  attachmentFilename: string;
}

type EmailTransportConfig = Pick<
  Config,
  "SMTP_HOST" | "SMTP_PASSWORD" | "SMTP_PORT" | "SMTP_SECURE" | "SMTP_TRANSPORT" | "SMTP_USERNAME"
>;

export interface CanonicalEmailReceipt {
  messageId: string;
  accepted: number;
  rejected: number;
}

export async function sendCanonicalEmail(
  config: EmailTransportConfig,
  message: CanonicalEmailMessage,
  password = config.SMTP_PASSWORD,
): Promise<CanonicalEmailReceipt> {
  if (
    config.SMTP_TRANSPORT !== "SYNTHETIC" &&
    (!config.SMTP_HOST || !config.SMTP_USERNAME || !password)
  ) {
    throw new AppError("EMAIL_CONFIGURATION_MISSING", 503);
  }
  const transporter =
    config.SMTP_TRANSPORT === "SYNTHETIC"
      ? nodemailer.createTransport({ jsonTransport: true })
      : nodemailer.createTransport({
          host: config.SMTP_HOST,
          port: config.SMTP_PORT,
          secure: config.SMTP_SECURE,
          requireTLS: true,
          auth: { user: config.SMTP_USERNAME, pass: password },
          connectionTimeout: 15_000,
          greetingTimeout: 15_000,
          socketTimeout: 30_000,
        });
  const info = await transporter.sendMail({
    from: message.sender,
    envelope: { from: message.sender, to: message.recipient },
    to: message.recipient,
    subject: message.subject,
    text: message.body,
    messageId: message.messageId,
    attachments: [
      {
        filename: message.attachmentFilename,
        content: message.attachment,
        contentType: "application/pdf",
      },
    ],
  });
  return {
    messageId: info.messageId,
    accepted: Array.isArray(info.accepted) ? info.accepted.length : 0,
    rejected: Array.isArray(info.rejected) ? info.rejected.length : 0,
  };
}

export function smtpFailureKind(error: unknown): "TEMPORARY" | "PERMANENT" | "UNCERTAIN" {
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
