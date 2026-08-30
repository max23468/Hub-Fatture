import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import profileFixture from "../tests/fixtures/fatturapa/profile.mock.json" with { type: "json" };

import {
  acceptedCreditNoteFromXml,
  acceptedDocumentFiscalIdentity,
  documentInputSchema,
  acceptedInvoiceFromXml,
  acceptedRecipientFromXml,
  fiscalDocumentEnvelopeFromXml,
  fiscalDocumentEnvelopesFromXml,
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
  paymentStatus: "PAID",
  paymentMethod: "MP08",
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
  const withoutTotal = invoiceXml.replace(
    /\s*<ImportoTotaleDocumento>123\.45<\/ImportoTotaleDocumento>/,
    "",
  );
  await validateFatturaXml(withoutTotal);
  assert.equal(
    acceptedInvoiceFromXml(withoutTotal, syntheticFiscalProfile.numbering.approvedAt).totalAmount,
    12345,
  );
  assert.equal(acceptedDocumentFiscalIdentity(withoutTotal).totalAmount, 12345);
  const summaryBlock = invoiceXml.match(/\s*<DatiRiepilogo>[\s\S]*?<\/DatiRiepilogo>/)?.[0];
  assert.ok(summaryBlock);
  const repeatedSummary = invoiceXml.replace(summaryBlock, `${summaryBlock}${summaryBlock}`);
  await validateFatturaXml(repeatedSummary);
  assert.equal(acceptedDocumentFiscalIdentity(repeatedSummary).taxNature, "N5");
  assert.equal(
    acceptedInvoiceFromXml(repeatedSummary, syntheticFiscalProfile.numbering.approvedAt).profile
      .legalReference,
    syntheticFiscalProfile.legalReference,
  );
  const conflictingSummary = invoiceXml.replace(
    summaryBlock,
    `${summaryBlock}${summaryBlock.replace("<Natura>N5</Natura>", "<Natura>N2.2</Natura>")}`,
  );
  assert.throws(
    () => acceptedDocumentFiscalIdentity(conflictingSummary),
    /riepiloghi fiscali non coincidono/,
  );
  const mixedTaxSummary = invoiceXml.replace(
    summaryBlock,
    `${summaryBlock}${summaryBlock
      .replace("<AliquotaIVA>0.00</AliquotaIVA>", "<AliquotaIVA>22.00</AliquotaIVA>")
      .replace(/\s*<Natura>N5<\/Natura>/, "")
      .replace(/\s*<RiferimentoNormativo>[^<]+<\/RiferimentoNormativo>/, "")}`,
  );
  await validateFatturaXml(mixedTaxSummary);
  assert.deepEqual(fiscalDocumentEnvelopeFromXml(mixedTaxSummary), {
    type: "TD01",
    year: 2026,
    number: 1,
    documentNumber: "FPR 0001/26",
    documentDate: "2026-08-10",
    totalAmount: 12345,
  });
  assert.throws(() => acceptedDocumentFiscalIdentity(mixedTaxSummary), /Campo XML obbligatorio/);
  const withoutPayment = invoiceXml.replace(
    /\s*<DatiPagamento xmlns="">[\s\S]*?<\/DatiPagamento>/,
    "",
  );
  await validateFatturaXml(withoutPayment);
  const acceptedWithoutPayment = acceptedInvoiceFromXml(
    withoutPayment,
    syntheticFiscalProfile.numbering.approvedAt,
  );
  assert.equal(acceptedWithoutPayment.input.paymentMethod, "MP08");
  assert.deepEqual(acceptedWithoutPayment.profile.payment, syntheticFiscalProfile.payment);
  for (const paymentMethod of ["MP01", "MP05"] as const) {
    const historicalPayment = invoiceXml.replace(
      "<ModalitaPagamento>MP08</ModalitaPagamento>",
      `<ModalitaPagamento>${paymentMethod}</ModalitaPagamento>`,
    );
    await validateFatturaXml(historicalPayment);
    const acceptedHistoricalPayment = acceptedInvoiceFromXml(
      historicalPayment,
      syntheticFiscalProfile.numbering.approvedAt,
    );
    assert.equal(acceptedHistoricalPayment.input.paymentMethod, paymentMethod);
    assert.deepEqual(acceptedHistoricalPayment.profile.payment, syntheticFiscalProfile.payment);
  }
  const withoutSupplierContacts = invoiceXml.replace(/\s*<Contatti>[\s\S]*?<\/Contatti>/, "");
  await validateFatturaXml(withoutSupplierContacts);
  const acceptedWithoutSupplierContacts = acceptedInvoiceFromXml(
    withoutSupplierContacts,
    syntheticFiscalProfile.numbering.approvedAt,
  );
  assert.equal(acceptedWithoutSupplierContacts.profile.seller.phone, undefined);
  assert.equal(acceptedWithoutSupplierContacts.profile.seller.email, undefined);
  const foreignCurrency = invoiceXml.replace("<Divisa>EUR</Divisa>", "<Divisa>USD</Divisa>");
  await validateFatturaXml(foreignCurrency);
  assert.throws(
    () => acceptedInvoiceFromXml(foreignCurrency, syntheticFiscalProfile.numbering.approvedAt),
    /non è FPR12, EUR o numerato correttamente/,
  );

  const creditXml = generateFatturaXml(
    syntheticFiscalProfile,
    {
      ...invoice,
      kind: "CREDIT_NOTE",
      paymentMethod: "MP05",
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
  const creditBody = creditXml.match(
    /<FatturaElettronicaBody[\s\S]*<\/FatturaElettronicaBody>/,
  )?.[0];
  assert.ok(creditBody);
  const groupedXml = invoiceXml.replace(
    "</FatturaElettronica>",
    `${creditBody}</FatturaElettronica>`,
  );
  assert.deepEqual(fiscalDocumentEnvelopesFromXml(groupedXml), [
    {
      type: "TD01",
      year: 2026,
      series: "FPR",
      fiscalNumber: "1",
      documentDate: "2026-08-10",
      totalAmount: 12345,
    },
    {
      type: "TD04",
      year: 2026,
      series: "FPR",
      fiscalNumber: "2",
      documentDate: "2026-08-11",
      totalAmount: 2345,
    },
  ]);
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
  assert.throws(
    () =>
      fiscalProfileFromAcceptedInvoiceXml(
        invoiceXml,
        syntheticFiscalProfile.numbering.approvedAt,
        creditXml.replaceAll("01234567890", "01234567891"),
      ),
    /cedente o trasmittente diverso/,
  );
  await validateFatturaXml(creditXml);
  assert.match(creditXml, /<TipoDocumento>TD04<\/TipoDocumento>/);
  assert.match(creditXml, /<ModalitaPagamento>MP05<\/ModalitaPagamento>/);
  assert.match(creditXml, /<PECDestinatario>cliente@example\.invalid<\/PECDestinatario>/);
  const creditWithoutPayment = creditXml.replace(
    /\s*<DatiPagamento xmlns="">[\s\S]*?<\/DatiPagamento>/,
    "",
  );
  const creditWithoutTotalOrPayment = creditWithoutPayment.replace(
    /\s*<ImportoTotaleDocumento>23\.45<\/ImportoTotaleDocumento>/,
    "",
  );
  assert.equal(acceptedCreditNoteFromXml(creditWithoutTotalOrPayment).totalAmount, 2345);
  const acceptedCreditRecipient = acceptedRecipientFromXml(creditWithoutTotalOrPayment);
  assert.equal(acceptedCreditRecipient.businessName, "Cliente Esempio Srl");
  assert.equal(acceptedCreditRecipient.address.line1, "Via Cliente 2");
  assert.deepEqual(acceptedCreditRecipient.taxIdentifiers, [
    { type: "PARTITA_IVA", value: "10987654321", countryCode: "IT" },
    { type: "CODICE_FISCALE", value: "10987654321" },
  ]);
  assert.deepEqual(acceptedDocumentFiscalIdentity(creditWithoutTotalOrPayment).payment, {
    condition: "TP02",
    method: "MP05",
  });
  assert.equal(acceptedDocumentFiscalIdentity(creditWithoutTotalOrPayment).totalAmount, 2345);
  const linkedCreditXml = generateFatturaXml(
    syntheticFiscalProfile,
    {
      ...invoice,
      kind: "CREDIT_NOTE",
      paymentMethod: "MP05",
      relatedInvoice: { number: "FPR 0001/26", date: "2026-08-10" },
    },
    { year: 2026, number: 3 },
  );
  assert.match(linkedCreditXml, /<DatiFattureCollegate>/);
  assert.match(linkedCreditXml, /<IdDocumento>FPR 0001\/26<\/IdDocumento>/);
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
      address: { ...invoice.recipient.address, province: "rm" },
    },
  });
  const personalBusinessXml = generateFatturaXml(syntheticFiscalProfile, personalBusiness, {
    year: 2026,
    number: 3,
  });
  await validateFatturaXml(personalBusinessXml);
  assert.match(personalBusinessXml, /<Nome>Mario<\/Nome>/);
  assert.match(personalBusinessXml, /<Cognome>Rossi<\/Cognome>/);
  assert.match(personalBusinessXml, /<Provincia>RM<\/Provincia>/);

  const foreign = documentInputSchema.parse({
    ...invoice,
    lines: [{ ...invoice.lines[0]!, description: "Πώληση" }],
    recipient: {
      kind: "EU",
      displayName: `Εμπόριο${" A".repeat(50)}`,
      taxIdentifiers: [],
      address: {
        line1: `Οδός 1${" lungo".repeat(20)}`,
        line2: "Interno 2",
        postalCode: "1012 AB",
        city: "Αθήνα",
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
  assert.match(foreignXml, /<Denominazione>\?+ A A/);
  assert.match(foreignXml, /<Indirizzo>\?+ 1 lungo lungo/);
  assert.match(foreignXml, /, Interno 2<\/Indirizzo>/);
  assert.match(foreignXml, /<Comune>\?+<\/Comune>/);
  assert.match(foreignXml, /<Descrizione>\?+<\/Descrizione>/);
  assert.match(foreignXml, /<IdPaese>NL<\/IdPaese>\s*<IdCodice>99999999999<\/IdCodice>/);
  const foreignWithLegacyIdentifier = documentInputSchema.parse({
    ...foreign,
    recipient: {
      ...foreign.recipient,
      taxIdentifiers: [{ type: "ALTRO", value: "NL-LEGACY-123", countryCode: "NL" }],
    },
  });
  assert.match(
    generateFatturaXml(
      syntheticFiscalProfile,
      foreignWithLegacyIdentifier,
      { year: 2026, number: 5 },
      { legacyEuFirstTaxIdentifier: true },
    ),
    /<IdPaese>NL<\/IdPaese>\s*<IdCodice>NL-LEGACY-123<\/IdCodice>/,
  );
  assert.match(
    generateFatturaXml(syntheticFiscalProfile, foreignWithLegacyIdentifier, {
      year: 2026,
      number: 5,
    }),
    /<IdPaese>NL<\/IdPaese>\s*<IdCodice>99999999999<\/IdCodice>/,
  );
  assert.match(foreignXml, /<CAP>00000<\/CAP>/);
  assert.doesNotMatch(foreignXml, /1012 AB|Noord-Holland|undefined/);

  const swiss = documentInputSchema.parse({
    ...foreign,
    recipient: {
      ...foreign.recipient,
      kind: "NON_EU",
      displayName: "Cliente svizzero",
      address: {
        line1: "Via Svizzera 1",
        postalCode: "6900",
        city: "Lugano",
        countryCode: "CH",
      },
    },
  });
  const swissXml = generateFatturaXml(syntheticFiscalProfile, swiss, {
    year: 2026,
    number: 6,
  });
  await validateFatturaXml(swissXml);
  assert.match(swissXml, /<CodiceDestinatario>XXXXXXX<\/CodiceDestinatario>/);
  assert.match(swissXml, /<IdPaese>CH<\/IdPaese>\s*<IdCodice>99999999999<\/IdCodice>/);
  assert.match(swissXml, /<CAP>00000<\/CAP>/);
  assert.doesNotMatch(swissXml, /<CAP>6900<\/CAP>/);
});

test("la bozza controlla gli identificativi e proietta pagamento, causale e note", async () => {
  assert.equal(
    documentInputSchema.safeParse({
      ...invoice,
      recipient: {
        ...invoice.recipient,
        taxIdentifiers: [
          ...invoice.recipient.taxIdentifiers,
          { type: "CODICE_FISCALE", value: "TROPPO-LUNGO-E-NON-VALIDO", countryCode: "IT" },
        ],
      },
    }).success,
    false,
  );
  const adjusted = documentInputSchema.parse({
    ...invoice,
    paymentMethod: "MP05",
    causale: "Cessione beni usati",
    notes: "Incasso registrato manualmente",
  });
  const xml = generateFatturaXml(syntheticFiscalProfile, adjusted, { year: 2026, number: 5 });
  await validateFatturaXml(xml);
  assert.match(xml, /<ModalitaPagamento>MP05<\/ModalitaPagamento>/);
  assert.match(xml, /<Causale>Cessione beni usati<\/Causale>/);
  assert.match(xml, /<Causale>Incasso registrato manualmente<\/Causale>/);
});
