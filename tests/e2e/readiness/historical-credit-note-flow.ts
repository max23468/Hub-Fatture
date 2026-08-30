import { expect, type Page } from "@playwright/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { appBaseUrl, databaseUrl, expectViewportFits, storageRoot } from "./support.ts";

export async function verifyHistoricalAndCreditNoteFlow(page: Page) {
  process.env.APP_ENV = "test";
  process.env.APP_BASE_URL = appBaseUrl;
  process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
  process.env.DATABASE_URL = databaseUrl;
  process.env.DOCUMENT_STORAGE_ROOT = storageRoot;
  process.env.SMTP_TRANSPORT = "SYNTHETIC";
  const database = await import("../../../src/db/client.server.ts");
  const aruba = await import("../../../src/db/aruba.server.ts");
  const documentStorage = await import("../../../src/db/document-storage.server.ts");
  const refunds = await import("../../../src/db/refunds.server.ts");
  const email = await import("../../../src/db/email.server.ts");
  const jobs = await import("../../../src/db/connector-jobs.server.ts");
  const orders = await import("../../../src/db/order-import.server.ts");
  const actorRow = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM users WHERE username = 'Massimo'")
  ).rows[0]!;
  const actor = {
    id: Number(actorRow.id),
    canApprove: true,
    requestId: "m6-e2e-synthetic",
  };
  const historicalFixture = JSON.parse(
    await readFile("tests/fixtures/orders/normalized.mock.json", "utf8"),
  )[0];
  historicalFixture.externalOrderId = "release-candidate-history";
  historicalFixture.displayNumber = "#RC-HISTORY";
  historicalFixture.externalCustomerId = "release-candidate-customer";
  historicalFixture.customer.taxIdentifiers[0].value = "RSSMRA80A01H501U";
  historicalFixture.historical = true;
  await orders.importOrders([historicalFixture], {
    id: actor.id,
    requestId: "release-candidate-history",
  });
  await page.goto("/ordini");
  await expect(page.getByRole("heading", { name: "Ordini", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Shopify #RC-HISTORY", exact: true }).click();
  const historicalInvoiceInput = page.getByLabel(
    "XML ufficiale della fattura Aruba, se già presente",
  );
  await expect(historicalInvoiceInput).not.toHaveAttribute("required", "");
  await page.getByLabel("Esito del confronto").selectOption("ALREADY_INVOICED");
  await expect(historicalInvoiceInput).toHaveAttribute("required", "");
  await expect(
    page.getByLabel(
      "Autorizzo l’eccezione manuale dopo aver verificato identità, indirizzo, data, totale e unicità del documento.",
    ),
  ).not.toBeChecked();
  await page
    .getByLabel("Riferimento verificato o motivazione")
    .fill("Documento Aruba FPR 9010/26 verificato");
  await historicalInvoiceInput.setInputFiles({
    name: "fattura-storica.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(
      (await readFile("tests/fixtures/fatturapa/accepted-invoice.anonymized.xml", "utf8"))
        .replace("FPR 0001/26", "FPR 9010/26")
        .replace("#1001", "#RC-HISTORY")
        .replaceAll("123.45", "122.00"),
    ),
  });
  await page.getByRole("button", { name: "Registra la riconciliazione" }).click();
  await expect(page.getByText("Storico riconciliato")).toBeVisible();
  await expect(page.getByText("Fatturato", { exact: true })).toBeVisible();
  const invoice = (
    await database.getPool().query<{
      id: string;
      order_id: string;
      filename: string;
    }>(
      `SELECT documents.id, document_orders.order_id, batch_documents.filename
       FROM documents
       JOIN document_orders ON document_orders.document_id = documents.id
         AND document_orders.document_kind = 'INVOICE'
       JOIN LATERAL (
         SELECT aruba_batch_documents.filename
         FROM aruba_batch_documents
         JOIN aruba_batches ON aruba_batches.id = aruba_batch_documents.batch_id
         WHERE aruba_batch_documents.document_id = documents.id
         ORDER BY aruba_batches.created_at DESC LIMIT 1
       ) AS batch_documents ON true
       WHERE documents.kind = 'INVOICE' AND documents.status = 'APPROVED'
         AND documents.origin = 'HUB'
       ORDER BY documents.approved_at DESC LIMIT 1`,
    )
  ).rows[0]!;
  const officialPdf = Buffer.from(
    await readFile("tests/fixtures/aruba/official-pdf.synthetic.base64", "utf8"),
    "base64",
  );
  const deliveredNotification = await readFile(
    "tests/fixtures/aruba/notification-delivered.synthetic.xml",
    "utf8",
  );
  await aruba.importOfficialArubaFile(
    invoice.id,
    "ARUBA_XML",
    (await documentStorage.readDocumentXml(invoice.id))!,
    actor,
  );
  await aruba.importOfficialArubaFile(invoice.id, "ARUBA_PDF", officialPdf, actor);
  await aruba.importOfficialArubaFile(
    invoice.id,
    "SDI_NOTIFICATION",
    Buffer.from(deliveredNotification.replace("SYNTHETIC-DOCUMENT.xml", invoice.filename)),
    actor,
  );

  const refundId = (
    await database.getPool().query<{ id: string }>(
      `INSERT INTO refunds
        (provider, external_account_id, external_order_id, external_refund_id,
         order_id, status, amount, completed_at, raw_json)
       SELECT orders.provider, orders.external_account_id, orders.external_order_id,
              'm6-e2e-refund', orders.id, 'COMPLETED', 500, now(), '{}'
       FROM orders WHERE orders.id = $1 RETURNING id`,
      [invoice.order_id],
    )
  ).rows[0]!.id;
  await database.getPool().query(
    `UPDATE settings SET value_json = '"DOCUMENT_ONLY"'::jsonb, version = version + 1
     WHERE key = 'aruba_mode'`,
  );
  const noteId = await refunds.processRefund(refundId);
  expect(noteId).toBeTruthy();
  await page.goto("/documenti?vista=note-credito");
  await expect(page).toHaveURL(/\/documenti\?vista=note-credito$/);
  const creditNoteLink = page.locator(`a[href="/documenti/${noteId}/nota"]`).first();
  await expect(creditNoteLink).toHaveAttribute("href", `/documenti/${noteId}/nota`);
  await creditNoteLink.click();
  await expect(page.getByRole("heading", { name: "Comparatore fiscale" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Righe" })).toContainText("rimborso m6-e2e-refund");
  await expect(page.getByRole("table", { name: "Righe" })).toContainText("N5");
  await expect(page.getByRole("table", { name: "Fattura originaria" })).toContainText(
    "DatiFattureCollegate",
  );
  await expect(page.getByText("PDF ufficiale Aruba, dopo l’esito SdI")).toBeVisible();
  for (const width of [1280, 900, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 780 : 800 });
    await expectViewportFits(page);
    await expect(page.locator(".comparison-table").first()).toBeVisible();
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page
    .getByLabel(/Confermo rimborsi, riferimenti alla fattura, totale e numerazione irreversibile/)
    .check();
  await page.getByRole("button", { name: "Approva, numera e prepara per Aruba" }).click();
  await expect(page).toHaveURL(/\/documenti$/, { timeout: 60_000 });

  const note = (
    await database.getPool().query<{
      filename: string;
      batch_id: string;
      mode: string;
      transport: string;
      status: string;
    }>(
      `SELECT batch_documents.filename, batch_documents.batch_id,
              batches.mode, batches.transport, batches.status
       FROM aruba_batch_documents AS batch_documents
       JOIN aruba_batches AS batches ON batches.id = batch_documents.batch_id
       WHERE batch_documents.document_id = $1
       ORDER BY batches.created_at DESC LIMIT 1`,
      [noteId],
    )
  ).rows[0]!;
  expect(note).toMatchObject({
    mode: "DOCUMENT_ONLY",
    transport: "API",
    status: "DOCUMENT_ONLY",
  });
  await aruba.importOfficialArubaFile(
    noteId!,
    "ARUBA_XML",
    (await documentStorage.readDocumentXml(noteId!))!,
    actor,
  );
  await aruba.importOfficialArubaFile(noteId!, "ARUBA_PDF", officialPdf, actor);
  await aruba.importOfficialArubaFile(
    noteId!,
    "SDI_NOTIFICATION",
    Buffer.from(deliveredNotification.replace("SYNTHETIC-DOCUMENT.xml", note.filename)),
    actor,
  );
  for (;;) {
    const job = await jobs.claimJob("m6-e2e-email");
    if (!job) break;
    expect(job.type).toBe("send_customer_email");
    await email.sendCustomerEmail(job);
    expect(await jobs.completeJob(job)).toBe(true);
  }
  assert.equal(
    (
      await database
        .getPool()
        .query(
          "SELECT status FROM email_deliveries WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1",
          [noteId],
        )
    ).rows[0].status,
    "SENT",
  );
  assert.equal(
    (await database.getPool().query("SELECT status FROM documents WHERE id = $1", [noteId])).rows[0]
      .status,
    "APPROVED",
  );
  await page.reload();
  await expect(
    page.locator(".document-row").filter({
      has: page.locator(`a[href='/documenti/${noteId}/nota']`),
    }),
  ).toContainText("Inviata");
}
