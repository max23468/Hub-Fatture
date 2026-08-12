import { createHash } from "node:crypto";

import { create } from "xmlbuilder2";
import { z } from "zod";

import {
  containsNullByte,
  decimalToCents,
  POSTGRES_INTEGER_MAX,
  postgresDateSchema,
} from "./orders.ts";

const text = (max: number) => z.string().trim().min(1).max(max);
const country = z.string().trim().toUpperCase().length(2);
const taxIdentifier = z
  .object({
    type: z.enum(["CODICE_FISCALE", "PARTITA_IVA", "ALTRO"]),
    value: text(28).transform((value) => value.toUpperCase()),
    countryCode: country.optional(),
  })
  .superRefine((identifier, context) => {
    if (identifier.type === "CODICE_FISCALE" && !/^[A-Z0-9]{11,16}$/.test(identifier.value)) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "Codice fiscale non serializzabile",
      });
    }
    if (
      identifier.type === "PARTITA_IVA" &&
      (identifier.countryCode ?? "IT") === "IT" &&
      !/^\d{11}$/.test(identifier.value)
    ) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "Partita IVA italiana non valida",
      });
    }
  });
export const foreignCustomerFallbackTaxCode = "99999999999";
const fiscalAddress = z.object({
  line1: text(60),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{5}$/),
  city: text(60),
  province: z.string().trim().max(2).optional(),
  countryCode: country,
});
const recipientAddress = z
  .object({
    line1: text(1000),
    line2: text(1000).optional(),
    postalCode: text(1000),
    city: text(1000),
    province: text(1000).optional(),
    countryCode: country,
  })
  .superRefine((value, context) => {
    if (value.countryCode === "IT" && !/^\d{5}$/.test(value.postalCode)) {
      context.addIssue({
        code: "custom",
        path: ["postalCode"],
        message: "CAP italiano non valido",
      });
    }
    if (value.countryCode === "IT" && value.province && value.province.length !== 2) {
      context.addIssue({
        code: "custom",
        path: ["province"],
        message: "Provincia italiana non valida",
      });
    }
  });

export const fiscalProfileSchema = z
  .object({
    transmitter: z.object({ countryCode: country, taxCode: text(28) }),
    seller: z.object({
      vatCountryCode: country,
      vatCode: text(28),
      taxCode: text(28).optional(),
      businessName: text(80),
      taxRegime: z.literal("RF14"),
      address: fiscalAddress,
      phone: text(12).optional(),
      email: z.email().max(256).optional(),
    }),
    taxNature: z.literal("N5"),
    legalReference: z.literal("Regime del margine Art. 36 41/95"),
    series: z.literal("FPR"),
    numbering: z.object({
      cadence: z.literal("ANNUAL"),
      sharedByInvoiceAndCreditNote: z.literal(true),
      documentDatePolicy: z.literal("APPROVAL_DATE"),
      rejectedDocumentPolicy: z.literal("CORRECT_SAME_NUMBER_AND_DATE"),
      lastObservedYear: z.number().int().min(2000).max(9999),
      lastObservedNumber: z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX),
      sourceXmlSha256: z.string().regex(/^[0-9a-f]{64}$/),
      approvedAt: z.iso.datetime({ offset: true }),
    }),
    payment: z.object({
      condition: z.literal("TP02"),
      invoiceMethod: z.literal("MP08"),
      creditNoteMethod: z.literal("MP05"),
    }),
  })
  .refine((value) => !containsNullByte(value), "Il profilo contiene byte NUL");

export type FiscalProfile = z.infer<typeof fiscalProfileSchema>;

export function fiscalProfileFromAcceptedInvoiceXml(
  xml: string,
  approvedAt: string,
  latestDocumentXml = xml,
): FiscalProfile {
  const source = acceptedFiscalDocument(xml);
  if (source.type !== "TD01") {
    throw new Error("Il file del profilo non è una fattura privata TD01 FPR12");
  }
  const latest = latestDocumentXml === xml ? source : acceptedFiscalDocument(latestDocumentXml);
  if (latest.transmitter !== source.transmitter || latest.seller !== source.seller) {
    throw new Error("L’ultimo documento appartiene a un cedente o trasmittente diverso");
  }
  const observed =
    latest.year > source.year || (latest.year === source.year && latest.number > source.number)
      ? latest
      : source;
  const { header, body } = source;
  const transmission = xmlRecord(header.DatiTrasmissione);
  const transmitter = xmlRecord(transmission.IdTrasmittente);
  const supplier = xmlRecord(header.CedentePrestatore);
  const supplierData = xmlRecord(supplier.DatiAnagrafici);
  const supplierVat = xmlRecord(supplierData.IdFiscaleIVA);
  const supplierName = xmlRecord(supplierData.Anagrafica);
  const supplierAddress = xmlRecord(supplier.Sede);
  const contacts = xmlRecord(supplier.Contatti);
  const goods = xmlRecord(body.DatiBeniServizi);
  const summary = xmlRecord(goods.DatiRiepilogo);
  const payment = acceptedPayment(body);
  return fiscalProfileSchema.parse({
    transmitter: {
      countryCode: xmlValue(transmitter.IdPaese),
      taxCode: xmlValue(transmitter.IdCodice),
    },
    seller: {
      vatCountryCode: xmlValue(supplierVat.IdPaese),
      vatCode: xmlValue(supplierVat.IdCodice),
      taxCode: xmlOptional(supplierData.CodiceFiscale),
      businessName: xmlValue(supplierName.Denominazione),
      taxRegime: xmlValue(supplierData.RegimeFiscale),
      address: {
        line1: [xmlValue(supplierAddress.Indirizzo), xmlOptional(supplierAddress.NumeroCivico)]
          .filter(Boolean)
          .join(" "),
        postalCode: xmlValue(supplierAddress.CAP),
        city: xmlValue(supplierAddress.Comune),
        province: xmlOptional(supplierAddress.Provincia),
        countryCode: xmlValue(supplierAddress.Nazione),
      },
      phone: xmlOptional(contacts.Telefono),
      email: xmlOptional(contacts.Email),
    },
    taxNature: xmlValue(summary.Natura),
    legalReference: xmlValue(summary.RiferimentoNormativo),
    series: "FPR",
    numbering: {
      cadence: "ANNUAL",
      sharedByInvoiceAndCreditNote: true,
      documentDatePolicy: "APPROVAL_DATE",
      rejectedDocumentPolicy: "CORRECT_SAME_NUMBER_AND_DATE",
      lastObservedYear: observed.year,
      lastObservedNumber: observed.number,
      sourceXmlSha256: createHash("sha256").update(observed.xml).digest("hex"),
      approvedAt,
    },
    payment: {
      condition: payment.condition,
      invoiceMethod: payment.method,
      creditNoteMethod: "MP05",
    },
  });
}

function acceptedFiscalDocument(xml: string) {
  const parsed = create(xml).end({ format: "object" }) as Record<string, unknown>;
  const root = xmlRecord(parsed.FatturaElettronica);
  const header = xmlRecord(root.FatturaElettronicaHeader);
  const body = xmlRecord(root.FatturaElettronicaBody);
  const general = xmlRecord(xmlRecord(body.DatiGenerali).DatiGeneraliDocumento);
  const transmission = xmlRecord(header.DatiTrasmissione);
  const transmitter = xmlRecord(transmission.IdTrasmittente);
  const supplier = xmlRecord(header.CedentePrestatore);
  const supplierVat = xmlRecord(xmlRecord(supplier.DatiAnagrafici).IdFiscaleIVA);
  const type = xmlValue(general.TipoDocumento);
  const documentDate = xmlValue(general.Data);
  const documentNumber = /^FPR (\d+)\/(\d{2})$/.exec(xmlValue(general.Numero));
  const year = Number(documentDate.slice(0, 4));
  if (
    xmlValue(root["@versione"]) !== "FPR12" ||
    !["TD01", "TD04"].includes(type) ||
    !documentNumber ||
    Number(documentNumber[2]) !== year % 100
  ) {
    throw new Error("Il documento non contiene un progressivo FPR12 valido");
  }
  return {
    xml,
    header,
    body,
    type,
    documentDate,
    documentNumber: xmlValue(general.Numero),
    totalAmount: xmlOptional(general.ImportoTotaleDocumento)
      ? decimalToCents(xmlValue(general.ImportoTotaleDocumento))
      : undefined,
    year,
    number: Number(documentNumber[1]),
    transmitter: `${xmlValue(transmitter.IdPaese)}:${xmlValue(transmitter.IdCodice)}`,
    seller: `${xmlValue(supplierVat.IdPaese)}:${xmlValue(supplierVat.IdCodice)}`,
  };
}

function xmlArray(input: unknown): Record<string, unknown>[] {
  return (Array.isArray(input) ? input : [input]).map(xmlRecord);
}

function acceptedPayment(body: Record<string, unknown>) {
  if (body.DatiPagamento === undefined) {
    return { condition: "TP02" as const, method: "MP08" as const };
  }
  const blocks = xmlArray(body.DatiPagamento);
  const methods = blocks.flatMap((block) =>
    xmlArray(block.DettaglioPagamento).map((detail) => xmlValue(detail.ModalitaPagamento)),
  );
  if (
    blocks.some((block) => xmlValue(block.CondizioniPagamento) !== "TP02") ||
    methods.some((method) => method !== "MP08")
  ) {
    throw new Error("Il pagamento della fattura non coincide con il profilo fiscale");
  }
  return { condition: "TP02" as const, method: "MP08" as const };
}

/** Dati autorevoli necessari per collegare a HF una fattura storica scaricata da Aruba. */
export function acceptedInvoiceFromXml(xml: string, importedAt: string) {
  const source = acceptedFiscalDocument(xml);
  if (source.type !== "TD01") throw new Error("Il documento storico non è una fattura TD01");
  const general = xmlRecord(xmlRecord(source.body.DatiGenerali).DatiGeneraliDocumento);
  const transmission = xmlRecord(source.header.DatiTrasmissione);
  const customer = xmlRecord(source.header.CessionarioCommittente);
  const customerData = xmlRecord(customer.DatiAnagrafici);
  const name = xmlRecord(customerData.Anagrafica);
  const customerAddress = xmlRecord(customer.Sede);
  const vat = customerData.IdFiscaleIVA ? xmlRecord(customerData.IdFiscaleIVA) : null;
  const countryCode = xmlValue(customerAddress.Nazione);
  const businessName = xmlOptional(name.Denominazione);
  const recipient = {
    kind:
      countryCode !== "IT"
        ? ("EU" as const)
        : businessName
          ? ("BUSINESS_IT" as const)
          : ("PRIVATE_IT" as const),
    displayName: countryCode !== "IT" ? businessName : undefined,
    firstName: xmlOptional(name.Nome),
    lastName: xmlOptional(name.Cognome),
    businessName,
    certifiedEmail: xmlOptional(transmission.PECDestinatario),
    recipientCode: xmlOptional(transmission.CodiceDestinatario),
    taxIdentifiers: [
      ...(vat
        ? [
            {
              type: "PARTITA_IVA" as const,
              value: xmlValue(vat.IdCodice),
              countryCode: xmlValue(vat.IdPaese),
            },
          ]
        : []),
      ...(customerData.CodiceFiscale
        ? [{ type: "CODICE_FISCALE" as const, value: xmlValue(customerData.CodiceFiscale) }]
        : []),
    ],
    address: {
      line1: [xmlValue(customerAddress.Indirizzo), xmlOptional(customerAddress.NumeroCivico)]
        .filter(Boolean)
        .join(" "),
      postalCode: xmlValue(customerAddress.CAP),
      city: xmlValue(customerAddress.Comune),
      province: xmlOptional(customerAddress.Provincia),
      countryCode,
    },
  };
  const goods = xmlRecord(source.body.DatiBeniServizi);
  const lines = xmlArray(goods.DettaglioLinee).map((line) => ({
    description: xmlValue(line.Descrizione),
    quantity: 1,
    unitAmount: decimalToCents(xmlValue(line.PrezzoTotale)),
  }));
  const payment = acceptedPayment(source.body);
  const totalAmount = source.totalAmount ?? lines.reduce((sum, line) => sum + line.unitAmount, 0);
  const input = documentInputSchema.parse({
    kind: "INVOICE",
    documentDate: source.documentDate,
    recipient,
    lines,
    paymentStatus: "PAID",
    paymentMethod: payment.method,
  });
  if (lines.reduce((sum, line) => sum + line.unitAmount, 0) !== totalAmount) {
    throw new Error("Il totale della fattura storica non coincide con le righe");
  }
  return {
    ...source,
    totalAmount,
    input,
    profile: fiscalProfileFromAcceptedInvoiceXml(xml, importedAt),
    references: [
      ...(general.Causale === undefined
        ? []
        : (Array.isArray(general.Causale) ? general.Causale : [general.Causale]).map(xmlValue)),
      ...lines.map((line) => line.description),
    ],
  };
}

function xmlRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Struttura XML non riconosciuta");
  }
  return input as Record<string, unknown>;
}

function xmlValue(input: unknown): string {
  const value = xmlText(input);
  if (!value) throw new Error("Campo XML obbligatorio assente");
  return value;
}

function xmlOptional(input: unknown): string | undefined {
  return xmlText(input) || undefined;
}

function xmlText(input: unknown): string {
  if (typeof input === "string") return input.trim();
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const text = (input as Record<string, unknown>)["#"];
  return typeof text === "string" ? text.trim() : "";
}

export const documentInputSchema = z
  .object({
    kind: z.enum(["INVOICE", "CREDIT_NOTE"]),
    documentDate: postgresDateSchema,
    recipient: z.object({
      kind: z.enum(["PRIVATE_IT", "BUSINESS_IT", "EU"]),
      displayName: text(1000).optional(),
      firstName: text(1000).optional(),
      lastName: text(1000).optional(),
      businessName: text(1000).optional(),
      certifiedEmail: z.email().max(256).optional(),
      recipientCode: z
        .string()
        .trim()
        .regex(/^[A-Z0-9]{7}$/)
        .optional(),
      taxIdentifiers: z.array(taxIdentifier),
      address: recipientAddress,
    }),
    lines: z
      .array(
        z.object({
          orderId: z.string().regex(/^\d+$/).optional(),
          description: text(1000),
          quantity: z.number().int().positive().max(POSTGRES_INTEGER_MAX),
          unitAmount: z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX),
        }),
      )
      .min(1)
      .max(999),
    relatedInvoice: z
      .object({
        number: text(20),
        date: postgresDateSchema,
      })
      .optional(),
    paymentStatus: z.enum(["PAID", "PENDING"]),
    paymentMethod: z.enum(["MP01", "MP05", "MP08"]),
    causale: text(200).optional(),
    notes: text(200).optional(),
  })
  .refine((value) => !containsNullByte(value), "Il documento contiene byte NUL")
  .superRefine((value, context) => {
    const recipient = value.recipient;
    if (recipient.kind !== "EU" && recipient.taxIdentifiers.length === 0) {
      context.addIssue({ code: "custom", path: ["recipient"], message: "Dato fiscale mancante" });
    }
    if (recipient.kind === "PRIVATE_IT" && (!recipient.firstName || !recipient.lastName)) {
      context.addIssue({ code: "custom", path: ["recipient"], message: "Nome e cognome mancanti" });
    }
    if (
      recipient.kind === "BUSINESS_IT" &&
      !recipient.businessName &&
      (!recipient.firstName || !recipient.lastName)
    ) {
      context.addIssue({ code: "custom", path: ["recipient"], message: "Denominazione mancante" });
    }
    if (
      recipient.kind === "EU" &&
      !recipient.displayName &&
      !recipient.businessName &&
      (!recipient.firstName || !recipient.lastName)
    ) {
      context.addIssue({ code: "custom", path: ["recipient"], message: "Nome mancante" });
    }
    const total = value.lines.reduce((sum, line) => sum + line.quantity * line.unitAmount, 0);
    if (!Number.isSafeInteger(total) || total > POSTGRES_INTEGER_MAX) {
      context.addIssue({ code: "custom", path: ["lines"], message: "Totale fuori limite" });
    }
    if (value.kind === "INVOICE" && value.relatedInvoice) {
      context.addIssue({
        code: "custom",
        path: ["relatedInvoice"],
        message: "Una fattura non può riferire una fattura originaria",
      });
    }
  });

export type DocumentInput = z.infer<typeof documentInputSchema>;

export function fatturaPaText(value: string, max: number): string {
  return value.replace(/[^\u0020-\u007e\u00a0-\u00ff]/gu, "?").slice(0, max);
}

export function fatturaPaAddress(line1: string, line2?: string): string {
  const suffix = line2 ? `, ${fatturaPaText(line2, 57)}` : "";
  return `${fatturaPaText(line1, 60 - suffix.length)}${suffix}`;
}

function amount(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

type XmlNode = ReturnType<typeof create>;

function add(parent: XmlNode, name: string, value: string | number): XmlNode {
  return parent.ele(name).txt(String(value)).up();
}

function taxId(recipient: DocumentInput["recipient"], type: string) {
  return recipient.taxIdentifiers.find((candidate) => candidate.type === type);
}

function recipientCode(recipient: DocumentInput["recipient"]): string {
  if (recipient.kind === "EU") return "XXXXXXX";
  return recipient.recipientCode ?? "0000000";
}

export function fiscalNumberLabel(series: string, year: number, number: number): string {
  return `${series} ${String(number).padStart(4, "0")}/${String(year).slice(-2)}`;
}

export function generateFatturaXml(
  rawProfile: FiscalProfile,
  rawInput: DocumentInput,
  numbering: { year: number; number: number },
  options: { legacyEuFirstTaxIdentifier?: boolean } = {},
): string {
  const profile = fiscalProfileSchema.parse(rawProfile);
  const input = documentInputSchema.parse(rawInput);
  if (numbering.year !== Number(input.documentDate.slice(0, 4)) || numbering.number < 0) {
    throw new Error("Numerazione non coerente con la data documento");
  }

  const total = input.lines.reduce((sum, line) => sum + line.quantity * line.unitAmount, 0);
  const code = recipientCode(input.recipient);
  const documentType = input.kind === "INVOICE" ? "TD01" : "TD04";
  const paymentMethod = input.paymentMethod;
  const root = create({ version: "1.0", encoding: "UTF-8" }).ele("FatturaElettronica", {
    xmlns: "http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2",
    versione: "FPR12",
  });
  const header = root.ele("FatturaElettronicaHeader", { xmlns: "" });
  const transmission = header.ele("DatiTrasmissione");
  const transmitter = transmission.ele("IdTrasmittente");
  add(transmitter, "IdPaese", profile.transmitter.countryCode);
  add(transmitter, "IdCodice", profile.transmitter.taxCode);
  add(
    transmission,
    "ProgressivoInvio",
    `${String(numbering.year).slice(-2)}${String(numbering.number).padStart(8, "0")}`,
  );
  add(transmission, "FormatoTrasmissione", "FPR12");
  add(transmission, "CodiceDestinatario", code);
  if (code === "0000000" && input.recipient.certifiedEmail) {
    add(transmission, "PECDestinatario", input.recipient.certifiedEmail);
  }

  const supplier = header.ele("CedentePrestatore");
  const supplierData = supplier.ele("DatiAnagrafici");
  const supplierVat = supplierData.ele("IdFiscaleIVA");
  add(supplierVat, "IdPaese", profile.seller.vatCountryCode);
  add(supplierVat, "IdCodice", profile.seller.vatCode);
  if (profile.seller.taxCode) add(supplierData, "CodiceFiscale", profile.seller.taxCode);
  add(supplierData.ele("Anagrafica"), "Denominazione", profile.seller.businessName);
  add(supplierData, "RegimeFiscale", profile.seller.taxRegime);
  addAddress(supplier.ele("Sede"), profile.seller.address);
  if (profile.seller.phone || profile.seller.email) {
    const contacts = supplier.ele("Contatti");
    if (profile.seller.phone) add(contacts, "Telefono", profile.seller.phone);
    if (profile.seller.email) add(contacts, "Email", profile.seller.email);
  }

  const customer = header.ele("CessionarioCommittente");
  const customerData = customer.ele("DatiAnagrafici");
  const vat =
    taxId(input.recipient, "PARTITA_IVA") ??
    (input.recipient.kind === "EU"
      ? options.legacyEuFirstTaxIdentifier
        ? (input.recipient.taxIdentifiers[0] ?? {
            countryCode: input.recipient.address.countryCode,
            value: foreignCustomerFallbackTaxCode,
          })
        : {
            countryCode: input.recipient.address.countryCode,
            value: foreignCustomerFallbackTaxCode,
          }
      : undefined);
  if (vat) {
    const customerVat = customerData.ele("IdFiscaleIVA");
    add(customerVat, "IdPaese", vat.countryCode ?? input.recipient.address.countryCode);
    add(customerVat, "IdCodice", vat.value);
  }
  const fiscalCode = taxId(input.recipient, "CODICE_FISCALE");
  if (fiscalCode) add(customerData, "CodiceFiscale", fiscalCode.value);
  const customerName = customerData.ele("Anagrafica");
  if (input.recipient.businessName || input.recipient.displayName)
    add(
      customerName,
      "Denominazione",
      fatturaPaText(input.recipient.businessName ?? input.recipient.displayName!, 80),
    );
  else {
    add(customerName, "Nome", fatturaPaText(input.recipient.firstName!, 60));
    add(customerName, "Cognome", fatturaPaText(input.recipient.lastName!, 60));
  }
  addAddress(customer.ele("Sede"), input.recipient.address);

  const body = root.ele("FatturaElettronicaBody", { xmlns: "" });
  const general = body.ele("DatiGenerali");
  const generalDocument = general.ele("DatiGeneraliDocumento");
  add(generalDocument, "TipoDocumento", documentType);
  add(generalDocument, "Divisa", "EUR");
  add(generalDocument, "Data", input.documentDate);
  add(
    generalDocument,
    "Numero",
    fiscalNumberLabel(profile.series, numbering.year, numbering.number),
  );
  add(generalDocument, "ImportoTotaleDocumento", amount(total));
  if (input.causale) add(generalDocument, "Causale", fatturaPaText(input.causale, 200));
  if (input.notes) add(generalDocument, "Causale", fatturaPaText(input.notes, 200));
  if (input.kind === "CREDIT_NOTE" && input.relatedInvoice) {
    const related = general.ele("DatiFattureCollegate");
    add(related, "IdDocumento", input.relatedInvoice.number);
    add(related, "Data", input.relatedInvoice.date);
  }

  const goods = body.ele("DatiBeniServizi");
  input.lines.forEach((line, index) => {
    const detail = goods.ele("DettaglioLinee");
    add(detail, "NumeroLinea", index + 1);
    add(detail, "Descrizione", fatturaPaText(line.description, 1000));
    add(detail, "Quantita", `${line.quantity}.00`);
    add(detail, "PrezzoUnitario", amount(line.unitAmount));
    add(detail, "PrezzoTotale", amount(line.quantity * line.unitAmount));
    add(detail, "AliquotaIVA", "0.00");
    add(detail, "Natura", profile.taxNature);
  });
  const summary = goods.ele("DatiRiepilogo");
  add(summary, "AliquotaIVA", "0.00");
  add(summary, "Natura", profile.taxNature);
  add(summary, "ImponibileImporto", amount(total));
  add(summary, "Imposta", "0.00");
  add(summary, "RiferimentoNormativo", profile.legalReference);

  const payment = body.ele("DatiPagamento");
  add(payment, "CondizioniPagamento", profile.payment.condition);
  const paymentDetail = payment.ele("DettaglioPagamento");
  add(paymentDetail, "ModalitaPagamento", paymentMethod);
  add(paymentDetail, "DataScadenzaPagamento", input.documentDate);
  add(paymentDetail, "ImportoPagamento", amount(total));
  return `${root.end({ prettyPrint: true })}\n`;
}

function addAddress(
  parent: XmlNode,
  value: z.infer<typeof fiscalAddress> | z.infer<typeof recipientAddress>,
): void {
  const line2 = "line2" in value ? value.line2 : undefined;
  add(parent, "Indirizzo", fatturaPaAddress(value.line1, line2));
  add(parent, "CAP", value.countryCode === "IT" ? value.postalCode : "00000");
  add(parent, "Comune", fatturaPaText(value.city, 60));
  if (value.countryCode === "IT" && value.province)
    add(parent, "Provincia", value.province.toUpperCase());
  add(parent, "Nazione", value.countryCode);
}

export function xmlSha256(xml: string): string {
  return createHash("sha256").update(xml).digest("hex");
}

export function projectFatturaXml(profile: FiscalProfile, input: DocumentInput) {
  const year = Number(input.documentDate.slice(0, 4));
  const xml = generateFatturaXml(profile, input, { year, number: 0 });
  return { xml, sha256: xmlSha256(xml) };
}
