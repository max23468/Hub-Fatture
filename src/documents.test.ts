import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import profileFixture from "../tests/fixtures/fatturapa/profile.mock.json" with { type: "json" };

import {
  documentInputSchema,
  generateFatturaXml,
  projectFatturaXml,
  type DocumentInput,
  fiscalProfileSchema,
  fiscalProfileFromAcceptedInvoiceXml,
} from "./documents.ts";
import { validateFatturaXml } from "./fatturapa.server.ts";

const syntheticFiscalProfile = fiscalProfileSchema.parse(profileFixture);

const invoice: DocumentInput = {
  kind: "INVOICE",
  documentDate: "2026-08-10",
  recipient: {
    kind: "PRIVATE_IT",
    firstName: "Mario",
    lastName: "Rossi",
    taxIdentifiers: [{ type: "CODICE_FISCALE", value: "RSSMRA80A01H501U", countryCode: "IT" }],
    address: {
      line1: "Via Cliente 2",
      postalCode: "00100",
      city: "Roma",
      province: "RM",
      countryCode: "IT",
    },
  },
  lines: [
    {
      orderId: "1",
      description: "Vendita beni usati - Ordine Shopify #1001",
      quantity: 1,
      unitAmount: 12345,
    },
  ],
};

test("TD01 e TD04 restano conformi al profilo Aruba anonimizzato", async () => {
  const invoiceXml = generateFatturaXml(syntheticFiscalProfile, invoice, {
    year: 2026,
    number: 1,
  });
  assert.equal(
    invoiceXml,
    await readFile("tests/fixtures/fatturapa/accepted-invoice.anonymized.xml", "utf8"),
  );
  assert.deepEqual(
    fiscalProfileFromAcceptedInvoiceXml(invoiceXml, syntheticFiscalProfile.numbering.approvedAt),
    syntheticFiscalProfile,
  );
  await validateFatturaXml(invoiceXml);
  assert.match(invoiceXml, /<RegimeFiscale>RF14<\/RegimeFiscale>/);
  assert.match(invoiceXml, /<Natura>N5<\/Natura>/);
  assert.match(invoiceXml, /<ModalitaPagamento>MP08<\/ModalitaPagamento>/);

  const creditXml = generateFatturaXml(
    syntheticFiscalProfile,
    {
      ...invoice,
      kind: "CREDIT_NOTE",
      documentDate: "2026-08-11",
      recipient: {
        ...invoice.recipient,
        kind: "BUSINESS_IT",
        firstName: undefined,
        lastName: undefined,
        businessName: "Cliente Esempio Srl",
        certifiedEmail: "cliente@example.invalid",
        recipientCode: "0000000",
        taxIdentifiers: [
          { type: "PARTITA_IVA", value: "10987654321", countryCode: "IT" },
          { type: "CODICE_FISCALE", value: "10987654321", countryCode: "IT" },
        ],
      },
      lines: [
        {
          orderId: "1",
          description: "Rimborso beni usati - Ordine Shopify #1001",
          quantity: 1,
          unitAmount: 2345,
        },
      ],
    },
    { year: 2026, number: 2 },
  );
  assert.equal(
    creditXml,
    await readFile("tests/fixtures/fatturapa/accepted-credit-note.anonymized.xml", "utf8"),
  );
  const profileFromLatestDocument = fiscalProfileFromAcceptedInvoiceXml(
    invoiceXml,
    syntheticFiscalProfile.numbering.approvedAt,
    creditXml,
  );
  assert.equal(profileFromLatestDocument.numbering.lastObservedNumber, 2);
  assert.equal(
    profileFromLatestDocument.numbering.sourceXmlSha256,
    "ddbd3c679143ccf3c4cd9d1998ead9d38142bea6771b55ff99b78c938e7114d2",
  );
  await validateFatturaXml(creditXml);
  assert.match(creditXml, /<TipoDocumento>TD04<\/TipoDocumento>/);
  assert.match(creditXml, /<ModalitaPagamento>MP05<\/ModalitaPagamento>/);
  assert.match(creditXml, /<PECDestinatario>cliente@example\.invalid<\/PECDestinatario>/);
  assert.notEqual(projectFatturaXml(syntheticFiscalProfile, invoice).sha256, "");
});

test("la validazione rifiuta DTD e numbering incoerente", async () => {
  await assert.rejects(validateFatturaXml("<!DOCTYPE x><x/>"), /DTD/);
  assert.throws(
    () => generateFatturaXml(syntheticFiscalProfile, invoice, { year: 2025, number: 1 }),
    /Numerazione non coerente/,
  );
});

test("la proiezione serializza nomi ammessi e qualifica il CAP estero", async () => {
  const personalBusiness = documentInputSchema.parse({
    ...invoice,
    recipient: {
      ...invoice.recipient,
      kind: "BUSINESS_IT",
      taxIdentifiers: [{ type: "PARTITA_IVA", value: "10987654321", countryCode: "IT" }],
    },
  });
  const personalBusinessXml = generateFatturaXml(syntheticFiscalProfile, personalBusiness, {
    year: 2026,
    number: 3,
  });
  await validateFatturaXml(personalBusinessXml);
  assert.match(personalBusinessXml, /<Nome>Mario<\/Nome>/);
  assert.match(personalBusinessXml, /<Cognome>Rossi<\/Cognome>/);

  const foreign = documentInputSchema.parse({
    ...invoice,
    recipient: {
      kind: "EU",
      displayName: "Voorbeeld Handel",
      taxIdentifiers: [],
      address: {
        line1: "Keizersgracht 1",
        postalCode: "1012 AB",
        city: "Amsterdam",
        province: "Noord-Holland",
        countryCode: "NL",
      },
    },
  });
  const foreignXml = generateFatturaXml(syntheticFiscalProfile, foreign, {
    year: 2026,
    number: 4,
  });
  await validateFatturaXml(foreignXml);
  assert.match(foreignXml, /<Denominazione>Voorbeeld Handel<\/Denominazione>/);
  assert.match(foreignXml, /<IdPaese>NL<\/IdPaese>\s*<IdCodice>99999999999<\/IdCodice>/);
  assert.match(foreignXml, /<CAP>00000<\/CAP>/);
  assert.doesNotMatch(foreignXml, /1012 AB|Noord-Holland|undefined/);
});
