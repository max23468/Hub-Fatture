import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ARUBA_UPLOAD_MAX_BATCH_BYTES,
  arubaManifestSchema,
  assertAllowedArubaAuthenticationNavigation,
  assertAllowedArubaDownload,
  assertAllowedArubaNavigation,
  assertAllowedArubaTarget,
  assertAllowedHubUrl,
  effectiveArubaMode,
  manifestSha256,
  notificationBelongsToDocument,
  notificationStatus,
  validateOfficialFile,
  validateUntrustedXml,
} from "./aruba.ts";

test("allowlist, manifest e parser Aruba restano fail-closed", async () => {
  assert.equal(
    assertAllowedArubaTarget("https://fatturazioneelettronica.aruba.it/", "PRODUCTION").origin,
    "https://fatturazioneelettronica.aruba.it",
  );
  assert.throws(() =>
    assertAllowedArubaTarget(
      "https://fatturazioneelettronica.aruba.it.attacker.invalid/",
      "PRODUCTION",
    ),
  );
  assert.throws(() =>
    assertAllowedArubaTarget("https://fatturazioneelettronica.aruba.it/?token=x", "PRODUCTION"),
  );
  assert.equal(
    assertAllowedArubaTarget("http://127.0.0.1:4173/aruba-sintetica?scenario=inventory", "MOCK")
      .search,
    "?scenario=inventory",
  );
  assert.throws(() =>
    assertAllowedArubaTarget("http://127.0.0.1:4173/aruba-sintetica?token=x", "MOCK"),
  );
  const aruba = new URL("https://fatturazioneelettronica.aruba.it/");
  assert.equal(
    assertAllowedArubaNavigation(
      "https://fatturazioneelettronica.aruba.it/documenti?stato=inviata",
      aruba,
    ).pathname,
    "/documenti",
  );
  assert.throws(() =>
    assertAllowedArubaNavigation("https://download.attacker.invalid/fattura.xml", aruba),
  );
  assert.equal(
    assertAllowedArubaAuthenticationNavigation(
      "https://loginfatturazione.aruba.it/?returnUrl=%2F%23dashboard",
      aruba,
    ).origin,
    "https://loginfatturazione.aruba.it",
  );
  assert.throws(() =>
    assertAllowedArubaAuthenticationNavigation(
      "https://loginfatturazione.aruba.it.attacker.invalid/",
      aruba,
    ),
  );
  assert.throws(() =>
    assertAllowedArubaAuthenticationNavigation(
      "https://loginfatturazione.aruba.it/",
      new URL("http://127.0.0.1:4173/aruba-sintetica"),
    ),
  );
  assert.equal(
    assertAllowedArubaDownload("data:application/xml,%3Cxml%2F%3E", aruba).protocol,
    "data:",
  );
  assert.throws(() =>
    assertAllowedArubaDownload("https://download.attacker.invalid/fattura.xml", aruba),
  );
  assert.equal(assertAllowedHubUrl("http://127.0.0.1:8080").hostname, "127.0.0.1");
  assert.throws(() => assertAllowedHubUrl("http://hub.example"));

  const batch = {
    batchId: "00000000-0000-4000-8000-000000000001",
    environment: "MOCK" as const,
    mode: "ASSISTED" as const,
    accountReference: "synthetic-aruba-account",
    accountIdentity: "synthetic-aruba-account",
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
  assert.notEqual(
    manifestSha256(batch),
    manifestSha256({ ...batch, accountIdentity: "different-synthetic-account" }),
  );
  assert.equal(effectiveArubaMode("AUTOMATIC", "PRODUCTION", false), "ASSISTED");
  assert.equal(effectiveArubaMode("AUTOMATIC", "PRODUCTION", true), "AUTOMATIC");
  assert.equal(effectiveArubaMode("AUTOMATIC", "MOCK", false), "AUTOMATIC");
  const oversizedBatch = {
    ...batch,
    operation: "UPLOAD" as const,
    manifestSha256: "b".repeat(64),
    panelUrl: "http://127.0.0.1/aruba-sintetica",
    documents: Array.from({ length: 7 }, (_, index) => ({
      ...batch.documents[0]!,
      id: String(index + 1),
      filename: `FPR-${index + 1}.xml`,
      sizeBytes: Math.floor(ARUBA_UPLOAD_MAX_BATCH_BYTES / 7) + 1,
    })),
  };
  assert.equal(arubaManifestSchema.safeParse(oversizedBatch).success, false);
  assert.equal(
    arubaManifestSchema.safeParse({
      ...oversizedBatch,
      documents: oversizedBatch.documents.map((document) => ({
        ...document,
        sizeBytes: Math.floor(ARUBA_UPLOAD_MAX_BATCH_BYTES / 7),
      })),
    }).success,
    true,
  );

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
  validateOfficialFile(
    "ARUBA_P7M",
    Buffer.from(
      await readFile("tests/fixtures/aruba/official-p7m.synthetic.der.base64", "utf8"),
      "base64",
    ),
  );
  assert.throws(() => validateOfficialFile("ARUBA_P7M", Buffer.from([0x30, 0x00])));
});
