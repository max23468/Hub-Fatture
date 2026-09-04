import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { AppError } from "../../errors.ts";
import type { OrdersTestContext } from "./orders-test-support.test.ts";

import type { HistoricalMatchingState } from "./orders-history-matching.scenario.test.ts";
import type { PaymentsCoreState } from "./orders-payments-core.scenario.test.ts";

export async function runExtendedHistoricalScenario(
  context: OrdersTestContext,
  core: PaymentsCoreState,
  matching: HistoricalMatchingState,
) {
  const { orders, refunds, database } = context;
  const { historical, alreadyInvoiced, alreadyInvoicedId } = core;
  const { ebayWithoutReference, ebayInvoiceWithoutReference, euPersonalEbay, euPersonalInvoice } =
    matching;
  const euBusinessEbay = structuredClone(euPersonalEbay);
  euBusinessEbay.externalOrderId = "ebay-order-historical-eu-business";
  euBusinessEbay.externalCustomerId = "ebay-customer-historical-eu-business";
  euBusinessEbay.displayNumber = "26-12345-67904";
  euBusinessEbay.customer.companyName = "Atelier Bleu SARL";
  euBusinessEbay.customer.displayName = "Atelier Bleu SARL";
  euBusinessEbay.customer.canonicalProfile = {
    companyName: "Atelier Bleu SARL",
    displayName: "Atelier Bleu SARL",
  };
  euBusinessEbay.customer.billingAddress = {
    line1: "Straße der Rosen 16",
    postalCode: "10115",
    city: "Berlin",
    province: "EE",
    countryCode: "DE",
  };
  euBusinessEbay.total = "81.00";
  euBusinessEbay.lines[0].grossAmount = "81.00";
  euBusinessEbay.payments[0].amount = "81.00";
  euBusinessEbay.payments[0].externalPaymentId = "ebay-payment-historical-eu-business";
  euBusinessEbay.lines[0].externalLineId = "ebay-line-historical-eu-business";
  await orders.importOrders([euBusinessEbay], {
    id: 1,
    requestId: "test-import-ebay-history-eu-business",
  });
  const euBusinessEbayId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        euBusinessEbay.externalOrderId,
      ])
  ).rows[0]!.id;
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      euBusinessEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Gli articoli tedeschi non identificano la strada",
        invoiceXml: Buffer.from(
          euPersonalInvoice
            .toString()
            .replace("FPR 0026/26", "FPR 0030/26")
            .replaceAll("80.00", "81.00")
            .replace(
              "<Nome>Claire Marie</Nome>\n          <Cognome>Dupont</Cognome>",
              "<Denominazione>Atelier Bleu SARL</Denominazione>",
            )
            .replace("Avenue Martin des Fleurs du Lac", "Platz der Rosen")
            .replace("<NumeroCivico>12</NumeroCivico>", "<NumeroCivico>16</NumeroCivico>")
            .replace("<CAP>00000</CAP>", "<CAP>10115</CAP>")
            .replace("<Comune>Lione</Comune>", "<Comune>Berlin</Comune>")
            .replace("<Nazione>FR</Nazione>", "<Nazione>DE</Nazione>"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-german-connectors" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      euBusinessEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba UE con ragione sociale soltanto parziale",
        invoiceXml: Buffer.from(
          euPersonalInvoice
            .toString()
            .replace("FPR 0026/26", "FPR 0027/26")
            .replaceAll("80.00", "81.00")
            .replace(
              "<Nome>Claire Marie</Nome>\n          <Cognome>Dupont</Cognome>",
              "<Denominazione>Atelier Bleu</Denominazione>",
            )
            .replace("Avenue Martin des Fleurs du Lac", "Straße der Rosen")
            .replace("<NumeroCivico>12</NumeroCivico>", "<NumeroCivico>16</NumeroCivico>")
            .replace("<CAP>00000</CAP>", "<CAP>10115</CAP>")
            .replace("<Comune>Lione</Comune>", "<Comune>Berlin</Comune>")
            .replace("<Nazione>FR</Nazione>", "<Nazione>DE</Nazione>"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-partial-eu-business-name" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await orders.reconcileHistoricalOrder(
    euBusinessEbayId,
    {
      outcome: "NOT_INVOICED",
      reference: "Ordine aziendale sintetico escluso dopo il controllo del nome parziale",
    },
    { id: 1, canApprove: true, requestId: "test-clear-partial-eu-business" },
  );
  const streetMarkerNameEbay = structuredClone(ebayWithoutReference);
  streetMarkerNameEbay.externalOrderId = "ebay-order-historical-street-marker-name";
  streetMarkerNameEbay.externalCustomerId = "ebay-customer-historical-street-marker-name";
  streetMarkerNameEbay.displayNumber = "26-12345-67907";
  streetMarkerNameEbay.customer.billingAddress.line1 = "Via Alessandro Camera Nord 10";
  streetMarkerNameEbay.total = "84.00";
  streetMarkerNameEbay.lines[0].grossAmount = "84.00";
  streetMarkerNameEbay.payments[0].amount = "84.00";
  streetMarkerNameEbay.payments[0].externalPaymentId = "ebay-payment-historical-street-marker-name";
  streetMarkerNameEbay.lines[0].externalLineId = "ebay-line-historical-street-marker-name";
  await orders.importOrders([streetMarkerNameEbay], {
    id: 1,
    requestId: "test-import-ebay-history-street-marker-name",
  });
  const streetMarkerNameEbayId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        streetMarkerNameEbay.externalOrderId,
      ])
  ).rows[0]!.id;
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      streetMarkerNameEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Un toponimo non è una coda immobiliare",
        invoiceXml: Buffer.from(
          ebayInvoiceWithoutReference
            .toString()
            .replace("FPR 0020/26", "FPR 0031/26")
            .replaceAll("75.00", "84.00")
            .replace(
              "<Indirizzo>VIA CLIENTE</Indirizzo>\n        <NumeroCivico>2</NumeroCivico>",
              "<Indirizzo>Via Alessandro Camera Sud</Indirizzo><NumeroCivico>10</NumeroCivico>",
            ),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-street-marker-as-unit" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await orders.reconcileHistoricalOrder(
    streetMarkerNameEbayId,
    {
      outcome: "NOT_INVOICED",
      reference: "Ordine sintetico escluso dopo il controllo del toponimo",
    },
    { id: 1, canApprove: true, requestId: "test-clear-street-marker-name" },
  );
  const reusedEbayInvoice = structuredClone(ebayWithoutReference);
  reusedEbayInvoice.externalOrderId = "ebay-order-historical-reused-document";
  reusedEbayInvoice.displayNumber = "26-12345-67892";
  reusedEbayInvoice.updatedAt = "2026-08-18T09:30:00Z";
  reusedEbayInvoice.payments[0].externalPaymentId = "ebay-payment-historical-reused-document";
  reusedEbayInvoice.lines[0].externalLineId = "ebay-line-historical-reused-document";
  await orders.importOrders([reusedEbayInvoice], {
    id: 1,
    requestId: "test-import-ebay-history-reused-document",
  });
  const reusedEbayInvoiceId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        reusedEbayInvoice.externalOrderId,
      ])
  ).rows[0]!.id;
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      reusedEbayInvoiceId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Lo stesso documento Aruba non può essere riutilizzato senza riferimento",
        invoiceXml: ebayInvoiceWithoutReference,
      },
      { id: 1, canApprove: true, requestId: "test-reconcile-ebay-history-reused-document" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await orders.reconcileHistoricalOrder(
    reusedEbayInvoiceId,
    {
      outcome: "NOT_INVOICED",
      reference: "Ordine di prova escluso dopo il controllo sul documento già collegato",
    },
    { id: 1, canApprove: true, requestId: "test-clear-ebay-history-reused-document" },
  );
  const ambiguousRefundEbay = structuredClone(ebayWithoutReference);
  ambiguousRefundEbay.externalOrderId = "ebay-order-historical-ambiguous-refund";
  ambiguousRefundEbay.displayNumber = "26-12345-67893";
  ambiguousRefundEbay.updatedAt = "2026-08-18T09:45:00Z";
  ambiguousRefundEbay.payments[0].externalPaymentId = "ebay-payment-historical-ambiguous-refund";
  ambiguousRefundEbay.lines[0].externalLineId = "ebay-line-historical-ambiguous-refund";
  ambiguousRefundEbay.refunds = [
    {
      externalRefundId: "ebay-refund-historical-ambiguous",
      status: "AMBIGUOUS",
      amount: null,
      completedAt: "2026-08-18T09:40:00Z",
      raw: {},
    },
  ];
  await orders.importOrders([ambiguousRefundEbay], {
    id: 1,
    requestId: "test-import-ebay-history-ambiguous-refund",
  });
  const ambiguousRefundEbayId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        ambiguousRefundEbay.externalOrderId,
      ])
  ).rows[0]!.id;
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      ambiguousRefundEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Il rimborso ambiguo impedisce il fallback senza riferimento eBay",
        invoiceXml: Buffer.from(
          ebayInvoiceWithoutReference.toString().replace("FPR 0020/26", "FPR 0021/26"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reconcile-ebay-history-ambiguous-refund" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  const historicalInvoiceXml = Buffer.from(
    (await readFile("tests/fixtures/fatturapa/accepted-invoice.anonymized.xml", "utf8"))
      .replace("FPR 0001/26", "FPR 0010/26")
      .replace("#1001", "#S-1001")
      .replace("<Data>2026-08-10</Data>", "<Data>2026-08-19</Data>")
      .replace(
        "<ModalitaPagamento>MP08</ModalitaPagamento>",
        "<ModalitaPagamento>MP01</ModalitaPagamento>",
      )
      .replaceAll("123.45", "122.00"),
  );
  await database.getPool().query(
    `UPDATE orders SET trigger_status = 'INVOICED',
         historical_reconciliation_outcome = 'ALREADY_INVOICED',
         historical_reconciliation_reference = 'Documento Aruba da collegare dopo aggiornamento',
         historical_reconciled_at = now()
       WHERE id = $1`,
    [alreadyInvoicedId],
  );
  assert.ok(
    (await orders.listOpenActivities()).rows.some(
      (activity) => activity.kind === "ORDER" && activity.id === String(alreadyInvoicedId),
    ),
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      alreadyInvoicedId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba precedente all’ordine",
        invoiceXml: Buffer.from(
          historicalInvoiceXml
            .toString()
            .replace("<Data>2026-08-19</Data>", "<Data>2026-08-18</Data>"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reconcile-invoice-before-order" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      alreadyInvoicedId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba non riferito all’ordine",
        invoiceXml: Buffer.from(
          historicalInvoiceXml
            .toString()
            .replace("#S-1001", "#S-10010")
            .replace("</FatturaElettronica>", "<!-- Shopify #S-1001 --></FatturaElettronica>"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reconcile-unrelated-invoice" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await orders.reconcileHistoricalOrder(
    alreadyInvoicedId,
    {
      outcome: "ALREADY_INVOICED",
      reference: "Documento Aruba FPR 0010/26 verificato",
      invoiceXml: historicalInvoiceXml,
    },
    { id: 1, canApprove: true, requestId: "test-reconcile-historical-invoiced" },
  );
  assert.equal(
    (
      await database.getPool().query(
        `SELECT payment_method FROM documents
           JOIN document_orders ON document_orders.document_id = documents.id
           WHERE document_orders.order_id = $1 AND documents.origin = 'ARUBA_HISTORY'`,
        [alreadyInvoicedId],
      )
    ).rows[0].payment_method,
    "MP01",
  );
  const historicalDocumentCount = Number(
    (
      await database
        .getPool()
        .query("SELECT count(*) FROM documents WHERE origin = 'ARUBA_HISTORY'")
    ).rows[0].count,
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      alreadyInvoicedId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Secondo collegamento non consentito",
        invoiceXml: Buffer.from(historicalInvoiceXml.toString().replace("0010/26", "0011/26")),
      },
      { id: 1, canApprove: true, requestId: "test-reconcile-historical-twice" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "CONFLICT_REVISION",
  );
  assert.equal(
    Number(
      (
        await database
          .getPool()
          .query("SELECT count(*) FROM documents WHERE origin = 'ARUBA_HISTORY'")
      ).rows[0].count,
    ),
    historicalDocumentCount,
  );
  const existingHistoricalRefundId = (
    await database
      .getPool()
      .query<{ id: string }>(
        "SELECT id FROM refunds WHERE external_refund_id = 'historical-invoiced-existing-refund'",
      )
  ).rows[0]!.id;
  const historicalCreditNoteId = await refunds.processRefund(existingHistoricalRefundId);
  assert.ok(historicalCreditNoteId);
  assert.equal(
    (await refunds.getCreditNoteProjection(historicalCreditNoteId!))?.invoiceNumber,
    "FPR 0010/26",
  );
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT applied_before_issue,
                  (SELECT count(*)::int FROM jobs
                   WHERE type = 'process_refund'
                     AND payload_json ->> 'refundId' = refunds.id::text) AS jobs
           FROM refunds WHERE external_refund_id = 'historical-invoiced-existing-refund'`,
      )
    ).rows[0],
    { applied_before_issue: false, jobs: 1 },
  );

  const netHistorical = structuredClone(historical);
  netHistorical.externalOrderId = "shop-order-historical-net-invoice";
  netHistorical.displayNumber = "#S-HIST-NET";
  netHistorical.customer.taxIdentifiers[0].value = "RSSMRA80A01H501U";
  netHistorical.historical = true;
  netHistorical.updatedAt = "2026-08-19T09:50:00Z";
  netHistorical.payments[0].externalPaymentId = "historical-net-invoice-payment";
  netHistorical.payments[0].method = "shopify_payments";
  netHistorical.payments[0].shopifyPaymentsFeeAmount = "2.00";
  netHistorical.refunds = [
    {
      externalRefundId: "historical-net-invoice-refund",
      status: "COMPLETED",
      amount: "10.00",
      completedAt: "2026-08-18T09:40:00Z",
      raw: {},
    },
    {
      externalRefundId: "historical-net-invoice-post-refund",
      status: "COMPLETED",
      amount: "5.00",
      completedAt: "2026-08-20T09:40:00Z",
      raw: {},
    },
  ];
  await orders.importOrders([netHistorical], {
    id: 1,
    requestId: "test-import-historical-net-invoice",
  });
  const netHistoricalId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        netHistorical.externalOrderId,
      ])
  ).rows[0]!.id;
  await orders.reconcileHistoricalOrder(
    netHistoricalId,
    {
      outcome: "ALREADY_INVOICED",
      reference: "Documento Aruba netto del rimborso pre-emissione",
      invoiceXml: Buffer.from(
        (await readFile("tests/fixtures/fatturapa/accepted-invoice.anonymized.xml", "utf8"))
          .replace("FPR 0001/26", "FPR 0011/26")
          .replace("#1001", netHistorical.displayNumber)
          .replace("<Data>2026-08-10</Data>", "<Data>2026-08-19</Data>")
          .replaceAll("123.45", "110.00")
          .replace(/\s*<Contatti>[\s\S]*?<\/Contatti>/, ""),
      ),
    },
    { id: 1, canApprove: true, requestId: "test-reconcile-historical-net-invoice" },
  );
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT refunds.external_refund_id, refunds.applied_before_issue,
                  document_orders.amount,
                  (SELECT count(*)::int FROM jobs
                   WHERE type = 'process_refund'
                     AND payload_json ->> 'refundId' = refunds.id::text) AS jobs
           FROM refunds
           JOIN document_orders ON document_orders.order_id = refunds.order_id
           WHERE refunds.external_refund_id IN
             ('historical-net-invoice-refund', 'historical-net-invoice-post-refund')
           ORDER BY refunds.external_refund_id`,
      )
    ).rows,
    [
      {
        external_refund_id: "historical-net-invoice-post-refund",
        applied_before_issue: false,
        amount: 11000,
        jobs: 1,
      },
      {
        external_refund_id: "historical-net-invoice-refund",
        applied_before_issue: true,
        amount: 11000,
        jobs: 0,
      },
    ],
  );
  const groupedHistoricalFirst = structuredClone(historical);
  groupedHistoricalFirst.externalOrderId = "shop-order-historical-grouped-first";
  groupedHistoricalFirst.displayNumber = "#S-HIST-GROUP-1";
  groupedHistoricalFirst.customer.taxIdentifiers[0].value = "RSSMRA80A01H501U";
  groupedHistoricalFirst.historical = true;
  groupedHistoricalFirst.updatedAt = "2026-08-19T09:55:00Z";
  groupedHistoricalFirst.payments[0].externalPaymentId = "historical-grouped-first-payment";
  const groupedHistoricalSecond = structuredClone(groupedHistoricalFirst);
  groupedHistoricalSecond.externalOrderId = "shop-order-historical-grouped-second";
  groupedHistoricalSecond.displayNumber = "#S-HIST-GROUP-2";
  groupedHistoricalSecond.payments[0].externalPaymentId = "historical-grouped-second-payment";
  await orders.importOrders([groupedHistoricalFirst, groupedHistoricalSecond], {
    id: 1,
    requestId: "test-import-historical-grouped-invoice",
  });
  const groupedIds = (
    await database.getPool().query<{ id: string; external_order_id: string }>(
      `SELECT id, external_order_id FROM orders
         WHERE external_order_id IN ($1, $2) ORDER BY external_order_id`,
      [groupedHistoricalFirst.externalOrderId, groupedHistoricalSecond.externalOrderId],
    )
  ).rows;
  const groupedLine = `<DettaglioLinee>
        <NumeroLinea>2</NumeroLinea>
        <Descrizione>Vendita beni usati - Ordine Shopify #S-HIST-GROUP-2</Descrizione>
        <Quantita>1.00</Quantita>
        <PrezzoUnitario>122.00</PrezzoUnitario>
        <PrezzoTotale>122.00</PrezzoTotale>
        <AliquotaIVA>0.00</AliquotaIVA>
        <Natura>N5</Natura>
      </DettaglioLinee>`;
  const groupedInvoiceXml = Buffer.from(
    (await readFile("tests/fixtures/fatturapa/accepted-invoice.anonymized.xml", "utf8"))
      .replace("FPR 0001/26", "FPR 0012/26")
      .replace("#1001", "#S-HIST-GROUP-1")
      .replace("<Data>2026-08-10</Data>", "<Data>2026-08-19</Data>")
      .replaceAll("123.45", "122.00")
      .replace("</DettaglioLinee>", `</DettaglioLinee>\n      ${groupedLine}`)
      .replace("<ImportoTotaleDocumento>122.00", "<ImportoTotaleDocumento>244.00")
      .replace("<ImponibileImporto>122.00", "<ImponibileImporto>244.00")
      .replace("<ImportoPagamento>122.00", "<ImportoPagamento>244.00"),
  );
  for (const grouped of groupedIds) {
    await orders.reconcileHistoricalOrder(
      grouped.id,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba cumulativo verificato",
        invoiceXml: groupedInvoiceXml,
      },
      { id: 1, canApprove: true, requestId: `test-reconcile-${grouped.external_order_id}` },
    );
  }
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT count(DISTINCT documents.id)::int AS documents,
                  count(document_orders.order_id)::int AS orders,
                  sum(document_orders.amount)::int AS attributed_amount,
                  max(documents.total_amount)::int AS document_total
           FROM documents
           JOIN document_orders ON document_orders.document_id = documents.id
           WHERE documents.fiscal_number = 12 AND documents.fiscal_year = 2026`,
      )
    ).rows[0],
    { documents: 1, orders: 2, attributed_amount: 24400, document_total: 24400 },
  );
  const historicalWithoutTaxId = structuredClone(historical);
  historicalWithoutTaxId.externalOrderId = "shop-order-historical-without-tax-id";
  historicalWithoutTaxId.externalCustomerId = "shop-customer-historical-without-tax-id";
  historicalWithoutTaxId.displayNumber = "#S-HIST-NO-TAX-ID";
  historicalWithoutTaxId.customer.taxIdentifiers = [];
  historicalWithoutTaxId.customer.firstName = "Rossi";
  historicalWithoutTaxId.customer.lastName = "Mario Garcia";
  historicalWithoutTaxId.customer.billingAddress = {
    line1: "Via della Scala 2 1A",
    line2: "Interno 7",
    postalCode: "00100",
    city: "Roma",
    province: "RM",
    countryCode: "IT",
  };
  historicalWithoutTaxId.historical = true;
  historicalWithoutTaxId.updatedAt = "2026-08-19T09:57:00Z";
  historicalWithoutTaxId.payments[0].externalPaymentId = "historical-without-tax-id-payment";
  await orders.importOrders([historicalWithoutTaxId], {
    id: 1,
    requestId: "test-import-historical-without-tax-id",
  });
  const historicalWithoutTaxIdId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        historicalWithoutTaxId.externalOrderId,
      ])
  ).rows[0]!.id;
  const historicalWithoutTaxIdXml = Buffer.from(
    (await readFile("tests/fixtures/fatturapa/accepted-invoice.anonymized.xml", "utf8"))
      .replace("FPR 0001/26", "FPR 0013/26")
      .replace("Vendita beni usati - Ordine Shopify #1001", "Vendita beni usati")
      .replace("<Data>2026-08-10</Data>", "<Data>2026-08-19</Data>")
      .replace(
        "<Indirizzo>VIA CLIENTE</Indirizzo>\n        <NumeroCivico>2</NumeroCivico>",
        "<Indirizzo>Via della Scala</Indirizzo><NumeroCivico>2</NumeroCivico>",
      )
      .replaceAll("123.45", "122.00"),
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      historicalWithoutTaxIdId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba con destinatario diverso",
        invoiceXml: Buffer.from(
          historicalWithoutTaxIdXml.toString().replace("<Nome>MARIO</Nome>", "<Nome>Luigi</Nome>"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reconcile-wrong-recipient-without-tax-id" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await orders.reconcileHistoricalOrder(
    historicalWithoutTaxIdId,
    {
      outcome: "ALREADY_INVOICED",
      reference:
        "Documento Aruba FPR 0013/26 con destinatario verificato senza identificativo fiscale",
      invoiceXml: historicalWithoutTaxIdXml,
      manualReviewApproved: true,
    },
    { id: 1, canApprove: true, requestId: "test-reconcile-recipient-without-tax-id" },
  );
  const historicalWithNumericComplement = structuredClone(historicalWithoutTaxId);
  historicalWithNumericComplement.externalOrderId = "shop-order-historical-numeric-complement";
  historicalWithNumericComplement.externalCustomerId =
    "shop-customer-historical-numeric-complement";
  historicalWithNumericComplement.displayNumber = "#S-HIST-NUMERIC-COMPLEMENT";
  historicalWithNumericComplement.customer.billingAddress = {
    line1: "Via della Scala",
    line2: "Interno 2",
    postalCode: "00100",
    city: "Roma",
    province: "RM",
    countryCode: "IT",
  };
  historicalWithNumericComplement.payments[0].externalPaymentId =
    "historical-numeric-complement-payment";
  await orders.importOrders([historicalWithNumericComplement], {
    id: 1,
    requestId: "test-import-historical-numeric-complement",
  });
  const historicalWithNumericComplementId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        historicalWithNumericComplement.externalOrderId,
      ])
  ).rows[0]!.id;
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      historicalWithNumericComplementId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba FPR 0035/26 senza prova del civico",
        invoiceXml: Buffer.from(
          historicalWithoutTaxIdXml.toString().replace("FPR 0013/26", "FPR 0035/26"),
        ),
        manualReviewApproved: true,
      },
      { id: 1, canApprove: true, requestId: "test-reject-numeric-address-complement" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  const historicalWithPostposedFloor = structuredClone(historicalWithoutTaxId);
  historicalWithPostposedFloor.externalOrderId = "shop-order-historical-postposed-floor";
  historicalWithPostposedFloor.externalCustomerId = "shop-customer-historical-postposed-floor";
  historicalWithPostposedFloor.displayNumber = "#S-HIST-POSTPOSED-FLOOR";
  historicalWithPostposedFloor.customer.billingAddress = {
    line1: "Via della Scala 7",
    line2: "2° piano",
    postalCode: "00100",
    city: "Roma",
    province: "RM",
    countryCode: "IT",
  };
  historicalWithPostposedFloor.payments[0].externalPaymentId = "historical-postposed-floor-payment";
  await orders.importOrders([historicalWithPostposedFloor], {
    id: 1,
    requestId: "test-import-historical-postposed-floor",
  });
  const historicalWithPostposedFloorId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        historicalWithPostposedFloor.externalOrderId,
      ])
  ).rows[0]!.id;
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      historicalWithPostposedFloorId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba FPR 0037/26 con piano diverso dal civico",
        invoiceXml: Buffer.from(
          historicalWithoutTaxIdXml.toString().replace("FPR 0013/26", "FPR 0037/26"),
        ),
        manualReviewApproved: true,
      },
      { id: 1, canApprove: true, requestId: "test-reject-postposed-floor-as-civic" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  const historicalWithUnmarkedPostposedFloor = structuredClone(historicalWithoutTaxId);
  historicalWithUnmarkedPostposedFloor.externalOrderId =
    "shop-order-historical-unmarked-postposed-floor";
  historicalWithUnmarkedPostposedFloor.externalCustomerId =
    "shop-customer-historical-unmarked-postposed-floor";
  historicalWithUnmarkedPostposedFloor.displayNumber = "#S-HIST-UNMARKED-POSTPOSED-FLOOR";
  historicalWithUnmarkedPostposedFloor.customer.billingAddress = {
    line1: "Via della Scala 7",
    line2: "2. Obergeschoss",
    postalCode: "00100",
    city: "Roma",
    province: "RM",
    countryCode: "IT",
  };
  historicalWithUnmarkedPostposedFloor.payments[0].externalPaymentId =
    "historical-unmarked-postposed-floor-payment";
  await orders.importOrders([historicalWithUnmarkedPostposedFloor], {
    id: 1,
    requestId: "test-import-historical-unmarked-postposed-floor",
  });
  const historicalWithUnmarkedPostposedFloorId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        historicalWithUnmarkedPostposedFloor.externalOrderId,
      ])
  ).rows[0]!.id;
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      historicalWithUnmarkedPostposedFloorId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba FPR 0040/26 con complemento numerico sconosciuto",
        invoiceXml: Buffer.from(
          historicalWithoutTaxIdXml.toString().replace("FPR 0013/26", "FPR 0040/26"),
        ),
        manualReviewApproved: true,
      },
      { id: 1, canApprove: true, requestId: "test-reject-eu-floor-as-civic" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  const historicalWithSeparatedCivicAndUnit = structuredClone(historicalWithoutTaxId);
  historicalWithSeparatedCivicAndUnit.externalOrderId =
    "shop-order-historical-separated-civic-unit";
  historicalWithSeparatedCivicAndUnit.externalCustomerId =
    "shop-customer-historical-separated-civic-unit";
  historicalWithSeparatedCivicAndUnit.displayNumber = "#S-HIST-SEPARATED-CIVIC-UNIT";
  historicalWithSeparatedCivicAndUnit.customer.billingAddress = {
    line1: "Via Roma",
    line2: "2, Scala A",
    postalCode: "00100",
    city: "Roma",
    province: "RM",
    countryCode: "IT",
  };
  historicalWithSeparatedCivicAndUnit.payments[0].externalPaymentId =
    "historical-separated-civic-unit-payment";
  await orders.importOrders([historicalWithSeparatedCivicAndUnit], {
    id: 1,
    requestId: "test-import-historical-separated-civic-unit",
  });
  const historicalWithSeparatedCivicAndUnitId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        historicalWithSeparatedCivicAndUnit.externalOrderId,
      ])
  ).rows[0]!.id;
  await orders.reconcileHistoricalOrder(
    historicalWithSeparatedCivicAndUnitId,
    {
      outcome: "ALREADY_INVOICED",
      reference: "Documento Aruba FPR 0038/26 con civico prima del complemento",
      invoiceXml: Buffer.from(
        historicalWithoutTaxIdXml
          .toString()
          .replace("FPR 0013/26", "FPR 0038/26")
          .replace("Via della Scala", "Via Roma"),
      ),
      manualReviewApproved: true,
    },
    { id: 1, canApprove: true, requestId: "test-reconcile-civic-before-unit" },
  );
  const historicalWithSeparatedCivicAndFloor = structuredClone(historicalWithoutTaxId);
  historicalWithSeparatedCivicAndFloor.externalOrderId =
    "shop-order-historical-separated-civic-floor";
  historicalWithSeparatedCivicAndFloor.externalCustomerId =
    "shop-customer-historical-separated-civic-floor";
  historicalWithSeparatedCivicAndFloor.displayNumber = "#S-HIST-SEPARATED-CIVIC-FLOOR";
  historicalWithSeparatedCivicAndFloor.customer.billingAddress = {
    line1: "Via Roma",
    line2: "2, Piano 1",
    postalCode: "00100",
    city: "Roma",
    province: "RM",
    countryCode: "IT",
  };
  historicalWithSeparatedCivicAndFloor.payments[0].externalPaymentId =
    "historical-separated-civic-floor-payment";
  await orders.importOrders([historicalWithSeparatedCivicAndFloor], {
    id: 1,
    requestId: "test-import-historical-separated-civic-floor",
  });
  const historicalWithSeparatedCivicAndFloorId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        historicalWithSeparatedCivicAndFloor.externalOrderId,
      ])
  ).rows[0]!.id;
  await orders.reconcileHistoricalOrder(
    historicalWithSeparatedCivicAndFloorId,
    {
      outcome: "ALREADY_INVOICED",
      reference: "Documento Aruba FPR 0047/26 con civico prima del piano",
      invoiceXml: Buffer.from(
        historicalWithoutTaxIdXml
          .toString()
          .replace("FPR 0013/26", "FPR 0047/26")
          .replace("Via della Scala", "Via Roma"),
      ),
      manualReviewApproved: true,
    },
    { id: 1, canApprove: true, requestId: "test-reconcile-civic-before-floor" },
  );
  const historicalWithOrdinalFloor = structuredClone(historicalWithoutTaxId);
  historicalWithOrdinalFloor.externalOrderId = "shop-order-historical-ordinal-floor";
  historicalWithOrdinalFloor.externalCustomerId = "shop-customer-historical-ordinal-floor";
  historicalWithOrdinalFloor.displayNumber = "#S-HIST-ORDINAL-FLOOR";
  historicalWithOrdinalFloor.customer.billingAddress = {
    line1: "Via Roma",
    line2: "10, 2° piano",
    postalCode: "00100",
    city: "Roma",
    province: "RM",
    countryCode: "IT",
  };
  historicalWithOrdinalFloor.payments[0].externalPaymentId = "historical-ordinal-floor-payment";
  await orders.importOrders([historicalWithOrdinalFloor], {
    id: 1,
    requestId: "test-import-historical-ordinal-floor",
  });
  const historicalWithOrdinalFloorId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        historicalWithOrdinalFloor.externalOrderId,
      ])
  ).rows[0]!.id;
  await orders.reconcileHistoricalOrder(
    historicalWithOrdinalFloorId,
    {
      outcome: "ALREADY_INVOICED",
      reference: "Documento Aruba FPR 0099/26 con ordinale prima del piano",
      invoiceXml: Buffer.from(
        historicalWithoutTaxIdXml
          .toString()
          .replace("FPR 0013/26", "FPR 0099/26")
          .replace("Via della Scala", "Via Roma")
          .replace("<NumeroCivico>2</NumeroCivico>", "<NumeroCivico>10</NumeroCivico>"),
      ),
      manualReviewApproved: true,
    },
    { id: 1, canApprove: true, requestId: "test-reconcile-civic-before-ordinal-floor" },
  );
  const historicalWithCardinalFloor = structuredClone(historicalWithoutTaxId);
  historicalWithCardinalFloor.externalOrderId = "shop-order-historical-cardinal-floor";
  historicalWithCardinalFloor.externalCustomerId = "shop-customer-historical-cardinal-floor";
  historicalWithCardinalFloor.displayNumber = "#S-HIST-CARDINAL-FLOOR";
  historicalWithCardinalFloor.customer.billingAddress = {
    line1: "Via Roma",
    line2: "10, 2 piano",
    postalCode: "00100",
    city: "Roma",
    province: "RM",
    countryCode: "IT",
  };
  historicalWithCardinalFloor.payments[0].externalPaymentId = "historical-cardinal-floor-payment";
  await orders.importOrders([historicalWithCardinalFloor], {
    id: 1,
    requestId: "test-import-historical-cardinal-floor",
  });
  const historicalWithCardinalFloorId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        historicalWithCardinalFloor.externalOrderId,
      ])
  ).rows[0]!.id;
  await orders.reconcileHistoricalOrder(
    historicalWithCardinalFloorId,
    {
      outcome: "ALREADY_INVOICED",
      reference: "Documento Aruba FPR 0098/26 con piano cardinale dopo il civico",
      invoiceXml: Buffer.from(
        historicalWithoutTaxIdXml
          .toString()
          .replace("FPR 0013/26", "FPR 0098/26")
          .replace("Via della Scala", "Via Roma")
          .replace("<NumeroCivico>2</NumeroCivico>", "<NumeroCivico>10</NumeroCivico>"),
      ),
      manualReviewApproved: true,
    },
    { id: 1, canApprove: true, requestId: "test-reconcile-civic-before-cardinal-floor" },
  );
  const historicalWithExplicitCivicAndFloor = structuredClone(historicalWithoutTaxId);
  historicalWithExplicitCivicAndFloor.externalOrderId =
    "shop-order-historical-explicit-civic-floor";
  historicalWithExplicitCivicAndFloor.externalCustomerId =
    "shop-customer-historical-explicit-civic-floor";
  historicalWithExplicitCivicAndFloor.displayNumber = "#S-HIST-EXPLICIT-CIVIC-FLOOR";
  historicalWithExplicitCivicAndFloor.customer.billingAddress = {
    line1: "Via Roma",
    line2: "Civico 10, 2 piano",
    postalCode: "00100",
    city: "Roma",
    province: "RM",
    countryCode: "IT",
  };
  historicalWithExplicitCivicAndFloor.payments[0].externalPaymentId =
    "historical-explicit-civic-floor-payment";
  await orders.importOrders([historicalWithExplicitCivicAndFloor], {
    id: 1,
    requestId: "test-import-historical-explicit-civic-floor",
  });
  const historicalWithExplicitCivicAndFloorId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        historicalWithExplicitCivicAndFloor.externalOrderId,
      ])
  ).rows[0]!.id;
  await orders.reconcileHistoricalOrder(
    historicalWithExplicitCivicAndFloorId,
    {
      outcome: "ALREADY_INVOICED",
      reference: "Documento Aruba FPR 0096/26 con prefisso civico e piano separato",
      invoiceXml: Buffer.from(
        historicalWithoutTaxIdXml
          .toString()
          .replace("FPR 0013/26", "FPR 0096/26")
          .replace("Via della Scala", "Via Roma")
          .replace("<NumeroCivico>2</NumeroCivico>", "<NumeroCivico>10</NumeroCivico>"),
      ),
      manualReviewApproved: true,
    },
    { id: 1, canApprove: true, requestId: "test-reconcile-explicit-civic-before-floor" },
  );
  const historicalWithExplicitCivicAndUnknownUnit = structuredClone(historicalWithoutTaxId);
  historicalWithExplicitCivicAndUnknownUnit.externalOrderId =
    "shop-order-historical-explicit-civic-unknown-unit";
  historicalWithExplicitCivicAndUnknownUnit.externalCustomerId =
    "shop-customer-historical-explicit-civic-unknown-unit";
  historicalWithExplicitCivicAndUnknownUnit.displayNumber = "#S-HIST-EXPLICIT-CIVIC-UNKNOWN-UNIT";
  historicalWithExplicitCivicAndUnknownUnit.customer.billingAddress = {
    line1: "Via Roma",
    line2: "Civico 10 int. 2",
    postalCode: "00100",
    city: "Roma",
    province: "RM",
    countryCode: "IT",
  };
  historicalWithExplicitCivicAndUnknownUnit.payments[0].externalPaymentId =
    "historical-explicit-civic-unknown-unit-payment";
  await orders.importOrders([historicalWithExplicitCivicAndUnknownUnit], {
    id: 1,
    requestId: "test-import-historical-explicit-civic-unknown-unit",
  });
  const historicalWithExplicitCivicAndUnknownUnitId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        historicalWithExplicitCivicAndUnknownUnit.externalOrderId,
      ])
  ).rows[0]!.id;
  await orders.reconcileHistoricalOrder(
    historicalWithExplicitCivicAndUnknownUnitId,
    {
      outcome: "ALREADY_INVOICED",
      reference: "Documento Aruba FPR 0095/26 con civico prima di un interno abbreviato",
      invoiceXml: Buffer.from(
        historicalWithoutTaxIdXml
          .toString()
          .replace("FPR 0013/26", "FPR 0095/26")
          .replace("Via della Scala", "Via Roma")
          .replace("<NumeroCivico>2</NumeroCivico>", "<NumeroCivico>10</NumeroCivico>"),
      ),
      manualReviewApproved: true,
    },
    { id: 1, canApprove: true, requestId: "test-reconcile-explicit-civic-unknown-unit" },
  );
  const historicalWithSeparatedUnitNumber = structuredClone(historicalWithoutTaxId);
  historicalWithSeparatedUnitNumber.externalOrderId = "shop-order-historical-separated-unit-number";
  historicalWithSeparatedUnitNumber.externalCustomerId =
    "shop-customer-historical-separated-unit-number";
  historicalWithSeparatedUnitNumber.displayNumber = "#S-HIST-SEPARATED-UNIT-NUMBER";
  historicalWithSeparatedUnitNumber.customer.billingAddress = {
    line1: "Via della Scala",
    line2: "Interno n. 2",
    postalCode: "00100",
    city: "Roma",
    province: "RM",
    countryCode: "IT",
  };
  historicalWithSeparatedUnitNumber.payments[0].externalPaymentId =
    "historical-separated-unit-number-payment";
  await orders.importOrders([historicalWithSeparatedUnitNumber], {
    id: 1,
    requestId: "test-import-historical-separated-unit-number",
  });
  const historicalWithSeparatedUnitNumberId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        historicalWithSeparatedUnitNumber.externalOrderId,
      ])
  ).rows[0]!.id;
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      historicalWithSeparatedUnitNumberId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba FPR 0039/26 senza prova del civico",
        invoiceXml: Buffer.from(
          historicalWithoutTaxIdXml.toString().replace("FPR 0013/26", "FPR 0039/26"),
        ),
        manualReviewApproved: true,
      },
      { id: 1, canApprove: true, requestId: "test-reject-separated-unit-number" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  const historicalWithUnmarkedNumericComplement = structuredClone(historicalWithoutTaxId);
  historicalWithUnmarkedNumericComplement.externalOrderId =
    "shop-order-historical-unmarked-numeric-complement";
  historicalWithUnmarkedNumericComplement.externalCustomerId =
    "shop-customer-historical-unmarked-numeric-complement";
  historicalWithUnmarkedNumericComplement.displayNumber = "#S-HIST-UNMARKED-NUMERIC-COMPLEMENT";
  historicalWithUnmarkedNumericComplement.customer.billingAddress = {
    line1: "Via Roma 10",
    line2: "Studio 54",
    postalCode: "00100",
    city: "Roma",
    province: "RM",
    countryCode: "IT",
  };
  historicalWithUnmarkedNumericComplement.payments[0].externalPaymentId =
    "historical-unmarked-numeric-complement-payment";
  await orders.importOrders([historicalWithUnmarkedNumericComplement], {
    id: 1,
    requestId: "test-import-historical-unmarked-numeric-complement",
  });
  const historicalWithUnmarkedNumericComplementId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        historicalWithUnmarkedNumericComplement.externalOrderId,
      ])
  ).rows[0]!.id;
  const historicalWithWrongUnmarkedComplementXml = Buffer.from(
    historicalWithoutTaxIdXml
      .toString()
      .replace("FPR 0013/26", "FPR 0041/26")
      .replace("Via della Scala", "Via Roma")
      .replace("<NumeroCivico>2</NumeroCivico>", "<NumeroCivico>54</NumeroCivico>"),
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      historicalWithUnmarkedNumericComplementId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba FPR 0041/26 con complemento scambiato per civico",
        invoiceXml: historicalWithWrongUnmarkedComplementXml,
        manualReviewApproved: true,
      },
      { id: 1, canApprove: true, requestId: "test-reject-unmarked-complement-as-civic" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await orders.reconcileHistoricalOrder(
    historicalWithUnmarkedNumericComplementId,
    {
      outcome: "ALREADY_INVOICED",
      reference: "Documento Aruba FPR 0042/26 con civico della prima riga",
      invoiceXml: Buffer.from(
        historicalWithWrongUnmarkedComplementXml
          .toString()
          .replace("FPR 0041/26", "FPR 0042/26")
          .replace("<NumeroCivico>54</NumeroCivico>", "<NumeroCivico>10</NumeroCivico>"),
      ),
      manualReviewApproved: true,
    },
    { id: 1, canApprove: true, requestId: "test-reconcile-primary-civic" },
  );
  const historicalWithUnmarkedAlphanumericUnit = structuredClone(historicalWithoutTaxId);
  historicalWithUnmarkedAlphanumericUnit.externalOrderId =
    "shop-order-historical-unmarked-alphanumeric-unit";
  historicalWithUnmarkedAlphanumericUnit.externalCustomerId =
    "shop-customer-historical-unmarked-alphanumeric-unit";
  historicalWithUnmarkedAlphanumericUnit.displayNumber = "#S-HIST-UNMARKED-ALPHANUMERIC-UNIT";
  historicalWithUnmarkedAlphanumericUnit.customer.billingAddress = {
    line1: "Via Roma 10",
    line2: "1A",
    postalCode: "00100",
    city: "Roma",
    province: "RM",
    countryCode: "IT",
  };
  historicalWithUnmarkedAlphanumericUnit.payments[0].externalPaymentId =
    "historical-unmarked-alphanumeric-unit-payment";
  await orders.importOrders([historicalWithUnmarkedAlphanumericUnit], {
    id: 1,
    requestId: "test-import-historical-unmarked-alphanumeric-unit",
  });
  const historicalWithUnmarkedAlphanumericUnitId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        historicalWithUnmarkedAlphanumericUnit.externalOrderId,
      ])
  ).rows[0]!.id;
  const historicalWithWrongAlphanumericUnitXml = Buffer.from(
    historicalWithoutTaxIdXml
      .toString()
      .replace("FPR 0013/26", "FPR 0043/26")
      .replace("Via della Scala", "Via Roma")
      .replace("<NumeroCivico>2</NumeroCivico>", "<NumeroCivico>1A</NumeroCivico>"),
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      historicalWithUnmarkedAlphanumericUnitId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba FPR 0043/26 con unità scambiata per civico",
        invoiceXml: historicalWithWrongAlphanumericUnitXml,
        manualReviewApproved: true,
      },
      { id: 1, canApprove: true, requestId: "test-reject-alphanumeric-unit-as-civic" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await orders.reconcileHistoricalOrder(
    historicalWithUnmarkedAlphanumericUnitId,
    {
      outcome: "ALREADY_INVOICED",
      reference: "Documento Aruba FPR 0044/26 con civico primario e unità separata",
      invoiceXml: Buffer.from(
        historicalWithWrongAlphanumericUnitXml
          .toString()
          .replace("FPR 0043/26", "FPR 0044/26")
          .replace("<NumeroCivico>1A</NumeroCivico>", "<NumeroCivico>10</NumeroCivico>"),
      ),
      manualReviewApproved: true,
    },
    { id: 1, canApprove: true, requestId: "test-reconcile-primary-civic-before-unit" },
  );
  const historicalWithNumberedStreetAndCivic = structuredClone(historicalWithoutTaxId);
  historicalWithNumberedStreetAndCivic.externalOrderId =
    "shop-order-historical-numbered-street-and-civic";
  historicalWithNumberedStreetAndCivic.externalCustomerId =
    "shop-customer-historical-numbered-street-and-civic";
  historicalWithNumberedStreetAndCivic.displayNumber = "#S-HIST-NUMBERED-STREET-AND-CIVIC";
  historicalWithNumberedStreetAndCivic.customer.billingAddress = {
    line1: "Strada Provinciale 12 10",
    line2: "1A",
    postalCode: "00100",
    city: "Roma",
    province: "RM",
    countryCode: "IT",
  };
  historicalWithNumberedStreetAndCivic.payments[0].externalPaymentId =
    "historical-numbered-street-and-civic-payment";
  await orders.importOrders([historicalWithNumberedStreetAndCivic], {
    id: 1,
    requestId: "test-import-historical-numbered-street-and-civic",
  });
  const historicalWithNumberedStreetAndCivicId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        historicalWithNumberedStreetAndCivic.externalOrderId,
      ])
  ).rows[0]!.id;
  const historicalWithWrongNumberedStreetUnitXml = Buffer.from(
    historicalWithoutTaxIdXml
      .toString()
      .replace("FPR 0013/26", "FPR 0045/26")
      .replace("Via della Scala", "Strada Provinciale 12")
      .replace("<NumeroCivico>2</NumeroCivico>", "<NumeroCivico>1A</NumeroCivico>"),
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      historicalWithNumberedStreetAndCivicId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba FPR 0045/26 con unità al posto del civico",
        invoiceXml: historicalWithWrongNumberedStreetUnitXml,
        manualReviewApproved: true,
      },
      { id: 1, canApprove: true, requestId: "test-reject-unit-after-numbered-street" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await orders.reconcileHistoricalOrder(
    historicalWithNumberedStreetAndCivicId,
    {
      outcome: "ALREADY_INVOICED",
      reference: "Documento Aruba FPR 0046/26 con toponimo numerato e civico",
      invoiceXml: Buffer.from(
        historicalWithWrongNumberedStreetUnitXml
          .toString()
          .replace("FPR 0045/26", "FPR 0046/26")
          .replace("<NumeroCivico>1A</NumeroCivico>", "<NumeroCivico>10</NumeroCivico>"),
      ),
      manualReviewApproved: true,
    },
    { id: 1, canApprove: true, requestId: "test-reconcile-numbered-street-civic" },
  );
  const historicalWithNumberedStreet = structuredClone(historicalWithoutTaxId);
  historicalWithNumberedStreet.externalOrderId = "shop-order-historical-numbered-street";
  historicalWithNumberedStreet.externalCustomerId = "shop-customer-historical-numbered-street";
  historicalWithNumberedStreet.displayNumber = "#S-HIST-NUMBERED-STREET";
  historicalWithNumberedStreet.customer.billingAddress = {
    line1: "Strada Provinciale 12",
    line2: "2",
    postalCode: "00100",
    city: "Roma",
    province: "RM",
    countryCode: "IT",
  };
  historicalWithNumberedStreet.payments[0].externalPaymentId = "historical-numbered-street-payment";
  await orders.importOrders([historicalWithNumberedStreet], {
    id: 1,
    requestId: "test-import-historical-numbered-street",
  });
  const historicalWithNumberedStreetId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        historicalWithNumberedStreet.externalOrderId,
      ])
  ).rows[0]!.id;
  await orders.reconcileHistoricalOrder(
    historicalWithNumberedStreetId,
    {
      outcome: "ALREADY_INVOICED",
      reference: "Documento Aruba FPR 0036/26 con civico separato dal toponimo numerato",
      invoiceXml: Buffer.from(
        historicalWithoutTaxIdXml
          .toString()
          .replace("FPR 0013/26", "FPR 0036/26")
          .replace("Via della Scala", "Strada Provinciale 12"),
      ),
      manualReviewApproved: true,
    },
    { id: 1, canApprove: true, requestId: "test-reconcile-numbered-street" },
  );
  const historicalWithForeignNumberedStreet = structuredClone(historicalWithoutTaxId);
  historicalWithForeignNumberedStreet.externalOrderId =
    "shop-order-historical-foreign-numbered-street";
  historicalWithForeignNumberedStreet.externalCustomerId =
    "shop-customer-historical-foreign-numbered-street";
  historicalWithForeignNumberedStreet.displayNumber = "#S-HIST-FR-NUMBERED-STREET";
  historicalWithForeignNumberedStreet.customer.billingAddress = {
    line1: "75001 Route Nationale 12",
    line2: "5",
    postalCode: "75001",
    city: "Paris",
    countryCode: "FR",
  };
  historicalWithForeignNumberedStreet.payments[0].externalPaymentId =
    "historical-foreign-numbered-street-payment";
  await orders.importOrders([historicalWithForeignNumberedStreet], {
    id: 1,
    requestId: "test-import-historical-foreign-numbered-street",
  });
  const historicalWithForeignNumberedStreetId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        historicalWithForeignNumberedStreet.externalOrderId,
      ])
  ).rows[0]!.id;
  await orders.reconcileHistoricalOrder(
    historicalWithForeignNumberedStreetId,
    {
      outcome: "ALREADY_INVOICED",
      reference: "Documento Aruba FPR 0048/26 con toponimo UE numerato e civico separato",
      invoiceXml: Buffer.from(
        historicalWithoutTaxIdXml
          .toString()
          .replace("FPR 0013/26", "FPR 0048/26")
          .replace("Via della Scala", "Route Nationale 12")
          .replace("<NumeroCivico>2</NumeroCivico>", "<NumeroCivico>5</NumeroCivico>")
          .replace("<CAP>00100</CAP>", "<CAP>75001</CAP>")
          .replace("<Comune>Roma</Comune>", "<Comune>Paris</Comune>")
          .replace(
            "<Provincia>RM</Provincia>\n        <Nazione>IT</Nazione>",
            "<Nazione>FR</Nazione>",
          ),
      ),
      manualReviewApproved: true,
    },
    { id: 1, canApprove: true, requestId: "test-reconcile-foreign-numbered-street" },
  );
  const historicalWithEnglishNumberedStreet = structuredClone(historicalWithoutTaxId);
  historicalWithEnglishNumberedStreet.externalOrderId =
    "shop-order-historical-english-numbered-street";
  historicalWithEnglishNumberedStreet.externalCustomerId =
    "shop-customer-historical-english-numbered-street";
  historicalWithEnglishNumberedStreet.displayNumber = "#S-HIST-EN-NUMBERED-STREET";
  historicalWithEnglishNumberedStreet.customer.billingAddress = {
    line1: "National Road N 7",
    line2: "5",
    postalCode: "10001",
    city: "Athens",
    countryCode: "GR",
  };
  historicalWithEnglishNumberedStreet.payments[0].externalPaymentId =
    "historical-english-numbered-street-payment";
  await orders.importOrders([historicalWithEnglishNumberedStreet], {
    id: 1,
    requestId: "test-import-historical-english-numbered-street",
  });
  const historicalWithEnglishNumberedStreetId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        historicalWithEnglishNumberedStreet.externalOrderId,
      ])
  ).rows[0]!.id;
  await orders.reconcileHistoricalOrder(
    historicalWithEnglishNumberedStreetId,
    {
      outcome: "ALREADY_INVOICED",
      reference: "Documento Aruba FPR 0097/26 con qualificatore prima del tipo di strada",
      invoiceXml: Buffer.from(
        historicalWithoutTaxIdXml
          .toString()
          .replace("FPR 0013/26", "FPR 0097/26")
          .replace("Via della Scala", "National Road N 7")
          .replace("<NumeroCivico>2</NumeroCivico>", "<NumeroCivico>5</NumeroCivico>")
          .replace("<CAP>00100</CAP>", "<CAP>10001</CAP>")
          .replace("<Comune>Roma</Comune>", "<Comune>Athens</Comune>")
          .replace(
            "<Provincia>RM</Provincia>\n        <Nazione>IT</Nazione>",
            "<Nazione>GR</Nazione>",
          ),
      ),
      manualReviewApproved: true,
    },
    { id: 1, canApprove: true, requestId: "test-reconcile-english-numbered-street" },
  );
  const historicalWithAbbreviatedNumberedStreet = structuredClone(historicalWithoutTaxId);
  historicalWithAbbreviatedNumberedStreet.externalOrderId =
    "shop-order-historical-abbreviated-numbered-street";
  historicalWithAbbreviatedNumberedStreet.externalCustomerId =
    "shop-customer-historical-abbreviated-numbered-street";
  historicalWithAbbreviatedNumberedStreet.displayNumber = "#S-HIST-ABBREVIATED-STREET";
  historicalWithAbbreviatedNumberedStreet.customer.billingAddress = {
    line1: "SP 12",
    line2: "5",
    postalCode: "00100",
    city: "Roma",
    province: "RM",
    countryCode: "IT",
  };
  historicalWithAbbreviatedNumberedStreet.payments[0].externalPaymentId =
    "historical-abbreviated-numbered-street-payment";
  await orders.importOrders([historicalWithAbbreviatedNumberedStreet], {
    id: 1,
    requestId: "test-import-historical-abbreviated-numbered-street",
  });
  const historicalWithAbbreviatedNumberedStreetId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        historicalWithAbbreviatedNumberedStreet.externalOrderId,
      ])
  ).rows[0]!.id;
  await orders.reconcileHistoricalOrder(
    historicalWithAbbreviatedNumberedStreetId,
    {
      outcome: "ALREADY_INVOICED",
      reference: "Documento Aruba FPR 0094/26 con sigla stradale numerata",
      invoiceXml: Buffer.from(
        historicalWithoutTaxIdXml
          .toString()
          .replace("FPR 0013/26", "FPR 0094/26")
          .replace("Via della Scala", "SP 12")
          .replace("<NumeroCivico>2</NumeroCivico>", "<NumeroCivico>5</NumeroCivico>"),
      ),
      manualReviewApproved: true,
    },
    { id: 1, canApprove: true, requestId: "test-reconcile-abbreviated-numbered-street" },
  );
  const historicalWithCommemorativeStreet = structuredClone(historicalWithoutTaxId);
  historicalWithCommemorativeStreet.externalOrderId = "shop-order-historical-commemorative-street";
  historicalWithCommemorativeStreet.externalCustomerId =
    "shop-customer-historical-commemorative-street";
  historicalWithCommemorativeStreet.displayNumber = "#S-HIST-FR-COMMEMORATIVE-STREET";
  historicalWithCommemorativeStreet.customer.billingAddress = {
    line1: "Rue du 8 Mai 1945",
    line2: "5",
    postalCode: "75001",
    city: "Paris",
    countryCode: "FR",
  };
  historicalWithCommemorativeStreet.payments[0].externalPaymentId =
    "historical-commemorative-street-payment";
  await orders.importOrders([historicalWithCommemorativeStreet], {
    id: 1,
    requestId: "test-import-historical-commemorative-street",
  });
  const historicalWithCommemorativeStreetId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        historicalWithCommemorativeStreet.externalOrderId,
      ])
  ).rows[0]!.id;
  await orders.reconcileHistoricalOrder(
    historicalWithCommemorativeStreetId,
    {
      outcome: "ALREADY_INVOICED",
      reference: "Documento Aruba FPR 0049/26 con toponimo commemorativo e civico separato",
      invoiceXml: Buffer.from(
        historicalWithoutTaxIdXml
          .toString()
          .replace("FPR 0013/26", "FPR 0049/26")
          .replace("Via della Scala", "Rue du 8 Mai 1945")
          .replace("<NumeroCivico>2</NumeroCivico>", "<NumeroCivico>5</NumeroCivico>")
          .replace("<CAP>00100</CAP>", "<CAP>75001</CAP>")
          .replace("<Comune>Roma</Comune>", "<Comune>Paris</Comune>")
          .replace(
            "<Provincia>RM</Provincia>\n        <Nazione>IT</Nazione>",
            "<Nazione>FR</Nazione>",
          ),
      ),
      manualReviewApproved: true,
    },
    { id: 1, canApprove: true, requestId: "test-reconcile-commemorative-street" },
  );
  const historicalWithCivicBeforeCommemorativeStreet = structuredClone(historicalWithoutTaxId);
  historicalWithCivicBeforeCommemorativeStreet.externalOrderId =
    "shop-order-historical-civic-before-commemorative-street";
  historicalWithCivicBeforeCommemorativeStreet.externalCustomerId =
    "shop-customer-historical-civic-before-commemorative-street";
  historicalWithCivicBeforeCommemorativeStreet.displayNumber =
    "#S-HIST-CIVIC-BEFORE-COMMEMORATIVE-STREET";
  historicalWithCivicBeforeCommemorativeStreet.customer.billingAddress = {
    line1: "10 Rue des Anciens Combattants du 8 Mai 1945",
    line2: "5",
    postalCode: "75001",
    city: "Paris",
    countryCode: "FR",
  };
  historicalWithCivicBeforeCommemorativeStreet.payments[0].externalPaymentId =
    "historical-civic-before-commemorative-street-payment";
  await orders.importOrders([historicalWithCivicBeforeCommemorativeStreet], {
    id: 1,
    requestId: "test-import-historical-civic-before-commemorative-street",
  });
  const historicalWithCivicBeforeCommemorativeStreetId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        historicalWithCivicBeforeCommemorativeStreet.externalOrderId,
      ])
  ).rows[0]!.id;
  await orders.reconcileHistoricalOrder(
    historicalWithCivicBeforeCommemorativeStreetId,
    {
      outcome: "ALREADY_INVOICED",
      reference: "Documento Aruba FPR 0093/26 con civico prima della via commemorativa",
      invoiceXml: Buffer.from(
        historicalWithoutTaxIdXml
          .toString()
          .replace("FPR 0013/26", "FPR 0093/26")
          .replace("Via della Scala", "Rue des Anciens Combattants du 8 Mai 1945")
          .replace("<NumeroCivico>2</NumeroCivico>", "<NumeroCivico>10</NumeroCivico>")
          .replace("<CAP>00100</CAP>", "<CAP>75001</CAP>")
          .replace("<Comune>Roma</Comune>", "<Comune>Paris</Comune>")
          .replace(
            "<Provincia>RM</Provincia>\n        <Nazione>IT</Nazione>",
            "<Nazione>FR</Nazione>",
          ),
      ),
      manualReviewApproved: true,
    },
    { id: 1, canApprove: true, requestId: "test-reconcile-civic-before-commemorative-street" },
  );
  const historicalWithConflictingExplicitCivic = structuredClone(historicalWithoutTaxId);
  historicalWithConflictingExplicitCivic.externalOrderId =
    "shop-order-historical-conflicting-explicit-civic";
  historicalWithConflictingExplicitCivic.externalCustomerId =
    "shop-customer-historical-conflicting-explicit-civic";
  historicalWithConflictingExplicitCivic.displayNumber = "#S-HIST-CONFLICTING-EXPLICIT-CIVIC";
  historicalWithConflictingExplicitCivic.customer.billingAddress = {
    line1: "Via Roma 10",
    line2: "Civico 2",
    postalCode: "00100",
    city: "Roma",
    province: "RM",
    countryCode: "IT",
  };
  historicalWithConflictingExplicitCivic.payments[0].externalPaymentId =
    "historical-conflicting-explicit-civic-payment";
  await orders.importOrders([historicalWithConflictingExplicitCivic], {
    id: 1,
    requestId: "test-import-historical-conflicting-explicit-civic",
  });
  const historicalWithConflictingExplicitCivicId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        historicalWithConflictingExplicitCivic.externalOrderId,
      ])
  ).rows[0]!.id;
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      historicalWithConflictingExplicitCivicId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba FPR 0050/26 con civici espliciti discordanti",
        invoiceXml: Buffer.from(
          historicalWithoutTaxIdXml
            .toString()
            .replace("FPR 0013/26", "FPR 0050/26")
            .replace("Via della Scala", "Via Roma"),
        ),
        manualReviewApproved: true,
      },
      { id: 1, canApprove: true, requestId: "test-reject-conflicting-explicit-civic" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  const bulgarianHistorical = structuredClone(historicalWithoutTaxId);
  bulgarianHistorical.externalOrderId = "shop-order-historical-bulgarian-transliteration";
  bulgarianHistorical.externalCustomerId = "shop-customer-historical-bulgarian-transliteration";
  bulgarianHistorical.displayNumber = "#S-HIST-BG";
  bulgarianHistorical.customer.kind = "EU";
  bulgarianHistorical.customer.firstName = "Валентин";
  bulgarianHistorical.customer.lastName = "Радев";
  bulgarianHistorical.customer.companyName = "ЕТ Валмерад-Валентин Радев";
  bulgarianHistorical.customer.billingAddress = {
    line1: "ул. Пчела",
    line2: "3-Б",
    postalCode: "1619",
    city: "София",
    countryCode: "BG",
  };
  bulgarianHistorical.total = "195.68";
  bulgarianHistorical.lines[0].grossAmount = "195.68";
  bulgarianHistorical.payments[0].amount = "195.68";
  bulgarianHistorical.payments[0].method = "shopify_payments";
  bulgarianHistorical.payments[0].shopifyPaymentsFeeAmount = "3.97";
  bulgarianHistorical.payments[0].externalPaymentId = "historical-bulgarian-payment";
  await orders.importOrders([bulgarianHistorical], {
    id: 1,
    requestId: "test-import-historical-bulgarian-transliteration",
  });
  const bulgarianHistoricalId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        bulgarianHistorical.externalOrderId,
      ])
  ).rows[0]!.id;
  await orders.reconcileHistoricalOrder(
    bulgarianHistoricalId,
    {
      outcome: "ALREADY_INVOICED",
      reference: "Documento Aruba FPR 0034/26 verificato fra cirillico e alfabeto latino",
      invoiceXml: Buffer.from(
        historicalWithoutTaxIdXml
          .toString()
          .replace("FPR 0013/26", "FPR 0034/26")
          .replaceAll("122.00", "191.71")
          .replace("<Nome>MARIO</Nome>", "<Nome>VALENTIN</Nome>")
          .replace("<Cognome>ROSSI</Cognome>", "<Cognome>RADEV</Cognome>")
          .replace(
            "<CodiceFiscale>RSSMRA80A01H501U</CodiceFiscale>\n        <Anagrafica>\n          <Nome>VALENTIN</Nome>",
            "<IdFiscaleIVA>\n          <IdPaese>BG</IdPaese>\n          <IdCodice>99999999999</IdCodice>\n        </IdFiscaleIVA>\n        <Anagrafica>\n          <Nome>VALENTIN</Nome>",
          )
          .replace(
            "<Indirizzo>Via della Scala</Indirizzo><NumeroCivico>2</NumeroCivico>",
            "<Indirizzo>1618 PCHELA</Indirizzo><NumeroCivico>3B</NumeroCivico>",
          )
          .replace("<CAP>00100</CAP>", "<CAP>00000</CAP>")
          .replace("<Comune>Roma</Comune>", "<Comune>SOFIA</Comune>")
          .replace(
            "<Provincia>RM</Provincia>\n        <Nazione>IT</Nazione>",
            "<Nazione>BG</Nazione>",
          ),
      ),
      manualReviewApproved: true,
    },
    { id: 1, canApprove: true, requestId: "test-reconcile-bulgarian-transliteration" },
  );
  const historicalWithDifferentTaxIdType = structuredClone(historical);
  historicalWithDifferentTaxIdType.externalOrderId = "shop-order-historical-tax-id-type";
  historicalWithDifferentTaxIdType.externalCustomerId = "shop-customer-historical-tax-id-type";
  historicalWithDifferentTaxIdType.displayNumber = "#S-HIST-TAX-ID-TYPE";
  historicalWithDifferentTaxIdType.customer.kind = "BUSINESS_IT";
  historicalWithDifferentTaxIdType.customer.companyName = "Cliente Esempio Srl";
  historicalWithDifferentTaxIdType.customer.taxIdentifiers = [
    {
      type: "PARTITA_IVA",
      value: "10987654321",
      countryCode: "IT",
      sourceField: "test",
    },
  ];
  historicalWithDifferentTaxIdType.historical = true;
  historicalWithDifferentTaxIdType.updatedAt = "2026-08-19T09:59:00Z";
  historicalWithDifferentTaxIdType.payments[0].externalPaymentId = "historical-tax-id-type-payment";
  await orders.importOrders([historicalWithDifferentTaxIdType], {
    id: 1,
    requestId: "test-import-historical-tax-id-type",
  });
  const historicalWithDifferentTaxIdTypeId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        historicalWithDifferentTaxIdType.externalOrderId,
      ])
  ).rows[0]!.id;
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      historicalWithDifferentTaxIdTypeId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Identificativo uguale ma tipo fiscale differente",
        invoiceXml: Buffer.from(
          (await readFile("tests/fixtures/fatturapa/accepted-invoice.anonymized.xml", "utf8"))
            .replace("FPR 0001/26", "FPR 0014/26")
            .replace("#1001", historicalWithDifferentTaxIdType.displayNumber)
            .replace("<Data>2026-08-10</Data>", "<Data>2026-08-19</Data>")
            .replace("RSSMRA80A01H501U", "10987654321")
            .replaceAll("123.45", "122.00"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reconcile-tax-id-type-mismatch" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      historicalWithDifferentTaxIdTypeId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Partita IVA uguale ma paese fiscale differente",
        invoiceXml: Buffer.from(
          (await readFile("tests/fixtures/fatturapa/accepted-invoice.anonymized.xml", "utf8"))
            .replace("FPR 0001/26", "FPR 0015/26")
            .replace("#1001", historicalWithDifferentTaxIdType.displayNumber)
            .replace("<Data>2026-08-10</Data>", "<Data>2026-08-19</Data>")
            .replace(
              "<CodiceFiscale>",
              "<IdFiscaleIVA><IdPaese>DE</IdPaese><IdCodice>10987654321</IdCodice></IdFiscaleIVA><CodiceFiscale>",
            )
            .replaceAll("123.45", "122.00"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reconcile-tax-id-country-mismatch" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  alreadyInvoiced.updatedAt = "2026-08-19T10:00:00Z";
  alreadyInvoiced.historical = false;
  await orders.importOrders([alreadyInvoiced], {
    id: 1,
    requestId: "test-reimport-historical-invoiced",
  });
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT trigger_status, billing_case_id, historical_reconciliation_outcome,
                  normalized_snapshot_json ->> 'historical' AS historical
           FROM orders WHERE id = $1`,
        [alreadyInvoicedId],
      )
    ).rows[0],
    {
      trigger_status: "INVOICED",
      billing_case_id: null,
      historical_reconciliation_outcome: "ALREADY_INVOICED",
      historical: "true",
    },
  );
  alreadyInvoiced.updatedAt = "2026-08-19T10:30:00Z";
  alreadyInvoiced.refunds.push({
    externalRefundId: "historical-invoiced-total-refund",
    status: "COMPLETED",
    amount: alreadyInvoiced.total,
    completedAt: "2026-08-19T10:30:00Z",
    raw: {},
  });
  await orders.importOrders([alreadyInvoiced], {
    id: 1,
    requestId: "test-refund-reimported-historical-invoiced",
  });
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT orders.trigger_status, orders.billing_case_id,
                  orders.historical_reconciliation_outcome,
                  refunds.id AS refund_id, refunds.applied_before_issue,
                  (SELECT count(*)::int FROM jobs
                   WHERE type = 'process_refund'
                     AND payload_json ->> 'refundId' = refunds.id::text) AS jobs
           FROM orders JOIN refunds ON refunds.order_id = orders.id
           WHERE orders.id = $1
             AND refunds.external_refund_id = 'historical-invoiced-total-refund'`,
        [alreadyInvoicedId],
      )
    ).rows[0],
    {
      trigger_status: "INVOICED",
      billing_case_id: null,
      historical_reconciliation_outcome: "ALREADY_INVOICED",
      refund_id: (
        await database
          .getPool()
          .query(
            "SELECT id FROM refunds WHERE external_refund_id = 'historical-invoiced-total-refund'",
          )
      ).rows[0].id,
      applied_before_issue: false,
      jobs: 1,
    },
  );
  const historicalInvoicedRefundId = (
    await database
      .getPool()
      .query("SELECT id FROM refunds WHERE external_refund_id = 'historical-invoiced-total-refund'")
  ).rows[0].id;
  await assert.rejects(
    refunds.processRefund(historicalInvoicedRefundId),
    (error: unknown) => error instanceof AppError && error.code === "CREDIT_NOTE_LIMIT_EXCEEDED",
  );
  assert.equal(
    (
      await database.getPool().query(
        `SELECT count(*)::int AS count FROM audit_events
           WHERE action = 'REFUND_NEEDS_REVIEW' AND entity_type = 'REFUND' AND entity_id = $1`,
        [historicalInvoicedRefundId],
      )
    ).rows[0].count,
    0,
  );
  await assert.rejects(
    orders.forcePrepareOrder(alreadyInvoicedId, {
      id: 1,
      requestId: "test-force-reimported-historical",
    }),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_NOT_PREPARABLE",
  );
  assert.equal(
    (
      await database
        .getPool()
        .query("SELECT count(*) FROM audit_events WHERE action = 'ORDER_HISTORY_RECONCILED'")
    ).rows[0].count,
    "40",
  );
}
