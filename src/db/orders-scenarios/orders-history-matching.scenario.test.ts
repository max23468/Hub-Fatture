import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { AppError } from "../../errors.ts";
import type { OrdersTestContext } from "./orders-test-support.test.ts";

import type { PaymentsCoreState } from "./orders-payments-core.scenario.test.ts";

export async function runHistoricalMatchingScenario(
  context: OrdersTestContext,
  core: PaymentsCoreState,
) {
  const { orders, database, fixture } = context;
  const { historical } = core;
  const shopifyWithoutReference = structuredClone(historical);
  shopifyWithoutReference.externalOrderId = "shop-order-historical-without-reference";
  shopifyWithoutReference.displayNumber = "#S-HIST-NO-REF";
  shopifyWithoutReference.customer.taxIdentifiers[0].value = "RSSMRA80A01H501U";
  shopifyWithoutReference.historical = true;
  shopifyWithoutReference.createdAt = "2026-08-18T08:00:00Z";
  shopifyWithoutReference.updatedAt = "2026-08-18T09:00:00Z";
  shopifyWithoutReference.payments[0].externalPaymentId =
    "shop-payment-historical-without-reference";
  shopifyWithoutReference.payments[0].method = "shopify_payments";
  shopifyWithoutReference.payments[0].shopifyPaymentsFeeAmount = "2.00";
  shopifyWithoutReference.lines[0].externalLineId = "shop-line-historical-without-reference";
  shopifyWithoutReference.refunds = [];
  await orders.importOrders([shopifyWithoutReference], {
    id: 1,
    requestId: "test-import-shopify-history-without-reference",
  });
  const shopifyWithoutReferenceId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        shopifyWithoutReference.externalOrderId,
      ])
  ).rows[0]!.id;
  const shopifyInvoiceWithoutReference = Buffer.from(
    (await readFile("tests/fixtures/fatturapa/accepted-invoice.anonymized.xml", "utf8"))
      .replace("FPR 0001/26", "FPR 0030/26")
      .replace("Vendita beni usati - Ordine Shopify #1001", "Vendita beni usati")
      .replace("<Data>2026-08-10</Data>", "<Data>2026-08-19</Data>")
      .replaceAll("123.45", "120.00"),
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      shopifyWithoutReferenceId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba al lordo della commissione Shopify Payments",
        invoiceXml: Buffer.from(
          shopifyInvoiceWithoutReference.toString().replaceAll("120.00", "122.00"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reconcile-shopify-history-gross-amount" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      shopifyWithoutReferenceId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba riferito a un altro ordine Shopify",
        invoiceXml: Buffer.from(
          shopifyInvoiceWithoutReference
            .toString()
            .replace("Vendita beni usati", "Vendita beni usati - Ordine #1002 Shopify"),
        ),
      },
      {
        id: 1,
        canApprove: true,
        requestId: "test-reconcile-shopify-history-reference-before-provider",
      },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      shopifyWithoutReferenceId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba con riferimento Shopify distante",
        invoiceXml: Buffer.from(
          shopifyInvoiceWithoutReference
            .toString()
            .replace(
              "Vendita beni usati",
              `Ordine #1002 ${"descrizione estesa ".repeat(8)}Shopify`,
            ),
        ),
      },
      {
        id: 1,
        canApprove: true,
        requestId: "test-reconcile-shopify-history-distant-reference",
      },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      shopifyWithoutReferenceId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba con riferimento Shopify distribuito",
        invoiceXml: Buffer.from(
          shopifyInvoiceWithoutReference
            .toString()
            .replace(
              "<ImportoTotaleDocumento>120.00</ImportoTotaleDocumento>",
              "<ImportoTotaleDocumento>120.00</ImportoTotaleDocumento>" +
                "<Causale>Ordine #1002</Causale><Causale>Shopify</Causale>",
            ),
        ),
      },
      {
        id: 1,
        canApprove: true,
        requestId: "test-reconcile-shopify-history-split-reference",
      },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      shopifyWithoutReferenceId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba con riferimento a un altro ordine senza marketplace",
        invoiceXml: Buffer.from(
          shopifyInvoiceWithoutReference
            .toString()
            .replace("Vendita beni usati", "Vendita beni usati - Ordine #1002"),
        ),
      },
      {
        id: 1,
        canApprove: true,
        requestId: "test-reconcile-shopify-history-bare-conflicting-reference",
      },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      shopifyWithoutReferenceId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba con riferimento numerico a un altro ordine",
        invoiceXml: Buffer.from(
          shopifyInvoiceWithoutReference
            .toString()
            .replace("Vendita beni usati", "Vendita beni usati - #1002"),
        ),
      },
      {
        id: 1,
        canApprove: true,
        requestId: "test-reconcile-shopify-history-hash-conflicting-reference",
      },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      shopifyWithoutReferenceId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba con riferimento numerico eBay privo di marker",
        invoiceXml: Buffer.from(
          shopifyInvoiceWithoutReference
            .toString()
            .replace("Vendita beni usati", "Vendita beni usati - 26-12345-67890"),
        ),
      },
      {
        id: 1,
        canApprove: true,
        requestId: "test-reconcile-shopify-history-ebay-number-reference",
      },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await orders.reconcileHistoricalOrder(
    shopifyWithoutReferenceId,
    {
      outcome: "ALREADY_INVOICED",
      reference: "Documento Aruba univoco sul totale fatturabile Shopify Payments",
      invoiceXml: shopifyInvoiceWithoutReference,
    },
    { id: 1, canApprove: true, requestId: "test-reconcile-shopify-history-without-reference" },
  );
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT document_orders.amount, documents.origin
           FROM document_orders
           JOIN documents ON documents.id = document_orders.document_id
           WHERE document_orders.order_id = $1`,
        [shopifyWithoutReferenceId],
      )
    ).rows[0],
    { amount: 12_000, origin: "ARUBA_HISTORY" },
  );
  const ambiguousShopifyFirst = structuredClone(shopifyWithoutReference);
  ambiguousShopifyFirst.externalOrderId = "shop-order-historical-ambiguous-first";
  ambiguousShopifyFirst.displayNumber = "#S-HIST-AMB-1";
  ambiguousShopifyFirst.total = "91.00";
  ambiguousShopifyFirst.payments[0].externalPaymentId = "shop-payment-historical-ambiguous-first";
  ambiguousShopifyFirst.payments[0].amount = "91.00";
  delete ambiguousShopifyFirst.payments[0].shopifyPaymentsFeeAmount;
  ambiguousShopifyFirst.lines[0].externalLineId = "shop-line-historical-ambiguous-first";
  ambiguousShopifyFirst.lines[0].grossAmount = "91.00";
  const ambiguousShopifySecond = structuredClone(ambiguousShopifyFirst);
  ambiguousShopifySecond.externalOrderId = "shop-order-historical-ambiguous-second";
  ambiguousShopifySecond.displayNumber = "#S-HIST-AMB-2";
  ambiguousShopifySecond.updatedAt = "2026-08-18T09:15:00Z";
  ambiguousShopifySecond.payments[0].externalPaymentId = "shop-payment-historical-ambiguous-second";
  ambiguousShopifySecond.lines[0].externalLineId = "shop-line-historical-ambiguous-second";
  await orders.importOrders([ambiguousShopifyFirst, ambiguousShopifySecond], {
    id: 1,
    requestId: "test-import-shopify-history-ambiguous-without-reference",
  });
  const ambiguousShopifyIds = (
    await database.getPool().query<{ id: string; external_order_id: string }>(
      `SELECT id, external_order_id FROM orders
         WHERE external_order_id IN ($1, $2)`,
      [ambiguousShopifyFirst.externalOrderId, ambiguousShopifySecond.externalOrderId],
    )
  ).rows;
  const ambiguousShopifyFirstId = ambiguousShopifyIds.find(
    (order) => order.external_order_id === ambiguousShopifyFirst.externalOrderId,
  )!.id;
  const ambiguousShopifySecondId = ambiguousShopifyIds.find(
    (order) => order.external_order_id === ambiguousShopifySecond.externalOrderId,
  )!.id;
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      ambiguousShopifyFirstId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba ambiguo fra due ordini Shopify",
        invoiceXml: Buffer.from(
          shopifyInvoiceWithoutReference
            .toString()
            .replace("FPR 0030/26", "FPR 0031/26")
            .replaceAll("120.00", "91.00"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reconcile-shopify-history-ambiguous" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await orders.reconcileHistoricalOrder(
    ambiguousShopifySecondId,
    {
      outcome: "NOT_INVOICED",
      reference: "Ordine duplicato di prova escluso dopo il confronto Aruba",
    },
    { id: 1, canApprove: true, requestId: "test-clear-shopify-history-ambiguous" },
  );
  const ebayWithoutReference = structuredClone(fixture[1]);
  ebayWithoutReference.externalOrderId = "ebay-order-historical-without-reference";
  ebayWithoutReference.externalCustomerId = "ebay-customer-historical-without-reference";
  ebayWithoutReference.displayNumber = "26-12345-67890";
  ebayWithoutReference.customer.taxIdentifiers = [];
  delete ebayWithoutReference.customer.firstName;
  delete ebayWithoutReference.customer.lastName;
  ebayWithoutReference.customer.displayName = "Mario Rossi";
  ebayWithoutReference.customer.billingAddress = {
    line1: "Via Cliente 2",
    postalCode: "00100",
    city: "Roma",
    province: "RM",
    countryCode: "IT",
  };
  ebayWithoutReference.historical = true;
  ebayWithoutReference.createdAt = "2026-08-18T08:00:00Z";
  ebayWithoutReference.updatedAt = "2026-08-18T09:00:00Z";
  ebayWithoutReference.refunds = [];
  ebayWithoutReference.payments[0].externalPaymentId = "ebay-payment-historical-without-reference";
  ebayWithoutReference.lines[0].externalLineId = "ebay-line-historical-without-reference";
  const indistinguishableEbay = structuredClone(ebayWithoutReference);
  indistinguishableEbay.externalOrderId = "ebay-order-historical-indistinguishable";
  indistinguishableEbay.displayNumber = "26-12345-67891";
  indistinguishableEbay.payments[0].externalPaymentId = "ebay-payment-historical-indistinguishable";
  indistinguishableEbay.lines[0].externalLineId = "ebay-line-historical-indistinguishable";
  await orders.importOrders([ebayWithoutReference, indistinguishableEbay], {
    id: 1,
    requestId: "test-import-ebay-history-without-reference",
  });
  const ebayWithoutReferenceIds = (
    await database.getPool().query<{ id: string; external_order_id: string }>(
      `SELECT id, external_order_id FROM orders
         WHERE external_order_id IN ($1, $2) ORDER BY external_order_id`,
      [ebayWithoutReference.externalOrderId, indistinguishableEbay.externalOrderId],
    )
  ).rows;
  const ebayWithoutReferenceId = ebayWithoutReferenceIds.find(
    (order) => order.external_order_id === ebayWithoutReference.externalOrderId,
  )!.id;
  const indistinguishableEbayId = ebayWithoutReferenceIds.find(
    (order) => order.external_order_id === indistinguishableEbay.externalOrderId,
  )!.id;
  const ebayInvoiceWithoutReference = Buffer.from(
    (await readFile("tests/fixtures/fatturapa/accepted-invoice.anonymized.xml", "utf8"))
      .replace("FPR 0001/26", "FPR 0020/26")
      .replace("Vendita beni usati - Ordine Shopify #1001", "Vendita beni usati")
      .replace("<Data>2026-08-10</Data>", "<Data>2026-08-19</Data>")
      .replaceAll("123.45", "75.00"),
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      ebayWithoutReferenceId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba senza riferimento eBay ma con due ordini compatibili",
        invoiceXml: ebayInvoiceWithoutReference,
      },
      { id: 1, canApprove: true, requestId: "test-reconcile-ebay-history-ambiguous" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await orders.reconcileHistoricalOrder(
    indistinguishableEbayId,
    {
      outcome: "NOT_INVOICED",
      reference: "Ordine duplicato di prova escluso dopo verifica Aruba",
    },
    { id: 1, canApprove: true, requestId: "test-clear-indistinguishable-ebay-history" },
  );
  const indistinguishableShopify = structuredClone(ebayWithoutReference);
  indistinguishableShopify.provider = "SHOPIFY";
  indistinguishableShopify.externalAccountId = "shop.example.invalid";
  indistinguishableShopify.externalOrderId = "shop-order-historical-indistinguishable";
  indistinguishableShopify.externalCustomerId = "shop-customer-historical-indistinguishable";
  indistinguishableShopify.displayNumber = "#S-HIST-INDISTINGUISHABLE";
  indistinguishableShopify.updatedAt = "2026-08-18T09:15:00Z";
  indistinguishableShopify.payments[0].externalPaymentId =
    "shop-payment-historical-indistinguishable";
  indistinguishableShopify.lines[0].externalLineId = "shop-line-historical-indistinguishable";
  await orders.importOrders([indistinguishableShopify], {
    id: 1,
    requestId: "test-import-shopify-history-indistinguishable-from-ebay",
  });
  const indistinguishableShopifyId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        indistinguishableShopify.externalOrderId,
      ])
  ).rows[0]!.id;
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      ebayWithoutReferenceId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba senza riferimento ambiguo fra eBay e Shopify",
        invoiceXml: ebayInvoiceWithoutReference,
      },
      { id: 1, canApprove: true, requestId: "test-reconcile-cross-provider-ambiguous" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await orders.reconcileHistoricalOrder(
    indistinguishableShopifyId,
    {
      outcome: "NOT_INVOICED",
      reference: "Ordine Shopify di prova escluso dopo verifica Aruba",
    },
    { id: 1, canApprove: true, requestId: "test-clear-indistinguishable-shopify-history" },
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      ebayWithoutReferenceId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba senza riferimento eBay con destinatario diverso",
        invoiceXml: Buffer.from(
          ebayInvoiceWithoutReference
            .toString()
            .replace("<Nome>Mario</Nome>", "<Nome>Luigi</Nome>"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reconcile-ebay-history-wrong-recipient" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      ebayWithoutReferenceId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba senza riferimento eBay con importo diverso",
        invoiceXml: Buffer.from(
          ebayInvoiceWithoutReference.toString().replaceAll("75.00", "74.00"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reconcile-ebay-history-wrong-amount" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  const historicalPaymentInvoice = Buffer.from(
    ebayInvoiceWithoutReference
      .toString()
      .replace(
        "<ModalitaPagamento>MP08</ModalitaPagamento>",
        "<ModalitaPagamento>MP05</ModalitaPagamento>",
      ),
  );
  await orders.reconcileHistoricalOrder(
    ebayWithoutReferenceId,
    {
      outcome: "ALREADY_INVOICED",
      reference: "Documento Aruba univoco: nome, indirizzo, data e totale verificati",
      invoiceXml: historicalPaymentInvoice,
    },
    { id: 1, canApprove: true, requestId: "test-reconcile-ebay-history-without-reference" },
  );
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT count(*)::int AS count, min(documents.payment_method) AS payment_method
           FROM document_orders
           JOIN documents ON documents.id = document_orders.document_id
           WHERE document_orders.order_id = $1 AND documents.origin = 'ARUBA_HISTORY'`,
        [ebayWithoutReferenceId],
      )
    ).rows[0],
    { count: 1, payment_method: "MP05" },
  );
  const reorderedNameEbay = structuredClone(ebayWithoutReference);
  reorderedNameEbay.externalOrderId = "ebay-order-historical-reordered-name";
  reorderedNameEbay.externalCustomerId = "ebay-customer-historical-reordered-name";
  reorderedNameEbay.displayNumber = "26-12345-67894";
  reorderedNameEbay.customer.displayName = "Rossi Mario";
  reorderedNameEbay.customer.billingAddress.line1 = "Strada Provinciale 12 Campo Distante 99/B";
  reorderedNameEbay.customer.billingAddress.postalCode = "50100";
  reorderedNameEbay.customer.billingAddress.city = "Firenze";
  reorderedNameEbay.customer.billingAddress.province = "FI";
  reorderedNameEbay.total = "76.00";
  reorderedNameEbay.lines[0].grossAmount = "76.00";
  reorderedNameEbay.payments[0].amount = "76.00";
  reorderedNameEbay.payments[0].externalPaymentId = "ebay-payment-historical-reordered-name";
  reorderedNameEbay.lines[0].externalLineId = "ebay-line-historical-reordered-name";
  await orders.importOrders([reorderedNameEbay], {
    id: 1,
    requestId: "test-import-ebay-history-reordered-name",
  });
  const reorderedNameEbayId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        reorderedNameEbay.externalOrderId,
      ])
  ).rows[0]!.id;
  const reorderedNameInvoice = ebayInvoiceWithoutReference
    .toString()
    .replace("FPR 0020/26", "FPR 0022/26")
    .replaceAll("75.00", "76.00")
    .replace(
      "<ModalitaPagamento>MP08</ModalitaPagamento>",
      "<ModalitaPagamento>MP01</ModalitaPagamento>",
    );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      reorderedNameEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba con omonimo e sola provincia coincidente",
        invoiceXml: Buffer.from(
          reorderedNameInvoice
            .replace(
              "<Indirizzo>Via Cliente 2</Indirizzo>",
              "<Indirizzo>Via Giuseppe Distante 12 50100</Indirizzo>",
            )
            .replace("<CAP>00100</CAP>", "<CAP>50100</CAP>")
            .replace("<Comune>Roma</Comune>", "<Comune>Firenze</Comune>")
            .replace("<Provincia>RM</Provincia>", "<Provincia>FI</Provincia>"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-reordered-name-only" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      reorderedNameEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba con stessa via ma civico differente",
        invoiceXml: Buffer.from(
          reorderedNameInvoice
            .replace(
              "<Indirizzo>Via Cliente 2</Indirizzo>",
              "<Indirizzo>Strada Provinciale 12 Campo Distante 101</Indirizzo>",
            )
            .replace("<CAP>00100</CAP>", "<CAP>50100</CAP>")
            .replace("<Comune>Roma</Comune>", "<Comune>Firenze</Comune>")
            .replace("<Provincia>RM</Provincia>", "<Provincia>FI</Provincia>"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-conflicting-street-number" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      reorderedNameEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba con suffisso del civico differente",
        invoiceXml: Buffer.from(
          reorderedNameInvoice
            .replace(
              "<Indirizzo>Via Cliente 2</Indirizzo>",
              "<Indirizzo>Strada Provinciale 12 Campo Distante</Indirizzo><NumeroCivico>99/A</NumeroCivico>",
            )
            .replace("<CAP>00100</CAP>", "<CAP>50100</CAP>")
            .replace("<Comune>Roma</Comune>", "<Comune>Firenze</Comune>")
            .replace("<Provincia>RM</Provincia>", "<Provincia>FI</Provincia>"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-conflicting-street-number-suffix" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      reorderedNameEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba con solo civico e provincia coincidenti",
        invoiceXml: Buffer.from(
          reorderedNameInvoice
            .replace(
              "<Indirizzo>Via Cliente 2</Indirizzo>",
              "<Indirizzo>Via Completamente Diversa</Indirizzo><NumeroCivico>99/B</NumeroCivico>",
            )
            .replace("<CAP>00100</CAP>", "<CAP>59100</CAP>")
            .replace("<Comune>Roma</Comune>", "<Comune>Prato</Comune>")
            .replace("<Provincia>RM</Provincia>", "<Provincia>FI</Provincia>"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-street-number-and-province-only" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      reorderedNameEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba con stessa via e civico ma località differente",
        invoiceXml: Buffer.from(
          reorderedNameInvoice.replace(
            "<Indirizzo>Via Cliente 2</Indirizzo>",
            "<Indirizzo>Strada Provinciale 12 Campo Distante</Indirizzo><NumeroCivico>99/B</NumeroCivico>",
          ),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-street-with-different-locality" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      reorderedNameEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba con tipo di strada differente",
        invoiceXml: Buffer.from(
          reorderedNameInvoice
            .replace(
              "<Indirizzo>Via Cliente 2</Indirizzo>",
              "<Indirizzo>Via Provinciale 12 Campo Distante</Indirizzo><NumeroCivico>99/B</NumeroCivico>",
            )
            .replace("<CAP>00100</CAP>", "<CAP>50100</CAP>")
            .replace("<Comune>Roma</Comune>", "<Comune>Firenze</Comune>")
            .replace("<Provincia>RM</Provincia>", "<Provincia>FI</Provincia>"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-different-street-type" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      reorderedNameEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba con tipo di strada fuori allowlist differente",
        invoiceXml: Buffer.from(
          reorderedNameInvoice
            .replace(
              "<Indirizzo>Via Cliente 2</Indirizzo>",
              "<Indirizzo>Largo Provinciale 12 Campo Distante</Indirizzo><NumeroCivico>99/B</NumeroCivico>",
            )
            .replace("<CAP>00100</CAP>", "<CAP>50100</CAP>")
            .replace("<Comune>Roma</Comune>", "<Comune>Firenze</Comune>")
            .replace("<Provincia>RM</Provincia>", "<Provincia>FI</Provincia>"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-unlisted-street-type" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      reorderedNameEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba con solo tipo e una parola della strada coincidenti",
        invoiceXml: Buffer.from(
          reorderedNameInvoice
            .replace(
              "<Indirizzo>Via Cliente 2</Indirizzo>",
              "<Indirizzo>Strada Provinciale 12 Campo Differente</Indirizzo><NumeroCivico>99/B</NumeroCivico>",
            )
            .replace("<CAP>00100</CAP>", "<CAP>50100</CAP>")
            .replace("<Comune>Roma</Comune>", "<Comune>Firenze</Comune>")
            .replace("<Provincia>RM</Provincia>", "<Provincia>FI</Provincia>"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-partial-street-name" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      reorderedNameEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba con numero identificativo della strada differente",
        invoiceXml: Buffer.from(
          reorderedNameInvoice
            .replace(
              "<Indirizzo>Via Cliente 2</Indirizzo>",
              "<Indirizzo>Strada Provinciale 34 Campo Distante</Indirizzo><NumeroCivico>99/B</NumeroCivico>",
            )
            .replace("<CAP>00100</CAP>", "<CAP>50100</CAP>")
            .replace("<Comune>Roma</Comune>", "<Comune>Firenze</Comune>")
            .replace("<Provincia>RM</Provincia>", "<Provincia>FI</Provincia>"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-different-street-identifier" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      reorderedNameEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba con identità contenuta ma non uguale",
        invoiceXml: Buffer.from(
          reorderedNameInvoice
            .replace("<Nome>Mario</Nome>", "<Nome>Mario Bianchi</Nome>")
            .replace(
              "<Indirizzo>Via Cliente 2</Indirizzo>",
              "<Indirizzo>Strada Provinciale 12 Campo Distante</Indirizzo><NumeroCivico>99/B</NumeroCivico>",
            )
            .replace("<CAP>00100</CAP>", "<CAP>50100</CAP>")
            .replace("<Comune>Roma</Comune>", "<Comune>Firenze</Comune>")
            .replace("<Provincia>RM</Provincia>", "<Provincia>FI</Provincia>"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-contained-recipient-name" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      reorderedNameEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba con token della strada riordinati",
        invoiceXml: Buffer.from(
          reorderedNameInvoice
            .replace(
              "<Indirizzo>Via Cliente 2</Indirizzo>",
              "<Indirizzo>Strada Campo Provinciale 12 Distante</Indirizzo><NumeroCivico>99/B</NumeroCivico>",
            )
            .replace("<CAP>00100</CAP>", "<CAP>50100</CAP>")
            .replace("<Comune>Roma</Comune>", "<Comune>Firenze</Comune>")
            .replace("<Provincia>RM</Provincia>", "<Provincia>FI</Provincia>"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-reordered-street-name" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await orders.reconcileHistoricalOrder(
    reorderedNameEbayId,
    {
      outcome: "ALREADY_INVOICED",
      reference: "Documento Aruba univoco: token nome e località verificati",
      invoiceXml: Buffer.from(
        reorderedNameInvoice
          .replace(
            "<Indirizzo>Via Cliente 2</Indirizzo>",
            "<Indirizzo>Strada Provinciale 12 Campo Distante</Indirizzo><NumeroCivico>99/B</NumeroCivico>",
          )
          .replace("<CAP>00100</CAP>", "<CAP>50100</CAP>")
          .replace("<Comune>Roma</Comune>", "<Comune>Firenze</Comune>")
          .replace("<Provincia>RM</Provincia>", "<Provincia>FI</Provincia>"),
      ),
    },
    { id: 1, canApprove: true, requestId: "test-reconcile-ebay-history-reordered-name" },
  );
  assert.equal(
    (
      await database.getPool().query(
        `SELECT documents.payment_method
           FROM document_orders
           JOIN documents ON documents.id = document_orders.document_id
           WHERE document_orders.order_id = $1 AND documents.origin = 'ARUBA_HISTORY'`,
        [reorderedNameEbayId],
      )
    ).rows[0].payment_method,
    "MP01",
  );
  const manuallyReviewedEbay = structuredClone(ebayWithoutReference);
  manuallyReviewedEbay.externalOrderId = "ebay-order-historical-manual-review";
  manuallyReviewedEbay.externalCustomerId = "ebay-customer-historical-manual-review";
  manuallyReviewedEbay.displayNumber = "26-12345-67932";
  manuallyReviewedEbay.customer.displayName = "Mario Rossi";
  manuallyReviewedEbay.customer.taxIdentifiers = [
    {
      type: "CODICE_FISCALE",
      value: "RSSMRA80A01H501C",
      sourceField: "fixture.tax_identifier",
    },
  ];
  manuallyReviewedEbay.total = "86.00";
  manuallyReviewedEbay.lines[0].grossAmount = "86.00";
  manuallyReviewedEbay.payments[0].amount = "86.00";
  manuallyReviewedEbay.payments[0].externalPaymentId = "ebay-payment-historical-manual-review";
  manuallyReviewedEbay.lines[0].externalLineId = "ebay-line-historical-manual-review";
  await orders.importOrders([manuallyReviewedEbay], {
    id: 1,
    requestId: "test-import-ebay-history-manual-review",
  });
  const manuallyReviewedEbayId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        manuallyReviewedEbay.externalOrderId,
      ])
  ).rows[0]!.id;
  const manuallyReviewedInvoice = Buffer.from(
    ebayInvoiceWithoutReference
      .toString()
      .replace("FPR 0020/26", "FPR 0032/26")
      .replaceAll("75.00", "86.00")
      .replace("<Nome>Mario</Nome>", "<Nome>Mario Carlo</Nome>")
      .replace(
        "<Indirizzo>Via Cliente 2</Indirizzo>",
        "<Indirizzo>Via Cliente</Indirizzo><NumeroCivico>2</NumeroCivico>",
      ),
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      manuallyReviewedEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba FPR 0032/26 verificato manualmente",
        invoiceXml: manuallyReviewedInvoice,
      },
      { id: 1, canApprove: true, requestId: "test-reject-unapproved-manual-review" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      manuallyReviewedEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba FPR 0032/260 verificato manualmente",
        invoiceXml: manuallyReviewedInvoice,
        manualReviewApproved: true,
      },
      { id: 1, canApprove: true, requestId: "test-reject-unidentified-manual-invoice" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await orders.reconcileHistoricalOrder(
    manuallyReviewedEbayId,
    {
      outcome: "ALREADY_INVOICED",
      reference: "Documento Aruba FPR 0032/26 verificato manualmente",
      invoiceXml: manuallyReviewedInvoice,
      manualReviewApproved: true,
    },
    { id: 1, canApprove: true, requestId: "test-approve-manual-review" },
  );
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT orders.trigger_status, documents.origin,
                  audit_events.after_json ->> 'manualReviewApproved' AS manual_review_approved
           FROM orders
           JOIN document_orders ON document_orders.order_id = orders.id
             AND document_orders.document_kind = 'INVOICE'
           JOIN documents ON documents.id = document_orders.document_id
           JOIN audit_events ON audit_events.entity_type = 'ORDER'
             AND audit_events.entity_id = orders.id::text
             AND audit_events.action = 'ORDER_HISTORY_RECONCILED'
           WHERE orders.id = $1`,
        [manuallyReviewedEbayId],
      )
    ).rows[0],
    {
      trigger_status: "INVOICED",
      origin: "ARUBA_HISTORY",
      manual_review_approved: "true",
    },
  );
  const foreignPostalCodeEbay = structuredClone(ebayWithoutReference);
  foreignPostalCodeEbay.externalOrderId = "ebay-order-historical-foreign-postal-code";
  foreignPostalCodeEbay.externalCustomerId = "ebay-customer-historical-foreign-postal-code";
  foreignPostalCodeEbay.displayNumber = "26-12345-67933";
  foreignPostalCodeEbay.createdAt = "2026-07-28T19:48:00Z";
  foreignPostalCodeEbay.updatedAt = "2026-07-28T19:49:00Z";
  foreignPostalCodeEbay.customer.kind = "EU";
  foreignPostalCodeEbay.customer.displayName = "Răzvan-Mihail Dragoș";
  foreignPostalCodeEbay.customer.firstName = "Răzvan-Mihail";
  foreignPostalCodeEbay.customer.lastName = "Dragoș";
  foreignPostalCodeEbay.customer.taxIdentifiers = [];
  foreignPostalCodeEbay.customer.billingAddress = {
    line1: "Bvd. Ferdinand I, Nr. 60, Et. 2, Ap. 3",
    postalCode: "021383",
    city: "Bucuresti Sectorul 2",
    province: "Bucuresti",
    countryCode: "RO",
  };
  foreignPostalCodeEbay.total = "93.85";
  foreignPostalCodeEbay.lines[0].grossAmount = "93.85";
  foreignPostalCodeEbay.lines[0].externalLineId = "ebay-line-historical-foreign-postal-code";
  foreignPostalCodeEbay.payments[0].amount = "93.85";
  foreignPostalCodeEbay.payments[0].externalPaymentId =
    "ebay-payment-historical-foreign-postal-code";
  await orders.importOrders([foreignPostalCodeEbay], {
    id: 1,
    requestId: "test-import-ebay-history-foreign-postal-code",
  });
  const foreignPostalCodeEbayId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        foreignPostalCodeEbay.externalOrderId,
      ])
  ).rows[0]!.id;
  const foreignPostalCodeInvoice = Buffer.from(
    ebayInvoiceWithoutReference
      .toString()
      .replace("FPR 0020/26", "FPR 0033/26")
      .replace("<Data>2026-08-19</Data>", "<Data>2026-07-28</Data>")
      .replaceAll("75.00", "93.85")
      .replace(
        '<CessionarioCommittente xmlns="">\n      <DatiAnagrafici>\n        <CodiceFiscale>RSSMRA80A01H501U</CodiceFiscale>',
        '<CessionarioCommittente xmlns="">\n      <DatiAnagrafici>',
      )
      .replace("<Nome>Mario</Nome>", "<Nome>MIHAIL</Nome>")
      .replace("<Cognome>Rossi</Cognome>", "<Cognome>RAZVAN</Cognome>")
      .replace(
        "<Indirizzo>Via Cliente 2</Indirizzo>",
        "<Indirizzo>021383 BVD FERDNAND I 60</Indirizzo><NumeroCivico>60</NumeroCivico>",
      )
      .replace("<CAP>00100</CAP>", "<CAP>00000</CAP>")
      .replace("<Comune>Roma</Comune>", "<Comune>BUCARESTI</Comune>")
      .replace("<Provincia>RM</Provincia>\n        <Nazione>IT</Nazione>", "<Nazione>RO</Nazione>"),
  );
  await orders.reconcileHistoricalOrder(
    foreignPostalCodeEbayId,
    {
      outcome: "ALREADY_INVOICED",
      reference: "Documento Aruba FPR 0033/26 verificato manualmente",
      invoiceXml: foreignPostalCodeInvoice,
      manualReviewApproved: true,
    },
    { id: 1, canApprove: true, requestId: "test-approve-foreign-postal-code" },
  );
  assert.equal(
    (
      await database
        .getPool()
        .query("SELECT trigger_status FROM orders WHERE id = $1", [foreignPostalCodeEbayId])
    ).rows[0].trigger_status,
    "INVOICED",
  );
  const internalStreetKindEbay = structuredClone(ebayWithoutReference);
  internalStreetKindEbay.externalOrderId = "ebay-order-historical-internal-street-kind";
  internalStreetKindEbay.externalCustomerId = "ebay-customer-historical-internal-street-kind";
  internalStreetKindEbay.displayNumber = "26-12345-67896";
  internalStreetKindEbay.customer.billingAddress.line1 = "Via Piazza d'Armi 10";
  internalStreetKindEbay.total = "78.00";
  internalStreetKindEbay.lines[0].grossAmount = "78.00";
  internalStreetKindEbay.payments[0].amount = "78.00";
  internalStreetKindEbay.payments[0].externalPaymentId =
    "ebay-payment-historical-internal-street-kind";
  internalStreetKindEbay.lines[0].externalLineId = "ebay-line-historical-internal-street-kind";
  await orders.importOrders([internalStreetKindEbay], {
    id: 1,
    requestId: "test-import-ebay-history-internal-street-kind",
  });
  const internalStreetKindEbayId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        internalStreetKindEbay.externalOrderId,
      ])
  ).rows[0]!.id;
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      internalStreetKindEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba che omette un tipo di strada interno al nome",
        invoiceXml: Buffer.from(
          ebayInvoiceWithoutReference
            .toString()
            .replace("FPR 0020/26", "FPR 0024/26")
            .replaceAll("75.00", "78.00")
            .replace(
              "<Indirizzo>Via Cliente 2</Indirizzo>",
              "<Indirizzo>Via d'Armi</Indirizzo><NumeroCivico>10</NumeroCivico>",
            ),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-internal-street-kind" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  const reorderedBusinessEbay = structuredClone(ebayWithoutReference);
  reorderedBusinessEbay.externalOrderId = "ebay-order-historical-reordered-business";
  reorderedBusinessEbay.externalCustomerId = "ebay-customer-historical-reordered-business";
  reorderedBusinessEbay.displayNumber = "26-12345-67895";
  reorderedBusinessEbay.customer.kind = "BUSINESS_IT";
  reorderedBusinessEbay.customer.companyName = "Alfa Beta Srl";
  reorderedBusinessEbay.customer.displayName = "Alfa Beta Srl";
  reorderedBusinessEbay.customer.billingAddress.line1 = "Via Papa Pio X 10";
  reorderedBusinessEbay.total = "77.00";
  reorderedBusinessEbay.lines[0].grossAmount = "77.00";
  reorderedBusinessEbay.payments[0].amount = "77.00";
  reorderedBusinessEbay.payments[0].externalPaymentId =
    "ebay-payment-historical-reordered-business";
  reorderedBusinessEbay.lines[0].externalLineId = "ebay-line-historical-reordered-business";
  await orders.importOrders([reorderedBusinessEbay], {
    id: 1,
    requestId: "test-import-ebay-history-reordered-business",
  });
  const reorderedBusinessEbayId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        reorderedBusinessEbay.externalOrderId,
      ])
  ).rows[0]!.id;
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      reorderedBusinessEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba intestato al referente dell’azienda",
        invoiceXml: Buffer.from(
          ebayInvoiceWithoutReference
            .toString()
            .replace("FPR 0020/26", "FPR 0023/26")
            .replaceAll("75.00", "77.00")
            .replace(
              "<Indirizzo>Via Cliente 2</Indirizzo>",
              "<Indirizzo>Via Papa Pio X</Indirizzo><NumeroCivico>10</NumeroCivico>",
            ),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-business-contact-person" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      reorderedBusinessEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba con ragione sociale riordinata",
        invoiceXml: Buffer.from(
          ebayInvoiceWithoutReference
            .toString()
            .replace("FPR 0020/26", "FPR 0023/26")
            .replaceAll("75.00", "77.00")
            .replace(
              "<Nome>Mario</Nome>\n          <Cognome>Rossi</Cognome>",
              "<Denominazione>Beta Alfa Srl</Denominazione>",
            )
            .replace(
              "<Indirizzo>Via Cliente 2</Indirizzo>",
              "<Indirizzo>Via Papa Pio X</Indirizzo><NumeroCivico>10</NumeroCivico>",
            ),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-reordered-business-name" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      reorderedBusinessEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba personale con token della società riordinati",
        invoiceXml: Buffer.from(
          ebayInvoiceWithoutReference
            .toString()
            .replace("FPR 0020/26", "FPR 0023/26")
            .replaceAll("75.00", "77.00")
            .replace("<Nome>Mario</Nome>", "<Nome>Beta</Nome>")
            .replace("<Cognome>Rossi</Cognome>", "<Cognome>Alfa Srl</Cognome>")
            .replace(
              "<Indirizzo>Via Cliente 2</Indirizzo>",
              "<Indirizzo>Via Papa Pio X</Indirizzo><NumeroCivico>10</NumeroCivico>",
            ),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-business-as-person" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      reorderedBusinessEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba con numero romano alfabetico della strada differente",
        invoiceXml: Buffer.from(
          ebayInvoiceWithoutReference
            .toString()
            .replace("FPR 0020/26", "FPR 0023/26")
            .replaceAll("75.00", "77.00")
            .replace(
              "<Nome>Mario</Nome>\n          <Cognome>Rossi</Cognome>",
              "<Denominazione>Alfa Beta Srl</Denominazione>",
            )
            .replace(
              "<Indirizzo>Via Cliente 2</Indirizzo>",
              "<Indirizzo>Via Papa Pio V</Indirizzo><NumeroCivico>10</NumeroCivico>",
            ),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-short-street-token" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await orders.reconcileHistoricalOrder(
    reorderedBusinessEbayId,
    {
      outcome: "ALREADY_INVOICED",
      reference: "Documento Aruba con ragione sociale completa nello stesso ordine",
      invoiceXml: Buffer.from(
        ebayInvoiceWithoutReference
          .toString()
          .replace("FPR 0020/26", "FPR 0023/26")
          .replaceAll("75.00", "77.00")
          .replace(
            "<Nome>Mario</Nome>\n          <Cognome>Rossi</Cognome>",
            "<Denominazione>Alfa Beta Srl</Denominazione>",
          )
          .replace(
            "<Indirizzo>Via Cliente 2</Indirizzo>",
            "<Indirizzo>Via Papa Pio X</Indirizzo><NumeroCivico>10</NumeroCivico>",
          ),
      ),
    },
    { id: 1, canApprove: true, requestId: "test-reconcile-exact-business-name" },
  );
  const shortItalianStreetEbay = structuredClone(ebayWithoutReference);
  shortItalianStreetEbay.externalOrderId = "ebay-order-historical-short-italian-street";
  shortItalianStreetEbay.externalCustomerId = "ebay-customer-historical-short-italian-street";
  shortItalianStreetEbay.displayNumber = "26-12345-67901";
  shortItalianStreetEbay.customer.billingAddress = {
    line1: "Via San Luca 10",
    postalCode: "50100",
    city: "Firenze",
    province: "FI",
    countryCode: "IT",
  };
  shortItalianStreetEbay.total = "79.00";
  shortItalianStreetEbay.lines[0].grossAmount = "79.00";
  shortItalianStreetEbay.payments[0].amount = "79.00";
  shortItalianStreetEbay.payments[0].externalPaymentId =
    "ebay-payment-historical-short-italian-street";
  shortItalianStreetEbay.lines[0].externalLineId = "ebay-line-historical-short-italian-street";
  await orders.importOrders([shortItalianStreetEbay], {
    id: 1,
    requestId: "test-import-ebay-history-short-italian-street",
  });
  const shortItalianStreetEbayId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        shortItalianStreetEbay.externalOrderId,
      ])
  ).rows[0]!.id;
  const shortItalianStreetInvoice = Buffer.from(
    ebayInvoiceWithoutReference
      .toString()
      .replace("FPR 0020/26", "FPR 0025/26")
      .replaceAll("75.00", "79.00")
      .replace(
        "<Indirizzo>Via Cliente 2</Indirizzo>",
        "<Indirizzo>Via Santo Luca</Indirizzo><NumeroCivico>10</NumeroCivico>",
      )
      .replace("<CAP>00100</CAP>", "<CAP>50100</CAP>")
      .replace("<Comune>Roma</Comune>", "<Comune>Firenze</Comune>")
      .replace("<Provincia>RM</Provincia>", "<Provincia>FI</Provincia>"),
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      shortItalianStreetEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba con via breve ma civico differente",
        invoiceXml: Buffer.from(
          shortItalianStreetInvoice
            .toString()
            .replace("<NumeroCivico>10</NumeroCivico>", "<NumeroCivico>11</NumeroCivico>"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-short-italian-wrong-number" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      shortItalianStreetEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Due nomi propri diversi non sono la stessa via breve",
        invoiceXml: Buffer.from(
          shortItalianStreetInvoice.toString().replace("Via Santo Luca", "Via Mario Luca"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-different-short-street-name" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await orders.reconcileHistoricalOrder(
    shortItalianStreetEbayId,
    {
      outcome: "ALREADY_INVOICED",
      reference: "Documento Aruba univoco con via breve, civico, CAP e città coincidenti",
      invoiceXml: shortItalianStreetInvoice,
    },
    { id: 1, canApprove: true, requestId: "test-reconcile-short-italian-street" },
  );
  const numericToponymEbay = structuredClone(ebayWithoutReference);
  numericToponymEbay.externalOrderId = "ebay-order-historical-numeric-toponym";
  numericToponymEbay.externalCustomerId = "ebay-customer-historical-numeric-toponym";
  numericToponymEbay.displayNumber = "26-12345-67905";
  numericToponymEbay.customer.billingAddress = {
    line1: "Via 11 Settembre 10",
    postalCode: "50100",
    city: "Firenze",
    province: "FI",
    countryCode: "IT",
  };
  numericToponymEbay.total = "82.00";
  numericToponymEbay.lines[0].grossAmount = "82.00";
  numericToponymEbay.payments[0].amount = "82.00";
  numericToponymEbay.payments[0].externalPaymentId = "ebay-payment-historical-numeric-toponym";
  numericToponymEbay.lines[0].externalLineId = "ebay-line-historical-numeric-toponym";
  await orders.importOrders([numericToponymEbay], {
    id: 1,
    requestId: "test-import-ebay-history-numeric-toponym",
  });
  const numericToponymEbayId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        numericToponymEbay.externalOrderId,
      ])
  ).rows[0]!.id;
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      numericToponymEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Il numero nel toponimo non vale come civico",
        invoiceXml: Buffer.from(
          ebayInvoiceWithoutReference
            .toString()
            .replace("FPR 0020/26", "FPR 0028/26")
            .replaceAll("75.00", "82.00")
            .replace(
              "<Indirizzo>Via Cliente 2</Indirizzo>",
              "<Indirizzo>Via 11 Settembre 10</Indirizzo><NumeroCivico>11</NumeroCivico>",
            )
            .replace("<CAP>00100</CAP>", "<CAP>50100</CAP>")
            .replace("<Comune>Roma</Comune>", "<Comune>Firenze</Comune>")
            .replace("<Provincia>RM</Provincia>", "<Provincia>FI</Provincia>"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-numeric-toponym-as-civic" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      numericToponymEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Numeri distintivi diversi non identificano la stessa via breve",
        invoiceXml: Buffer.from(
          ebayInvoiceWithoutReference
            .toString()
            .replace("FPR 0020/26", "FPR 0028/26")
            .replaceAll("75.00", "82.00")
            .replace(
              "<Indirizzo>Via Cliente 2</Indirizzo>",
              "<Indirizzo>Via 12 Settembre</Indirizzo><NumeroCivico>10</NumeroCivico>",
            )
            .replace("<CAP>00100</CAP>", "<CAP>50100</CAP>")
            .replace("<Comune>Roma</Comune>", "<Comune>Firenze</Comune>")
            .replace("<Provincia>RM</Provincia>", "<Provincia>FI</Provincia>"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-different-numeric-toponym" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await orders.reconcileHistoricalOrder(
    numericToponymEbayId,
    {
      outcome: "NOT_INVOICED",
      reference: "Ordine sintetico escluso dopo il controllo del civico",
    },
    { id: 1, canApprove: true, requestId: "test-clear-numeric-toponym" },
  );
  const euPersonalEbay = structuredClone(ebayWithoutReference);
  euPersonalEbay.externalOrderId = "ebay-order-historical-eu-personal";
  euPersonalEbay.externalCustomerId = "ebay-customer-historical-eu-personal";
  euPersonalEbay.displayNumber = "26-12345-67902";
  euPersonalEbay.customer.kind = "EU";
  delete euPersonalEbay.customer.firstName;
  delete euPersonalEbay.customer.lastName;
  delete euPersonalEbay.customer.companyName;
  euPersonalEbay.customer.displayName = "Marie Claire Dupont";
  euPersonalEbay.customer.canonicalProfile = { displayName: "Marie Claire Dupont" };
  euPersonalEbay.customer.billingAddress = {
    line1: "12 Rue Martin des Fleurs du Lac",
    postalCode: "75000",
    city: "Paris",
    province: "EE",
    countryCode: "FR",
  };
  euPersonalEbay.total = "80.00";
  euPersonalEbay.lines[0].grossAmount = "80.00";
  euPersonalEbay.payments[0].amount = "80.00";
  euPersonalEbay.payments[0].externalPaymentId = "ebay-payment-historical-eu-personal";
  euPersonalEbay.lines[0].externalLineId = "ebay-line-historical-eu-personal";
  const duplicateEuPersonalEbay = structuredClone(euPersonalEbay);
  duplicateEuPersonalEbay.externalOrderId = "ebay-order-historical-eu-personal-duplicate";
  duplicateEuPersonalEbay.externalCustomerId = "ebay-customer-historical-eu-personal-duplicate";
  duplicateEuPersonalEbay.displayNumber = "26-12345-67903";
  duplicateEuPersonalEbay.updatedAt = "2026-08-18T09:50:00Z";
  duplicateEuPersonalEbay.payments[0].externalPaymentId =
    "ebay-payment-historical-eu-personal-duplicate";
  duplicateEuPersonalEbay.lines[0].externalLineId = "ebay-line-historical-eu-personal-duplicate";
  await orders.importOrders([euPersonalEbay, duplicateEuPersonalEbay], {
    id: 1,
    requestId: "test-import-ebay-history-eu-personal",
  });
  const euPersonalIds = (
    await database
      .getPool()
      .query<{ id: string; external_order_id: string }>(
        `SELECT id, external_order_id FROM orders WHERE external_order_id IN ($1, $2)`,
        [euPersonalEbay.externalOrderId, duplicateEuPersonalEbay.externalOrderId],
      )
  ).rows;
  const euPersonalEbayId = euPersonalIds.find(
    (order) => order.external_order_id === euPersonalEbay.externalOrderId,
  )!.id;
  const duplicateEuPersonalEbayId = euPersonalIds.find(
    (order) => order.external_order_id === duplicateEuPersonalEbay.externalOrderId,
  )!.id;
  const euPersonalInvoice = Buffer.from(
    ebayInvoiceWithoutReference
      .toString()
      .replace("FPR 0020/26", "FPR 0026/26")
      .replaceAll("75.00", "80.00")
      .replace("<Nome>Mario</Nome>", "<Nome>Claire Marie</Nome>")
      .replace("<Cognome>Rossi</Cognome>", "<Cognome>Dupont</Cognome>")
      .replace(
        "<Indirizzo>Via Cliente 2</Indirizzo>",
        "<Indirizzo>Avenue Martin des Fleurs du Lac</Indirizzo><NumeroCivico>12</NumeroCivico>",
      )
      .replace("<CAP>00100</CAP>", "<CAP>00000</CAP>")
      .replace("<Comune>Roma</Comune>", "<Comune>Lione</Comune>")
      .replace(
        "<Provincia>RM</Provincia>\n        <Nazione>IT</Nazione>",
        "<Provincia>EE</Provincia>\n        <Nazione>FR</Nazione>",
      ),
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      euPersonalEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba ambiguo fra due ordini UE equivalenti",
        invoiceXml: euPersonalInvoice,
      },
      { id: 1, canApprove: true, requestId: "test-reject-duplicate-eu-personal" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      euPersonalEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Il nome personale incompleto non identifica lo stesso destinatario",
        invoiceXml: Buffer.from(
          euPersonalInvoice.toString().replace("<Nome>Claire Marie</Nome>", "<Nome>Marie</Nome>"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-partial-eu-personal-name" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      euPersonalEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Il civico incorporato nell’indirizzo XML è discordante",
        invoiceXml: Buffer.from(
          euPersonalInvoice
            .toString()
            .replace(
              "Avenue Martin des Fleurs du Lac",
              "12 Avenue Martin des Fleurs du Lac 34 bis",
            ),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-conflicting-eu-embedded-civic" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await orders.reconcileHistoricalOrder(
    duplicateEuPersonalEbayId,
    {
      outcome: "NOT_INVOICED",
      reference: "Ordine duplicato sintetico escluso dopo il controllo di unicità",
    },
    { id: 1, canApprove: true, requestId: "test-clear-duplicate-eu-personal" },
  );
  const leadingCivicNumericToponymEbay = structuredClone(euPersonalEbay);
  leadingCivicNumericToponymEbay.externalOrderId =
    "ebay-order-historical-leading-civic-numeric-toponym";
  leadingCivicNumericToponymEbay.externalCustomerId =
    "ebay-customer-historical-leading-civic-numeric-toponym";
  leadingCivicNumericToponymEbay.displayNumber = "26-12345-67908";
  leadingCivicNumericToponymEbay.customer.billingAddress.line1 = "12 Rue Bataille 8 Mai 1945";
  leadingCivicNumericToponymEbay.total = "85.00";
  leadingCivicNumericToponymEbay.lines[0].grossAmount = "85.00";
  leadingCivicNumericToponymEbay.payments[0].amount = "85.00";
  leadingCivicNumericToponymEbay.payments[0].externalPaymentId =
    "ebay-payment-historical-leading-civic-numeric-toponym";
  leadingCivicNumericToponymEbay.lines[0].externalLineId =
    "ebay-line-historical-leading-civic-numeric-toponym";
  await orders.importOrders([leadingCivicNumericToponymEbay], {
    id: 1,
    requestId: "test-import-ebay-history-leading-civic-numeric-toponym",
  });
  const leadingCivicNumericToponymEbayId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        leadingCivicNumericToponymEbay.externalOrderId,
      ])
  ).rows[0]!.id;
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      leadingCivicNumericToponymEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Il numero finale del toponimo non sostituisce il civico iniziale",
        invoiceXml: Buffer.from(
          euPersonalInvoice
            .toString()
            .replace("FPR 0026/26", "FPR 0031/26")
            .replaceAll("80.00", "85.00")
            .replace("Avenue Martin des Fleurs du Lac", "Rue Bataille 8 Mai 1945")
            .replace("<NumeroCivico>12</NumeroCivico>", "<NumeroCivico>1945</NumeroCivico>"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-toponym-number-as-civic" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await orders.reconcileHistoricalOrder(
    leadingCivicNumericToponymEbayId,
    {
      outcome: "NOT_INVOICED",
      reference: "Ordine sintetico escluso dopo il controllo del civico iniziale",
    },
    { id: 1, canApprove: true, requestId: "test-clear-leading-civic-numeric-toponym" },
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      euPersonalEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "Documento Aruba UE con un solo token distintivo della strada",
        invoiceXml: Buffer.from(
          euPersonalInvoice
            .toString()
            .replace("Avenue Martin des Fleurs du Lac", "Avenue des Fleurs"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-eu-one-street-token" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      euPersonalEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "La contrazione francese non identifica la strada",
        invoiceXml: Buffer.from(
          euPersonalInvoice.toString().replace("Avenue Martin des Fleurs du Lac", "Avenue du Lac"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-french-du-connector" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      euPersonalEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "La contrazione apostrofata non identifica la strada",
        invoiceXml: Buffer.from(
          euPersonalInvoice
            .toString()
            .replace("Avenue Martin des Fleurs du Lac", "Avenue d'Alsace"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-french-d-connector" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      euPersonalEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "La contrazione francese plurale non identifica la strada",
        invoiceXml: Buffer.from(
          euPersonalInvoice
            .toString()
            .replace("Avenue Martin des Fleurs du Lac", "Avenue aux Fleurs"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-french-aux-connector" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await orders.reconcileHistoricalOrder(
    euPersonalEbayId,
    {
      outcome: "ALREADY_INVOICED",
      reference: "Documento Aruba UE univoco con nome personale completo e strada coerente",
      invoiceXml: euPersonalInvoice,
    },
    { id: 1, canApprove: true, requestId: "test-reconcile-eu-personal-complete" },
  );
  const euAddressWithUnitEbay = structuredClone(euPersonalEbay);
  euAddressWithUnitEbay.externalOrderId = "ebay-order-historical-eu-address-with-unit";
  euAddressWithUnitEbay.externalCustomerId = "ebay-customer-historical-eu-address-with-unit";
  euAddressWithUnitEbay.displayNumber = "26-12345-67906";
  euAddressWithUnitEbay.customer.displayName = "Ana Maria Popescu";
  euAddressWithUnitEbay.customer.canonicalProfile = { displayName: "Ana Maria Popescu" };
  euAddressWithUnitEbay.customer.billingAddress = {
    line1: "14 Strada Jardin Bleu apt B12",
    postalCode: "10000",
    city: "Bucarest",
    province: "EE",
    countryCode: "RO",
  };
  euAddressWithUnitEbay.total = "83.00";
  euAddressWithUnitEbay.lines[0].grossAmount = "83.00";
  euAddressWithUnitEbay.payments[0].amount = "83.00";
  euAddressWithUnitEbay.payments[0].externalPaymentId =
    "ebay-payment-historical-eu-address-with-unit";
  euAddressWithUnitEbay.lines[0].externalLineId = "ebay-line-historical-eu-address-with-unit";
  await orders.importOrders([euAddressWithUnitEbay], {
    id: 1,
    requestId: "test-import-ebay-history-eu-address-with-unit",
  });
  const euAddressWithUnitEbayId = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM orders WHERE external_order_id = $1", [
        euAddressWithUnitEbay.externalOrderId,
      ])
  ).rows[0]!.id;
  const euAddressWithUnitInvoice = Buffer.from(
    euPersonalInvoice
      .toString()
      .replace("FPR 0026/26", "FPR 0029/26")
      .replaceAll("80.00", "83.00")
      .replace("<Nome>Claire Marie</Nome>", "<Nome>Ana Maria</Nome>")
      .replace("<Cognome>Dupont</Cognome>", "<Cognome>Popescu</Cognome>")
      .replace("Avenue Martin des Fleurs du Lac", "Strada Jardin Bleu")
      .replace("<NumeroCivico>12</NumeroCivico>", "<NumeroCivico>14</NumeroCivico>")
      .replace("<Nazione>FR</Nazione>", "<Nazione>RO</Nazione>"),
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      euAddressWithUnitEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "I marcatori delle unità immobiliari non identificano la strada",
        invoiceXml: Buffer.from(
          euAddressWithUnitInvoice
            .toString()
            .replace("Strada Jardin Bleu", "Avenue Rouge Vert apt B12"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-unit-markers-as-street" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await assert.rejects(
    orders.reconcileHistoricalOrder(
      euAddressWithUnitEbayId,
      {
        outcome: "ALREADY_INVOICED",
        reference: "L’identificatore dell’appartamento non vale come civico",
        invoiceXml: Buffer.from(
          euAddressWithUnitInvoice
            .toString()
            .replace("<NumeroCivico>14</NumeroCivico>", "<NumeroCivico>12</NumeroCivico>"),
        ),
      },
      { id: 1, canApprove: true, requestId: "test-reject-unit-identifier-as-civic" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ORDER_HISTORY_INVOICE_INVALID",
  );
  await orders.reconcileHistoricalOrder(
    euAddressWithUnitEbayId,
    {
      outcome: "ALREADY_INVOICED",
      reference: "Documento Aruba UE univoco con unità immobiliare dopo il civico",
      invoiceXml: euAddressWithUnitInvoice,
    },
    { id: 1, canApprove: true, requestId: "test-reconcile-eu-address-with-unit" },
  );

  return { ebayWithoutReference, ebayInvoiceWithoutReference, euPersonalEbay, euPersonalInvoice };
}

export type HistoricalMatchingState = Awaited<ReturnType<typeof runHistoricalMatchingScenario>>;
