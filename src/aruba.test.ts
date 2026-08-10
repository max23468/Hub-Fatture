import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertAllowedArubaDownload,
  assertAllowedArubaNavigation,
  assertAllowedArubaTarget,
  assertAllowedHubUrl,
  effectiveArubaMode,
  manifestSha256,
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
  assert.equal(effectiveArubaMode("AUTOMATIC", "PRODUCTION", false), "ASSISTED");
  assert.equal(effectiveArubaMode("AUTOMATIC", "PRODUCTION", true), "AUTOMATIC");
  assert.equal(effectiveArubaMode("AUTOMATIC", "MOCK", false), "AUTOMATIC");

  const delivered = Buffer.from(
    '<?xml version="1.0"?><RicevutaConsegna><Id>1</Id></RicevutaConsegna>',
  );
  assert.equal(notificationStatus(validateUntrustedXml(delivered)), "DELIVERED");
  validateOfficialFile("SDI_NOTIFICATION", delivered);
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
