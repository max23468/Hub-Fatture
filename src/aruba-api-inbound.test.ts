import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { mapArubaApiInboundGroup } from "./aruba-api-inbound.ts";

const xml = Buffer.from('<?xml version="1.0"?><FatturaElettronica />');
const pdf = Buffer.from("%PDF-1.4 synthetic");
const notification = Buffer.from('<?xml version="1.0"?><RicevutaConsegna />');

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
  assert.equal(
    hashes.get("SDI_NOTIFICATION"),
    createHash("sha256").update(notification).digest("hex"),
  );
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
