import { createHash, randomUUID } from "node:crypto";

import { getConfig } from "../config.server.ts";
import {
  sendCanonicalEmail,
  smtpFailureKind,
  type CanonicalEmailMessage,
} from "../integrations/email-delivery.server.ts";

const syntheticPdf = Buffer.from(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj
trailer<</Root 1 0 R>>
startxref
0
%%EOF
`);

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

async function qualify() {
  const config = getConfig();
  const expectedConfirmation = `QUALIFY_EMAIL:${config.APP_COMMIT_SHA}`;
  if (
    config.APP_ENV !== "production" ||
    !/^[0-9a-f]{40}$/.test(config.APP_COMMIT_SHA) ||
    !/^sha256:[0-9a-f]{64}$/.test(config.APP_IMAGE_DIGEST) ||
    config.SMTP_TRANSPORT !== "OCI_EMAIL_DELIVERY" ||
    process.env.EMAIL_QUALIFICATION_CONFIRM !== expectedConfirmation
  ) {
    throw new Error("EMAIL_QUALIFICATION_NOT_AUTHORIZED");
  }

  const domain = config.SMTP_FROM.split("@")[1];
  if (!domain) throw new Error("EMAIL_QUALIFICATION_CONFIGURATION_INVALID");
  const messageKey = randomUUID();
  const message: CanonicalEmailMessage = {
    sender: config.SMTP_FROM,
    recipient: config.SMTP_FROM,
    subject: "Verifica tecnica Hub Fatture - nessun documento fiscale",
    body: "Messaggio sintetico per qualificare OCI Email Delivery. Non contiene dati cliente e non è un documento fiscale.",
    messageId: `<qualification-${messageKey}@${domain}>`,
    attachment: syntheticPdf,
    attachmentFilename: "verifica-tecnica-non-fiscale.pdf",
  };

  const invalidPassword = sha256(`${config.SMTP_PASSWORD}:qualification-invalid`);
  let failureKind: ReturnType<typeof smtpFailureKind> | null = null;
  try {
    await sendCanonicalEmail(config, message, invalidPassword);
  } catch (error) {
    failureKind = smtpFailureKind(error);
  }
  if (failureKind !== "PERMANENT") {
    throw new Error("EMAIL_QUALIFICATION_FAILURE_NOT_OBSERVED");
  }

  const retry = await sendCanonicalEmail(config, message);
  if (retry.accepted !== 1 || retry.rejected !== 0) {
    throw new Error("EMAIL_QUALIFICATION_RETRY_NOT_ACCEPTED");
  }

  return {
    status: "ok",
    commit: config.APP_COMMIT_SHA,
    imageDigest: config.APP_IMAGE_DIGEST,
    applicationVersion: config.APP_VERSION,
    transport: config.SMTP_TRANSPORT,
    failedAttempt: { kind: failureKind },
    retry: {
      accepted: retry.accepted,
      rejected: retry.rejected,
      messageIdSha256: sha256(retry.messageId),
    },
    attachmentSha256: sha256(syntheticPdf),
  };
}

try {
  process.stdout.write(`${JSON.stringify(await qualify())}\n`);
} catch (error) {
  const code =
    error instanceof Error && /^EMAIL_QUALIFICATION_[A-Z_]+$/.test(error.message)
      ? error.message
      : "EMAIL_QUALIFICATION_FAILED";
  process.stderr.write(`${JSON.stringify({ status: "failed", code })}\n`);
  process.exitCode = 1;
}
