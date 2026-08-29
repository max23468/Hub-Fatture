import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  arubaMonthlyTransmissionUsage,
  effectiveArubaMode,
  manifestSha256,
  notificationBelongsToDocument,
  notificationStatus,
  validateOfficialFile,
  validateUntrustedXml,
} from "./aruba.ts";

test("manifest API e parser dei file Aruba restano fail-closed", async () => {
  const batch = {
    batchId: "00000000-0000-4000-8000-000000000001",
    environment: "MOCK" as const,
    mode: "DOCUMENT_ONLY" as const,
    accountReference: "synthetic-aruba-account",
    attemptNumber: 1,
    documents: [
      {
        id: "1",
        revision: 1,
        sha256: "a".repeat(64),
        filename: "FPR-0001-26.xml",
        sizeBytes: 100,
        fiscalNumber: "FPR 0001/26",
        documentDate: "2026-08-10",
        totalAmount: 1000,
      },
    ],
  };
  assert.equal(manifestSha256(batch), manifestSha256(structuredClone(batch)));
  assert.notEqual(manifestSha256(batch), manifestSha256({ ...batch, attemptNumber: 2 }));
  assert.equal(
    effectiveArubaMode("AUTOMATIC_AFTER_APPROVAL", "PRODUCTION", false),
    "DOCUMENT_ONLY",
  );
  assert.equal(
    effectiveArubaMode("AUTOMATIC_AFTER_APPROVAL", "PRODUCTION", true),
    "AUTOMATIC_AFTER_APPROVAL",
  );
  assert.equal(effectiveArubaMode("AUTOMATIC_AFTER_APPROVAL", "MOCK", false), "DOCUMENT_ONLY");
  assert.equal(arubaMonthlyTransmissionUsage(399).warning, null);
  assert.deepEqual(arubaMonthlyTransmissionUsage(400), {
    accepted: 400,
    limit: 500,
    remaining: 100,
    warning: "WARNING",
  });
  assert.equal(arubaMonthlyTransmissionUsage(474).warning, "WARNING");
  assert.deepEqual(arubaMonthlyTransmissionUsage(475), {
    accepted: 475,
    limit: 500,
    remaining: 25,
    warning: "CRITICAL",
  });
  assert.equal(arubaMonthlyTransmissionUsage(501).remaining, 0);
  const delivered = Buffer.from(
    '<?xml version="1.0"?><RicevutaConsegna><Id>1</Id></RicevutaConsegna>',
  );
  assert.equal(notificationStatus(validateUntrustedXml(delivered)), "DELIVERED");
  validateOfficialFile("SDI_NOTIFICATION", delivered);
  const identifiedNotification =
    "<RicevutaConsegna><NomeFile>FPR-0001-26.xml.p7m</NomeFile><IdentificativoSdI>REMOTE-1</IdentificativoSdI></RicevutaConsegna>";
  assert.equal(
    notificationBelongsToDocument(identifiedNotification, {
      filename: "FPR-0001-26.xml",
      remoteId: "REMOTE-1",
    }),
    true,
  );
  assert.equal(
    notificationBelongsToDocument(identifiedNotification, {
      filename: "FPR-0002-26.xml",
      remoteId: "REMOTE-2",
    }),
    false,
  );
  assert.throws(() =>
    validateUntrustedXml(
      Buffer.from("<!DOCTYPE x [<!ENTITY e SYSTEM 'file:///etc/passwd'>]><x>&e;</x>"),
    ),
  );
  assert.throws(() => validateOfficialFile("ARUBA_PDF", Buffer.from("non-pdf")));
  validateOfficialFile(
    "ARUBA_PDF",
    Buffer.from(
      await readFile("tests/fixtures/aruba/official-pdf.synthetic.base64", "utf8"),
      "base64",
    ),
  );
  const signedDataDer = Buffer.from(
    await readFile("tests/fixtures/aruba/official-p7m.synthetic.der.base64", "utf8"),
    "base64",
  );
  validateOfficialFile("ARUBA_P7M", signedDataDer);
  const rootLengthBytes = signedDataDer[1]! & 0x80 ? signedDataDer[1]! & 0x7f : 0;
  const signedDataBer = Buffer.concat([
    Buffer.from([0x30, 0x80]),
    signedDataDer.subarray(2 + rootLengthBytes),
    Buffer.from([0x00, 0x00]),
  ]);
  validateOfficialFile("ARUBA_P7M", signedDataBer);
  assert.throws(() => validateOfficialFile("ARUBA_P7M", Buffer.from([0x30, 0x00])));
});
