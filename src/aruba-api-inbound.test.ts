import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  arubaApiParityFileHash,
  hasRequiredArubaApiFiles,
  mapArubaApiInboundGroup,
} from "./aruba-api-inbound.ts";
import { arubaFiscalPayloadSha256 } from "./aruba.ts";

const xml = Buffer.from('<?xml version="1.0"?><FatturaElettronica />');
const pdf = Buffer.from("%PDF-1.4 synthetic");
const notification = Buffer.from('<?xml version="1.0"?><RicevutaConsegna />');

function der(tag: number, content: Buffer) {
  const length =
    content.byteLength < 128
      ? Buffer.from([content.byteLength])
      : Buffer.from([0x82, content.byteLength >> 8, content.byteLength & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, content]);
}

function signedXml(xmlBytes: Buffer) {
  const signedDataOid = Buffer.from([
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02,
  ]);
  const dataOid = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01]);
  const encapsulated = der(0x30, Buffer.concat([dataOid, der(0xa0, der(0x04, xmlBytes))]));
  const signedData = der(
    0x30,
    Buffer.concat([
      der(0x02, Buffer.from([1])),
      der(0x31, Buffer.alloc(0)),
      encapsulated,
      der(0x31, Buffer.alloc(0)),
    ]),
  );
  return der(0x30, Buffer.concat([signedDataOid, der(0xa0, signedData)]));
}

function input() {
  return {
    group: {
      id: "gruppo-sintetico",
      filename: "IT00000000000_SYNTH.xml",
      invoices: [
        {
          invoiceDate: "2026-08-26T10:00:00.000Z",
          number: "FPR-101",
          documentType: "TD01",
          status: "Consegnata",
        },
        {
          invoiceDate: "2026-08-26T10:01:00.000Z",
          number: "FPR-102",
          documentType: "TD04",
          status: "Scartata",
        },
      ],
    },
    detail: {
      id: "gruppo-sintetico",
      filename: "IT00000000000_SYNTH.xml",
      file: xml.toString("base64"),
      pdfFile: pdf.toString("base64"),
      lastUpdate: "2026-08-26T10:02:00.000Z",
      receiver: {
        description: "Destinatario sintetico",
        countryCode: "IT",
        vatCode: "00000000000",
        fiscalCode: null,
      },
      invoices: [
        {
          invoiceDate: "2026-08-26T10:00:00.000Z",
          number: "FPR-101",
          documentType: "TD01",
          status: "Consegnata",
          totalDocument: "100,25",
        },
        {
          invoiceDate: "2026-08-26T10:01:00.000Z",
          number: "FPR-102",
          documentType: "TD04",
          status: "Scartata",
          totalDocument: 10,
        },
      ],
    },
    notifications: [
      {
        filename: "IT00000000000_SYNTH_RC.xml",
        invoiceId: "gruppo-sintetico",
        docType: "RC",
        notificationDate: "2026-08-26T10:03:00.000Z",
        number: "FPR-101",
        result: null,
        file: notification.toString("base64"),
      },
    ],
  };
}

test("il mapper API separa i documenti del gruppo senza attribuire file condivisi", () => {
  const mapped = mapArubaApiInboundGroup(input());
  assert.equal(mapped.length, 2);
  assert.notEqual(mapped[0]!.remoteKey, mapped[1]!.remoteKey);
  assert.deepEqual(
    mapped.map((document) => ({
      group: document.providerGroupId,
      type: document.remote.documentType,
      series: document.remote.series,
      number: document.remote.fiscalNumber,
      total: document.remote.totalAmount,
      status: document.remote.status,
    })),
    [
      {
        group: "gruppo-sintetico",
        type: "TD01",
        series: null,
        number: null,
        total: 10_025,
        status: "DELIVERED",
      },
      {
        group: "gruppo-sintetico",
        type: "TD04",
        series: null,
        number: null,
        total: 1_000,
        status: "REJECTED",
      },
    ],
  );
  const hashes = new Map(mapped[0]!.files.map((file) => [file.kind, file.sha256]));
  assert.equal(hashes.has("ARUBA_XML"), false);
  assert.equal(hashes.has("ARUBA_PDF"), false);
  const groupHashes = new Map(mapped[0]!.groupFiles.map((file) => [file.kind, file.sha256]));
  assert.equal(groupHashes.get("ARUBA_XML"), createHash("sha256").update(xml).digest("hex"));
  assert.equal(groupHashes.get("ARUBA_PDF"), createHash("sha256").update(pdf).digest("hex"));
  assert.equal(hasRequiredArubaApiFiles(mapped[0]!), true);
  assert.deepEqual(mapped[1]!.groupFiles, mapped[0]!.groupFiles);
  assert.equal(
    hashes.get("SDI_NOTIFICATION"),
    createHash("sha256").update(notification).digest("hex"),
  );
  assert.equal(mapped[0]!.remote.providerInvoiceNumber, "FPR-101");
  assert.equal(
    mapped[0]!.files.find((file) => file.kind === "SDI_NOTIFICATION")?.notificationInvoiceNumber,
    "FPR-101",
  );
  assert.equal(mapped[1]!.remote.providerInvoiceNumber, "FPR-102");
  assert.equal(
    mapped[1]!.files.some((file) => file.kind === "SDI_NOTIFICATION"),
    false,
  );
});

test("il mapper attribuisce i file ufficiali soltanto a un gruppo con una fattura", () => {
  const single = input();
  single.group.invoices = single.group.invoices.slice(0, 1);
  single.detail.invoices = single.detail.invoices.slice(0, 1);
  const mapped = mapArubaApiInboundGroup(single);
  const hashes = new Map(mapped[0]!.files.map((file) => [file.kind, file.sha256]));
  assert.equal(hashes.get("ARUBA_XML"), createHash("sha256").update(xml).digest("hex"));
  assert.equal(hashes.get("ARUBA_PDF"), createHash("sha256").update(pdf).digest("hex"));
  assert.deepEqual(mapped[0]!.groupFiles, []);
});

test("XML e P7M usano la stessa impronta fiscale per documenti e gruppi", () => {
  const p7m = signedXml(xml);
  const expected = arubaFiscalPayloadSha256("ARUBA_XML", xml);
  assert.notEqual(createHash("sha256").update(p7m).digest("hex"), expected);
  assert.equal(arubaFiscalPayloadSha256("ARUBA_P7M", p7m), expected);

  const groupedInput = input();
  groupedInput.group.filename = "IT00000000000_SYNTH.xml.p7m";
  groupedInput.detail.filename = "IT00000000000_SYNTH.xml.p7m";
  groupedInput.detail.file = p7m.toString("base64");
  const grouped = mapArubaApiInboundGroup(groupedInput);
  assert.equal(arubaApiParityFileHash(grouped[0]!.groupFiles[0]!), expected);

  groupedInput.group.invoices = groupedInput.group.invoices.slice(0, 1);
  groupedInput.detail.invoices = groupedInput.detail.invoices.slice(0, 1);
  const direct = mapArubaApiInboundGroup(groupedInput);
  assert.equal(arubaApiParityFileHash(direct[0]!.files[0]!), expected);
  assert.equal(direct[0]!.remote.xmlSha256, expected);
});

test("il PDF opzionale non blocca un documento con il payload fiscale ufficiale", () => {
  const single = input();
  single.group.invoices = single.group.invoices.slice(0, 1);
  single.detail.invoices = single.detail.invoices.slice(0, 1);
  const [document] = mapArubaApiInboundGroup({
    ...single,
    detail: { ...single.detail, pdfFile: null },
  });
  assert(document);
  assert.equal(
    document.files.some((candidate) => candidate.kind === "ARUBA_PDF"),
    false,
  );
  assert.equal(hasRequiredArubaApiFiles(document), true);
});

test("il mapper conserva come sconosciuto il Paese destinatario assente nei dettagli storici", () => {
  const historical = input();
  const mapped = mapArubaApiInboundGroup({
    ...historical,
    detail: {
      ...historical.detail,
      receiver: { ...historical.detail.receiver, countryCode: null },
    },
  });
  assert.equal(mapped[0]?.remote.recipientCountryCode, null);
  assert.deepEqual(
    mapped[0]?.remote.recipientTaxIdentifiers.map((identifier) => identifier.countryCode),
    [null],
  );
});

test("il mapper normalizza al valore monetario interno un totale Aruba con segno", () => {
  const signed = input();
  signed.group.invoices = signed.group.invoices.slice(0, 1);
  signed.detail.invoices = [{ ...signed.detail.invoices[0]!, totalDocument: "-145,00" }];
  const [document] = mapArubaApiInboundGroup(signed);
  assert.equal(document?.remote.totalAmount, 14_500);
});

test("il mapper API rifiuta gruppi, dettagli e notifiche non correlati", () => {
  const mismatched = input();
  assert.throws(
    () =>
      mapArubaApiInboundGroup({
        ...mismatched,
        notifications: [
          {
            ...mismatched.notifications[0],
            invoiceId: "altro-gruppo",
          },
        ],
      }),
    /ARUBA_API_GROUP_MISMATCH/,
  );
});

test("il mapper associa ogni notifica a una sola fattura del gruppo", () => {
  const ambiguous = input();
  assert.throws(
    () =>
      mapArubaApiInboundGroup({
        ...ambiguous,
        notifications: [{ ...ambiguous.notifications[0]!, number: null }],
      }),
    /ARUBA_API_GROUP_MISMATCH/,
  );
  assert.throws(
    () =>
      mapArubaApiInboundGroup({
        ...ambiguous,
        notifications: [{ ...ambiguous.notifications[0]!, number: "FPR-INESISTENTE" }],
      }),
    /ARUBA_API_GROUP_MISMATCH/,
  );
});
