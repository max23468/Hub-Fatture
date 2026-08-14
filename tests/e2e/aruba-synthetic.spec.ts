import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import path from "node:path";

import {
  assertAccount,
  finalSendButton,
  removeUploads,
  validateVisibleDocuments,
  waitForUploadedDocument,
} from "../../scripts/aruba-helper.ts";
import {
  readVisiblePage,
  runArubaReadCycle,
  type ArubaReadManifest,
} from "../../scripts/aruba-read-helper.ts";

const xml = "tests/fixtures/fatturapa/accepted-invoice.anonymized.xml";

async function expectViewportFits(page: import("@playwright/test").Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

test("la pagina Aruba sintetica copre autenticazione, validazione e rimozione", async ({
  page,
}) => {
  await page.goto("/aruba-sintetica?scenario=login");
  await page.setViewportSize({ width: 320, height: 780 });
  await expect(page.locator('[data-aruba-state="login-required"]')).toContainText(
    "Completa manualmente password, OTP o CAPTCHA",
  );
  await expectViewportFits(page);
  await page.getByRole("button", { name: "Autenticazione completata" }).click();
  await expect(page.locator('[data-aruba-state="upload-ready"]')).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/aruba-sintetica?scenario=valid");
  await page.locator("[data-aruba-account]").evaluate((element) => {
    const nestedButton = document.createElement("button");
    nestedButton.setAttribute("aria-label", "synthetic-aruba-account");
    element.append(nestedButton);
  });
  await expect(assertAccount(page, "synthetic-aruba-account")).resolves.toBeUndefined();
  await page.locator("[data-aruba-account]").evaluate((element) => {
    element.setAttribute("hidden", "");
  });
  await page.evaluate(() => {
    const accountButton = document.createElement("button");
    accountButton.textContent = "synthetic-aruba-account";
    document.body.append(accountButton);
  });
  await expect(assertAccount(page, "synthetic-aruba-account")).resolves.toBeUndefined();
  await page
    .getByRole("button", { name: "synthetic-aruba-account", exact: true })
    .evaluate((element) => {
      element.textContent = "synthetic-aruba-account secondario";
    });
  await expect(assertAccount(page, "synthetic-aruba-account")).rejects.toThrow("DOM_UNRECOGNIZED");
  await page.reload();
  await page.getByLabel("SELEZIONA DOCUMENTI").setInputFiles(xml);
  await expect(
    waitForUploadedDocument(page, "accepted-invoice.anonymized.xml"),
  ).resolves.toBeUndefined();
  await expect(page.getByRole("cell", { name: "Documento valido" })).toBeVisible();
  for (const width of [1024, 600, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 780 : 800 });
    await expectViewportFits(page);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("button", { name: "INVIA TUTTE", exact: true })).toBeEnabled();
  await expect(finalSendButton(page, 1)).resolves.toBeTruthy();
  await expect(
    page.getByRole("button", { name: "SALVA IN BOZZE", exact: true }).first(),
  ).toBeDisabled();
  const visibleRow = page.locator("tbody tr").first();
  await visibleRow.evaluate((element) => {
    element.removeAttribute("data-fiscal-number");
    element.removeAttribute("data-document-date");
    element.removeAttribute("data-total-cents");
  });
  await visibleRow.evaluate((element) => {
    const hiddenClone = element.cloneNode(true) as HTMLElement;
    hiddenClone.hidden = true;
    element.parentElement!.append(hiddenClone);
  });
  const validDocument = {
    id: "1",
    filename: path.basename(xml),
    fiscalNumber: "FPR 0001/26",
    documentDate: "2026-08-10",
    totalAmount: 12345,
  };
  await expect(validateVisibleDocuments(page, { documents: [validDocument] })).resolves.toEqual([
    { id: "1", status: "VALID" },
  ]);
  await visibleRow.evaluate((element) => {
    element.parentElement!.append(element.cloneNode(true));
  });
  await expect(validateVisibleDocuments(page, { documents: [validDocument] })).rejects.toThrow(
    "DOM_UNRECOGNIZED",
  );
  await page
    .locator("tbody tr")
    .last()
    .evaluate((element) => element.remove());
  await expect(
    validateVisibleDocuments(page, {
      documents: [
        {
          id: "1",
          filename: path.basename(xml),
          fiscalNumber: "FPR 9999/99",
          documentDate: "2099-12-31",
          totalAmount: 1,
        },
      ],
    }),
  ).rejects.toThrow("DOM_UNRECOGNIZED");

  await page.goto("/aruba-sintetica?scenario=invalid");
  await page.getByLabel("SELEZIONA DOCUMENTI").setInputFiles(xml);
  await expect(page.getByRole("cell", { name: "Dettagli errori" })).toBeVisible();
  await expect(page.getByRole("button", { name: "INVIA TUTTE", exact: true })).toBeDisabled();
  await removeUploads(page, {
    documents: [{ filename: "accepted-invoice.anonymized.xml" }],
  });
  await expect(page.getByRole("row")).toHaveCount(0);
});

test("l’helper di lettura esegue full scan, incremento con overlap e download selettivo", async ({
  page,
  baseURL,
}) => {
  const token = "synthetic-device-0001." + "a".repeat(43);
  const pages: Array<{ fullScan: boolean; stream: string }> = [];
  const files: string[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.headers.authorization !== `Bearer ${token}`) return json(401, {});
    if (url.pathname === "/api/aruba/sync/heartbeat") return json(200, { ok: true });
    if (url.pathname === "/api/aruba/sync/pagine") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      pages.push({ fullScan: body.fullScan, stream: body.stream });
      return json(200, {
        requestedFiles:
          body.stream.startsWith("invoices:") && pages.length <= 2
            ? [{ remoteId: "SYNTH-INV-001", kind: "ARUBA_XML" }]
            : [],
      });
    }
    if (url.pathname.endsWith("/file")) {
      files.push(String(request.headers["x-aruba-file-kind"]));
      for await (const _ of request) void _;
      return json(200, { ok: true });
    }
    if (url.pathname === "/api/aruba/sync/completa") return json(200, { completed: true });
    return json(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server sintetico assente");
    const year = new Date().getUTCFullYear();
    const streams = [`invoices:${year}`, `credit-notes:${year}`].map((name) => ({
      name,
      cursor: `${name}:0`,
      overlapFrom: `${year}-08-01T00:00:00.000Z`,
      lastFullScanCompletedAt: null,
      resumePageOrdinal: null,
    }));
    const manifest: ArubaReadManifest = {
      operation: "READ_SYNC",
      sessionId: "00000000-0000-4000-8000-000000000001",
      environment: "MOCK",
      accountReference: "synthetic-aruba-account",
      accountIdentity: "synthetic-aruba-account",
      panelUrl: new URL("/aruba-sintetica?scenario=inventory", baseURL).toString(),
      oldestReconciliationDate: `${year}-01-01`,
      streams,
      intervalSeconds: 900,
      absoluteExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const hub = new URL(`http://127.0.0.1:${address.port}`);
    await page.goto(manifest.panelUrl);
    await page.locator("[data-aruba-filter-from]").fill(`${year - 1}-12-01`);
    await runArubaReadCycle(page, hub, token, manifest, 1, true);
    await expect(page.locator("[data-aruba-filter-from]")).toHaveValue("");
    await runArubaReadCycle(page, hub, token, manifest, 2, false);
    expect(pages).toEqual([
      { fullScan: true, stream: `invoices:${year}` },
      { fullScan: true, stream: `credit-notes:${year}` },
      { fullScan: false, stream: `invoices:${year}` },
      { fullScan: false, stream: `credit-notes:${year}` },
    ]);
    expect(files).toEqual(["ARUBA_XML"]);
    await expect(page.locator("[data-aruba-filter-from]")).toHaveValue(`${year}-08-01`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("l'helper gestisce in sicurezza una challenge post-upload inattesa", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto("/aruba-sintetica?scenario=security-challenge");
  await page.getByLabel("SELEZIONA DOCUMENTI").setInputFiles(xml);
  let heartbeats = 0;
  const upload = waitForUploadedDocument(page, "accepted-invoice.anonymized.xml", async () => {
    heartbeats += 1;
  });
  await expect(page.getByRole("dialog")).toContainText(
    "Vuoi disattivare la protezione OTP su Carica Fatture?",
  );
  await expectViewportFits(page);
  await page.getByRole("button", { name: "Prosegui" }).click();
  await page.getByLabel("Inserisci il codice ricevuto per SMS").fill("123456");
  await page.getByRole("button", { name: "Verifica" }).click();
  await expect(upload).resolves.toBeUndefined();
  expect(heartbeats).toBe(1);
  await expect(page.getByRole("cell", { name: "Documento valido" })).toBeVisible();
});

test("la pagina sintetica espone stream completi per l’inventario in sola lettura", async ({
  page,
}) => {
  await page.goto("/aruba-sintetica?scenario=inventory");
  await expect(page.locator('[data-aruba-state="inventory-ready"]')).toBeVisible();
  await expect(page.locator(".main-toolbar-info-user")).toHaveText("synthetic-aruba-account");
  const year = new Date().getUTCFullYear();
  await page.locator(`[data-aruba-stream="invoices:${year}"]`).click();
  const invoice = page.locator('tr[data-aruba-remote-id="SYNTH-INV-001"]');
  await expect(invoice).toHaveAttribute("data-document-type", "TD01");
  await expect(invoice).toHaveAttribute("data-remote-status", "DELIVERED");
  const productionInvoicePage = await readVisiblePage(page, `invoices:${year}`, 1, 1, "PRODUCTION");
  expect(productionInvoicePage.inventory.documents).toEqual([
    expect.objectContaining({
      remoteId: "SYNTH-INV-001",
      documentType: "TD01",
      fiscalNumber: "1",
      series: "FPR",
      documentDate: `${year}-08-10`,
      recipientTaxId: "RSSMRA80A01H501U",
      recipientAddress: "Via Cliente 1 00100 Roma IT",
      orderReferences: ["#1001"],
      totalAmount: 12345,
      status: "DELIVERED",
    }),
  ]);
  expect(productionInvoicePage.files).toEqual([
    { remoteId: "SYNTH-INV-001", kind: "ARUBA_XML", url: "/aruba-sintetica/file/invoice" },
  ]);
  await page.locator(`[data-aruba-stream="credit-notes:${year}"]`).click();
  const credit = page.locator('tr[data-aruba-remote-id="SYNTH-TD04-001"]');
  await expect(credit).toHaveAttribute("data-document-type", "TD04");
  await expect(credit).toHaveAttribute("data-remote-status", "SDI_PROCESSING");
  await expect(page.getByRole("button", { name: "Pagina successiva" })).toBeDisabled();
});

test("il lettore di produzione correla le due griglie ExtJS e filtra il flusso fiscale", async ({
  page,
}) => {
  const cells = (values: Record<number, string>, count: number) =>
    Array.from(
      { length: count },
      (_, index) => `<div class="x-gridcell">${values[index] ?? ""}</div>`,
    ).join("");
  const year = new Date().getUTCFullYear();
  await page.setContent(`
    <div class="aruba-grid-fatture-inviate">
      <section class="x-grid">
        <div class="x-gridrow" data-recordindex="0">${cells(
          {
            4: `10/08/${year}`,
            5: `FPR 1/${String(year).slice(-2)}`,
            7: "Cliente sintetico",
            8: "TD01",
            10: "123,45 €",
            17: "12345678901",
          },
          23,
        )}</div>
        <div class="x-gridrow" data-recordindex="1">${cells(
          {
            4: `11/08/${year}`,
            5: `FPR 2/${String(year).slice(-2)}`,
            7: "Cliente sintetico due",
            8: "TD04",
            10: "10,00 €",
            17: "12345678902",
          },
          23,
        )}</div>
      </section>
      <section class="x-grid locked-grid-border-left">
        <div class="x-gridrow" data-recordindex="0">${cells(
          {
            0: "Emessa e consegnata",
            1: '<div class="x-tool"><div class="aru-xml"></div></div>',
          },
          3,
        )}</div>
        <div class="x-gridrow" data-recordindex="1">${cells({ 0: "Inviata a SdI" }, 3)}</div>
      </section>
      <span class="x-disabled"><button aria-label="{app.buttons.labels.nextPage}" aria-disabled="true" disabled></button></span>
    </div>
  `);

  const result = await readVisiblePage(page, `invoices:${year}`, 1, 1, "PRODUCTION");
  expect(result.inventory.terminal).toBe(true);
  expect(result.inventory.documents).toEqual([
    expect.objectContaining({
      remoteId: "12345678901",
      documentType: "TD01",
      fiscalYear: year,
      series: "FPR",
      fiscalNumber: "1",
      totalAmount: 12345,
      status: "DELIVERED",
      orderReferences: [],
    }),
  ]);
  expect(result.files).toEqual([{ remoteId: "12345678901", kind: "ARUBA_XML", recordIndex: "0" }]);
});

test("la pagina sintetica espone gli stati inattesi e incerti", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto("/aruba-sintetica?scenario=unexpected");
  await expect(page.locator('[data-aruba-state="unexpected"]')).toBeVisible();
  await expectViewportFits(page);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/aruba-sintetica?scenario=uncertain");
  await page.getByLabel("SELEZIONA DOCUMENTI").setInputFiles(xml);
  await page.getByRole("button", { name: "INVIA TUTTE", exact: true }).click();
  await expect(page.getByText("Stato non disponibile", { exact: true })).toBeVisible();

  await page.goto("/aruba-sintetica?scenario=foreign");
  await page.getByLabel("SELEZIONA DOCUMENTI").setInputFiles(xml);
  await expect(
    validateVisibleDocuments(page, {
      documents: [
        {
          id: "1",
          filename: path.basename(xml),
          fiscalNumber: "FPR 9999/99",
          documentDate: "2099-12-31",
          totalAmount: 1,
        },
      ],
    }),
  ).rejects.toThrow("DOM_UNRECOGNIZED");
});
