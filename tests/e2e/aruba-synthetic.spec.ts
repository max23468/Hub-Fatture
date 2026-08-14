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
  advanceProductionPage,
  readVisiblePage,
  runArubaReadCycle,
  selectStream,
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

test("il lettore Production accetta un anno vuoto e ripercorre l’anno nel ciclo incrementale", async ({
  page,
}) => {
  const year = new Date().getUTCFullYear();
  await page.route("https://aruba-synthetic.invalid/**", (route) =>
    route.fulfill({
      contentType: route.request().url().endsWith("/reload") ? "application/json" : "text/html",
      body: route.request().url().endsWith("/reload") ? "{}" : "<html></html>",
    }),
  );
  await page.goto("https://aruba-synthetic.invalid/base");
  await page.setContent(`
    <div class="main-toolbar-info-fiscalyear">Anno: ${year}<button>Anno</button></div>
    <button class="x-menuitem-sub-menu-mainToolbar">${year}</button>
    <li role="menuitem">Fatture inviate</li>
    <div class="aruba-grid-fatture-inviate">
      <span class="x-disabled"><button aria-label="{app.buttons.labels.nextPage}" aria-disabled="true" disabled></button></span>
    </div>
    <script>
      document.querySelector('[role="menuitem"]').addEventListener('click', () => {
        const grid = document.querySelector('.aruba-grid-fatture-inviate');
        fetch('/reload').then(() => grid.setAttribute('data-reloaded', 'true'));
      });
    </script>
  `);

  await selectStream(page, `invoices:${year}`, `${year}-01-01T00:00:00.000Z`);
  const result = await readVisiblePage(page, `invoices:${year}`, 2, 1, "PRODUCTION");
  expect(result.inventory.documents).toEqual([]);
  expect(result.inventory.terminal).toBe(true);
});

test("il lettore Production attende il reload ExtJS prima di leggere il nuovo stream", async ({
  page,
}) => {
  const year = new Date().getUTCFullYear();
  await page.route("https://aruba-synthetic.invalid/**", async (route) => {
    if (route.request().url().endsWith("/poll")) {
      await route.fulfill({ contentType: "application/json", body: "{}" });
      return;
    }
    if (route.request().url().endsWith("/reload")) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      await route.fulfill({ contentType: "application/json", body: "{}" });
      return;
    }
    await route.fulfill({ contentType: "text/html", body: "<html></html>" });
  });
  await page.goto("https://aruba-synthetic.invalid/base");
  const row = (remoteId: string) => `
    <section class="x-grid">
      <div class="x-gridrow" data-recordindex="0">
        ${Array.from({ length: 23 }, (_, index) => {
          const value =
            index === 4
              ? `10/08/${year}`
              : index === 5
                ? `FPR 1/${String(year).slice(-2)}`
                : index === 7
                  ? "Cliente sintetico"
                  : index === 8
                    ? "TD01"
                    : index === 10
                      ? "123,45 €"
                      : index === 17
                        ? remoteId
                        : "";
          return `<div class="x-gridcell">${value}</div>`;
        }).join("")}
      </div>
    </section>
    <section class="x-grid locked-grid-border-left">
      <div class="x-gridrow" data-recordindex="0">
        <div class="x-gridcell">Emessa e consegnata</div><div class="x-gridcell"></div>
      </div>
    </section>
    <span class="x-disabled" title="{app.buttons.labels.nextPage}"><button aria-disabled="true" disabled></button></span>`;
  await page.setContent(`
    <div class="main-toolbar-info-fiscalyear">Anno: ${year}<button>Anno</button></div>
    <button class="x-menuitem-sub-menu-mainToolbar">${year}</button>
    <li role="menuitem">Fatture inviate</li>
    <div class="aruba-grid-fatture-inviate">${row("99999999999")}</div>
  `);
  await page.getByRole("menuitem", { name: "Fatture inviate" }).evaluate((element, replacement) => {
    element.addEventListener("click", () => {
      const grid = document.querySelector(".aruba-grid-fatture-inviate")!;
      grid.innerHTML =
        '<span class="x-disabled" title="{app.buttons.labels.nextPage}"><button aria-disabled="true" disabled></button></span>';
      fetch("/poll");
      fetch("/reload").then(() => {
        grid.innerHTML = replacement;
      });
    });
  }, row("11111111111"));

  await selectStream(page, `invoices:${year}`);
  const result = await readVisiblePage(page, `invoices:${year}`, 1, 1, "PRODUCTION");
  expect(result.inventory.documents.map((document) => document.remoteId)).toEqual(["11111111111"]);
});

test("il lettore Production rifiuta una risposta dati HTTP fallita anche con traffico estraneo", async ({
  page,
}) => {
  const year = new Date().getUTCFullYear();
  await page.route("https://aruba-synthetic.invalid/**", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );
  await page.route("https://traffic.invalid/**", (route) =>
    route.fulfill({ contentType: "application/json", body: "{}" }),
  );
  await page.goto("https://aruba-synthetic.invalid/base");
  await page.setContent(`
    <div class="main-toolbar-info-fiscalyear">Anno: ${year}<button>Anno</button></div>
    <button class="x-menuitem-sub-menu-mainToolbar">${year}</button>
    <li role="menuitem">Fatture inviate</li>
    <div class="aruba-grid-fatture-inviate">
      <span class="x-disabled"><button aria-label="{app.buttons.labels.nextPage}" disabled></button></span>
    </div>
    <script>
      document.querySelector('[role="menuitem"]').addEventListener('click', () => {
        fetch('https://traffic.invalid/pulse', { mode: 'no-cors' });
        fetch('/reload').then(() => {
          document.querySelector('.aruba-grid-fatture-inviate').setAttribute('data-reloaded', 'true');
        });
      });
    </script>
  `);

  await expect(selectStream(page, `invoices:${year}`)).rejects.toThrow("DOM_UNRECOGNIZED");
});

test("il lettore Production rifiuta una richiesta dati interrotta", async ({ page }) => {
  const year = new Date().getUTCFullYear();
  await page.route("https://aruba-synthetic.invalid/**", (route) =>
    route.request().url().endsWith("/reload")
      ? route.abort()
      : route.fulfill({ contentType: "text/html", body: "<html></html>" }),
  );
  await page.goto("https://aruba-synthetic.invalid/base");
  await page.setContent(`
    <div class="main-toolbar-info-fiscalyear">Anno: ${year}<button>Anno</button></div>
    <button class="x-menuitem-sub-menu-mainToolbar">${year}</button>
    <li role="menuitem">Fatture inviate</li>
    <div class="aruba-grid-fatture-inviate">
      <span class="x-disabled"><button aria-label="{app.buttons.labels.nextPage}" disabled></button></span>
    </div>
    <script>
      document.querySelector('[role="menuitem"]').addEventListener('click', () => {
        fetch('/reload').catch(() => {
          document.querySelector('.aruba-grid-fatture-inviate').setAttribute('data-reloaded', 'true');
        });
      });
    </script>
  `);

  await expect(selectStream(page, `invoices:${year}`)).rejects.toThrow("DOM_UNRECOGNIZED");
});

test("il lettore Production attende la stabilizzazione completa della pagina successiva", async ({
  page,
}) => {
  const row = (recordIndex: number, remoteId: string) => `
    <div class="x-gridrow" data-recordindex="${recordIndex}">
      ${Array.from({ length: 23 }, (_, index) => `<div class="x-gridcell">${index === 17 ? remoteId : ""}</div>`).join("")}
    </div>`;
  await page.route("https://aruba-synthetic.invalid/**", async (route) => {
    if (route.request().url().endsWith("/next")) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await route.fulfill({ contentType: "application/json", body: "{}" });
      return;
    }
    await route.fulfill({ contentType: "text/html", body: "<html></html>" });
  });
  await page.goto("https://aruba-synthetic.invalid/base");
  await page.setContent(`
    <div class="aruba-grid-fatture-inviate">
      <section class="x-grid">${row(0, "10000000001")}</section>
      <button aria-label="{app.buttons.labels.nextPage}"></button>
    </div>
  `);
  await page.locator('button[aria-label*="nextPage"]').evaluate(
    (button, rows) => {
      button.addEventListener("click", () => {
        fetch("/next").then(() => {
          const grid = document.querySelector(".aruba-grid-fatture-inviate")!;
          grid.querySelector(".x-grid")!.innerHTML = rows[0]!;
          setTimeout(() => {
            grid.querySelector(".x-grid")!.insertAdjacentHTML("beforeend", rows[1]!);
            button.setAttribute("disabled", "");
          }, 300);
        });
      });
    },
    [row(0, "20000000001"), row(1, "20000000002")],
  );

  await advanceProductionPage(page);
  await expect(page.locator(".x-gridrow")).toHaveCount(2);
  await expect(page.locator(".x-gridrow").nth(1)).toContainText("20000000002");
});

test("il lettore Production completa il reload dell’anno prima di aprire lo stream", async ({
  page,
}) => {
  const targetYear = new Date().getUTCFullYear() - 1;
  await page.route("https://aruba-synthetic.invalid/**", async (route) => {
    if (route.request().url().endsWith("/year")) {
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    await route.fulfill({
      contentType: route.request().url().endsWith("/base") ? "text/html" : "application/json",
      body: route.request().url().endsWith("/base") ? "<html></html>" : "{}",
    });
  });
  await page.goto("https://aruba-synthetic.invalid/base");
  await page.setContent(`
    <div class="main-toolbar-info-fiscalyear">Anno: ${targetYear + 1}<button>Anno</button></div>
    <button class="x-menuitem-sub-menu-mainToolbar">${targetYear}</button>
    <li role="menuitem">Fatture inviate</li>
    <div class="aruba-grid-fatture-inviate">
      <span class="x-disabled"><button aria-label="{app.buttons.labels.nextPage}" disabled></button></span>
    </div>
    <script>
      document.querySelector('.x-menuitem-sub-menu-mainToolbar').addEventListener('click', () => {
        fetch('/year').then(() => {
          document.querySelector('.main-toolbar-info-fiscalyear').firstChild.textContent = 'Anno: ${targetYear}';
          document.querySelector('.aruba-grid-fatture-inviate').setAttribute('data-year', '${targetYear}');
        });
      });
      document.querySelector('[role="menuitem"]').addEventListener('click', () => {
        const grid = document.querySelector('.aruba-grid-fatture-inviate');
        fetch('/reload').then(() => grid.setAttribute('data-stream-year', grid.getAttribute('data-year') || 'stale'));
      });
    </script>
  `);

  await selectStream(page, `invoices:${targetYear}`);
  await expect(page.locator(".aruba-grid-fatture-inviate")).toHaveAttribute(
    "data-stream-year",
    String(targetYear),
  );
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
