import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "./errors.ts";
import { sendCanonicalEmail, smtpFailureKind } from "./integrations/email-delivery.server.ts";

const message = {
  sender: "contabilita@example.invalid",
  recipient: "destinatario@example.invalid",
  subject: "Documento sintetico",
  body: "Contenuto sintetico",
  messageId: "<synthetic-email@example.invalid>",
  attachment: Buffer.from("%PDF-1.4\n%%EOF\n"),
  attachmentFilename: "documento-sintetico.pdf",
};

test("l'adapter e-mail canonico resta unico e fail-closed", async () => {
  const receipt = await sendCanonicalEmail(
    {
      SMTP_TRANSPORT: "SYNTHETIC",
      SMTP_HOST: undefined,
      SMTP_PORT: 587,
      SMTP_SECURE: false,
      SMTP_USERNAME: undefined,
      SMTP_PASSWORD: undefined,
    },
    message,
  );
  assert.equal(receipt.messageId, message.messageId);
  assert.equal(receipt.rejected, 0);

  await assert.rejects(
    sendCanonicalEmail(
      {
        SMTP_TRANSPORT: "OCI_EMAIL_DELIVERY",
        SMTP_HOST: "smtp.email.eu-milan-1.oci.oraclecloud.com",
        SMTP_PORT: 587,
        SMTP_SECURE: false,
        SMTP_USERNAME: undefined,
        SMTP_PASSWORD: undefined,
      },
      message,
    ),
    (error) => error instanceof AppError && error.code === "EMAIL_CONFIGURATION_MISSING",
  );

  assert.equal(smtpFailureKind({ responseCode: 451, command: "DATA" }), "TEMPORARY");
  assert.equal(smtpFailureKind({ responseCode: 535, command: "AUTH" }), "PERMANENT");
  assert.equal(smtpFailureKind(new Error("errore non classificabile")), "UNCERTAIN");
});
